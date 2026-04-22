/**
 * Local data server for the Starkeep admin desktop app.
 * Exposes the SDK over HTTP with owner-level access so the admin
 * browses data through proper access control, not by reading the DB directly.
 */

import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { SqliteDatabaseAdapter } from "../../packages/storage-sqlite/src/adapter.js";
import { FsObjectStorageAdapter } from "../../packages/storage-fs/src/adapter.js";
import { S3ObjectStorageAdapter } from "../../packages/storage-s3/src/adapter.js";
import { AuroraDsqlDatabaseAdapter } from "../../packages/storage-aurora-dsql/src/adapter.js";
import type { ObjectStorageAdapter } from "../../packages/storage-adapter/src/object-storage/adapter.js";
import type { DatabaseAdapter } from "../../packages/storage-adapter/src/database/adapter.js";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "../../packages/storage-aurora-dsql/src/types.js";
import { createStarkeepSdk } from "../../packages/sdk/src/sdk.js";
import {
  createHttpSyncTransport,
  createSqliteChangeLog,
  createSqliteSyncStateStore,
} from "../../packages/sync-engine/src/index.js";
import { createTypeRegistry } from "../../packages/core/src/schema/index.js";
import { createHLCClock } from "../../packages/core/src/hlc/index.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { stat as fsStat, readFile } from "node:fs/promises";
import { createFileWatchManager, type FileWatchManager } from "./watcher.js";
import { HttpObjectStorageAdapter } from "./http-object-storage.js";
import * as v from "valibot";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";

// Signing key for self-hosted file tokens — regenerated each startup so
// all outstanding tokens are invalidated on restart (revocable by design).
const TOKEN_SECRET = randomBytes(32);

const STARKEEP_DIR = process.env.STARKEEP_DIR || join(homedir(), ".starkeep");
const PORT = parseInt(process.env.STARKEEP_PORT || "9820", 10);
const OWNER_ID = process.env.STARKEEP_OWNER_ID || "craig";
const CLOUD_URL = process.env.STARKEEP_CLOUD_URL;
const NODE_ID = process.env.STARKEEP_NODE_ID || "admin-desktop";
const PULL_INTERVAL_MS = parseInt(process.env.STARKEEP_PULL_INTERVAL_MS || "30000", 10);
const PUSH_DEBOUNCE_MS = parseInt(process.env.STARKEEP_PUSH_DEBOUNCE_MS || "500", 10);

interface CloudConfig {
  stackPrefix: string;
  s3Bucket: string;
  s3Region: string;
  auroraEndpoint: string;
}

interface CloudCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface LoadedCloudConfig {
  config: CloudConfig;
  credentials: CloudCredentials;
}

async function loadCloudConfig(): Promise<LoadedCloudConfig | null> {
  try {
    const config = JSON.parse(
      await readFile(join(STARKEEP_DIR, "cloud-config.json"), "utf8"),
    ) as CloudConfig;
    const credentials = JSON.parse(
      await readFile(join(STARKEEP_DIR, "cloud-credentials.json"), "utf8"),
    ) as CloudCredentials;
    return { config, credentials };
  } catch {
    return null;
  }
}

/**
 * Reads STS credentials from ~/.starkeep/cloud-credentials.json on every call
 * so that credentials rotated by admin-desktop are always picked up without
 * restarting the data server.
 */
async function makeCloudCredentialProvider(): Promise<() => Promise<CloudCredentials>> {
  const credentialsPath = join(STARKEEP_DIR, "cloud-credentials.json");
  return async () => {
    return JSON.parse(await readFile(credentialsPath, "utf8")) as CloudCredentials;
  };
}

/**
 * Aurora DSQL client factory that reads STS credentials from the cloud
 * credentials file on each reconnect so rotating tokens are always fresh.
 */
class CloudCredentialsDsqlClientFactory implements DatabaseClientFactory {
  private readonly credentialsPath: string;

  constructor() {
    this.credentialsPath = join(STARKEEP_DIR, "cloud-credentials.json");
  }

  async createClient(
    options: AuroraDsqlDatabaseAdapterOptions,
  ): Promise<DatabaseClient> {
    const createPgClient = async (): Promise<pg.Client> => {
      const rawCreds = JSON.parse(
        await readFile(this.credentialsPath, "utf8"),
      ) as CloudCredentials;
      const signer = new DsqlSigner({
        hostname: options.hostname,
        region: options.region,
        credentials: {
          accessKeyId: rawCreds.accessKeyId,
          secretAccessKey: rawCreds.secretAccessKey,
          sessionToken: rawCreds.sessionToken,
        },
      });
      const token = await signer.getDbConnectAdminAuthToken();
      const client = new pg.Client({
        host: options.hostname,
        port: 5432,
        database: options.database ?? "postgres",
        user: "admin",
        password: token,
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      return client;
    };

    let inner = await createPgClient();

    return {
      async query(text, values) {
        try {
          const result = await inner.query(text, values);
          return { rows: result.rows };
        } catch (err: unknown) {
          // IAM auth token expired (~15 min) — reconnect with fresh token and retry once
          const code = (err as { code?: string })?.code;
          if (code === "28000" || code === "28P01") {
            await inner.end().catch(() => {});
            inner = await createPgClient();
            const result = await inner.query(text, values);
            return { rows: result.rows };
          }
          throw err;
        }
      },
      async end() {
        await inner.end();
      },
    };
  }
}

async function main() {
  const databaseAdapter = new SqliteDatabaseAdapter({
    path: join(STARKEEP_DIR, "data.db"),
  });

  // Local FS is always available — acts as a cache when S3 is configured
  const localAdapter = new FsObjectStorageAdapter({
    basePath: join(STARKEEP_DIR, "objects"),
  });

  // Read cloud config from ~/.starkeep/ if present (written by admin-desktop after setup)
  const cloudSetup = await loadCloudConfig();
  if (cloudSetup) {
    console.log(`Cloud config loaded: S3 bucket=${cloudSetup.config.s3Bucket}, DSQL=${cloudSetup.config.auroraEndpoint}`);
  }

  // S3: prefer cloud config file credentials (rotated by admin-desktop) over env vars
  let remoteAdapter: ObjectStorageAdapter | null = null;
  if (cloudSetup?.config.s3Bucket) {
    const credentialProvider = await makeCloudCredentialProvider();
    remoteAdapter = new S3ObjectStorageAdapter({
      bucketName: cloudSetup.config.s3Bucket,
      region: cloudSetup.config.s3Region,
      credentialProvider,
    });
    console.log("Remote S3 adapter initialized from cloud config");
  } else {
    const s3Bucket = process.env.STARKEEP_S3_BUCKET;
    if (s3Bucket) {
      remoteAdapter = new S3ObjectStorageAdapter({
        bucketName: s3Bucket,
        region: process.env.STARKEEP_S3_REGION || "us-east-1",
        keyPrefix: process.env.STARKEEP_S3_KEY_PREFIX || undefined,
        credentials:
          process.env.STARKEEP_S3_ACCESS_KEY_ID &&
          process.env.STARKEEP_S3_SECRET_ACCESS_KEY
            ? {
                accessKeyId: process.env.STARKEEP_S3_ACCESS_KEY_ID,
                secretAccessKey: process.env.STARKEEP_S3_SECRET_ACCESS_KEY,
              }
            : undefined,
      });
    }
  }

  // Aurora DSQL remote database: initialized from cloud config when available
  let remoteDatabaseAdapter: DatabaseAdapter | null = null;
  if (cloudSetup?.config.auroraEndpoint) {
    remoteDatabaseAdapter = new AuroraDsqlDatabaseAdapter(
      {
        hostname: cloudSetup.config.auroraEndpoint,
        region: cloudSetup.config.s3Region,
      },
      new CloudCredentialsDsqlClientFactory(),
    );
    await remoteDatabaseAdapter.init().catch((err: Error) =>
      console.error("Aurora DSQL init failed (non-fatal):", err.message),
    );
    console.log("Remote Aurora DSQL adapter initialized from cloud config");
  }

  // Global type registry — the data-server is the authoritative validator for all registered types.
  // TODO: auto-discover and load type definitions from installed app packages as the ecosystem grows.
  const typeRegistry = createTypeRegistry();
  typeRegistry.register({
    namespace: "@starkeep",
    name: "image",
    schema: v.object({
      // File-backed record: substantive content lives in object storage, not payload.
      // Payload carries app-level display fields that apps may set on creation.
      fileName: v.optional(v.string()),
      title: v.optional(v.string()),
    }),
  });
  typeRegistry.register({
    namespace: "@starkeep",
    name: "markdown",
    schema: v.object({
      fileName: v.optional(v.string()),
      title: v.optional(v.string()),
    }),
  });

  const clock = createHLCClock({ nodeId: NODE_ID, wallClockFunction: Date.now });

  // Pre-init so we can hand the raw SQLite handle to the sync change log +
  // state store, which share the records DB file.
  await databaseAdapter.init();

  const syncTransport = CLOUD_URL
    ? createHttpSyncTransport({ baseUrl: CLOUD_URL })
    : undefined;
  const syncRemoteStorage: ObjectStorageAdapter | undefined = CLOUD_URL
    ? new HttpObjectStorageAdapter({ baseUrl: `${CLOUD_URL}/files` })
    : undefined;
  const syncChangeLog = CLOUD_URL
    ? createSqliteChangeLog({ db: databaseAdapter.getRawDatabase() })
    : undefined;
  const syncStateStore = CLOUD_URL
    ? createSqliteSyncStateStore({ db: databaseAdapter.getRawDatabase() })
    : undefined;

  const sdk = await createStarkeepSdk({
    databaseAdapter,
    objectStorageAdapter: localAdapter,
    ownerId: OWNER_ID,
    nodeId: NODE_ID,
    syncTransport,
    remoteObjectStorageAdapter: syncRemoteStorage,
    syncChangeLog,
    syncStateStore,
  });

  const syncRuntime = {
    lastPullAt: null as string | null,
    lastPushAt: null as string | null,
    lastError: null as string | null,
    pullBackoffMs: PULL_INTERVAL_MS,
  };

  let pushTimer: NodeJS.Timeout | null = null;
  function schedulePush(): void {
    if (!sdk.sync) return;
    if (pushTimer) return;
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      try {
        await sdk.sync!.push();
        syncRuntime.lastPushAt = new Date().toISOString();
        syncRuntime.lastError = null;
      } catch (err) {
        syncRuntime.lastError = (err as Error).message;
        console.error("push failed:", err);
      }
    }, PUSH_DEBOUNCE_MS);
  }

  if (sdk.sync) {
    sdk.sync.onUpdate((event) => {
      console.log(`[sync] ${event.eventType} records=${event.recordIds.length}`);
      if (event.eventType === "local-change-recorded") {
        schedulePush();
      }
    });
  }

  let pullTimer: NodeJS.Timeout | null = null;
  async function runPull(): Promise<void> {
    if (!sdk.sync) return;
    try {
      await sdk.sync.pull();
      syncRuntime.lastPullAt = new Date().toISOString();
      syncRuntime.lastError = null;
      syncRuntime.pullBackoffMs = PULL_INTERVAL_MS;
    } catch (err) {
      syncRuntime.lastError = (err as Error).message;
      syncRuntime.pullBackoffMs = Math.min(syncRuntime.pullBackoffMs * 2, 5 * 60 * 1000);
      console.error("pull failed:", err);
    }
    pullTimer = setTimeout(runPull, syncRuntime.pullBackoffMs);
  }
  if (sdk.sync) {
    pullTimer = setTimeout(runPull, PULL_INTERVAL_MS);
  }

  // File watch manager — monitors local directories and syncs to Starkeep
  const watchManager = createFileWatchManager({ sdk, databaseAdapter, ownerId: OWNER_ID });

  // Restore persisted watches
  const existingWatches = await databaseAdapter.query({
    kind: "data",
    filters: [{ field: "type" as const, operator: "eq" as const, value: "system:watch" }],
    limit: 1000,
  });
  for (const record of existingWatches.records) {
    if (record.deletedAt) continue;
    const p = (record as any).payload;
    if (!p?.directoryPath || !p?.targetType) {
      await sdk.data.delete(record.id as any);
      continue;
    }
    watchManager.startWatch({
      id: record.id,
      directoryPath: p.directoryPath,
      targetType: p.targetType,
      recursive: p.recursive ?? true,
      includePatterns: p.includePatterns,
      excludePatterns: p.excludePatterns,
    }).catch((err: Error) => console.error(`Failed to restore watch ${record.id}:`, err.message));
  }

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const path = url.pathname;

    try {
      if (path === "/health") {
        json(res, { status: "ok" });
        return;
      }

      // Sync observability + manual trigger
      if (path === "/sync/status" && req.method === "GET") {
        json(res, {
          enabled: sdk.sync !== null,
          cloudUrl: CLOUD_URL ?? null,
          lastPullAt: syncRuntime.lastPullAt,
          lastPushAt: syncRuntime.lastPushAt,
          lastError: syncRuntime.lastError,
          pullBackoffMs: syncRuntime.pullBackoffMs,
          conflictCount: sdk.sync ? sdk.sync.getConflicts().length : 0,
        });
        return;
      }

      if (path === "/sync/now" && req.method === "POST") {
        if (!sdk.sync) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        const result = await sdk.sync.fullSync();
        syncRuntime.lastPullAt = new Date().toISOString();
        syncRuntime.lastPushAt = new Date().toISOString();
        json(res, result);
        return;
      }

      if (path === "/sync/conflicts" && req.method === "GET") {
        if (!sdk.sync) {
          json(res, { conflicts: [] });
          return;
        }
        json(res, { conflicts: sdk.sync.getConflicts() });
        return;
      }

      const resolveMatch = path.match(/^\/sync\/conflicts\/([^/]+)\/resolve$/);
      if (resolveMatch && req.method === "POST") {
        if (!sdk.sync) {
          res.writeHead(400);
          json(res, { error: "sync not configured" });
          return;
        }
        const body = JSON.parse(await readBody(req));
        if (body.keep !== "local" && body.keep !== "server") {
          res.writeHead(400);
          json(res, { error: 'body must include { keep: "local" | "server" }' });
          return;
        }
        const record = await sdk.data.resolveConflict(
          resolveMatch[1]! as any,
          { keep: body.keep },
        );
        schedulePush();
        json(res, { record });
        return;
      }

      // GET /browse?path=/ — hierarchical folder view for File Provider
      // Root shows: watched directories as folders + "Library" for untracked records
      // Subpaths show: actual subfolder structure from watched directories
      if (path === "/browse" && req.method === "GET") {
        const browsePath = url.searchParams.get("path") || "/";

        if (browsePath === "/") {
          // Root: list watched directories as folders + Library folder
          const watches = watchManager.getAllStatuses();
          const folders: { name: string; id: string; type: "watch" | "virtual"; itemCount: number }[] = [];

          for (const w of watches) {
            const dirName = w.directoryPath.split("/").pop() || w.directoryPath;
            folders.push({ name: dirName, id: `watch:${w.id}`, type: "watch", itemCount: w.syncedFiles });
          }

          // Check for records not in any watch (Library)
          const allData = await databaseAdapter.query({ kind: "data", limit: 100000 });
          const watchFileIds = new Set<string>();
          const unwatchedRecords: typeof allData.records = [];
          for (const r of allData.records) {
            if (r.deletedAt || r.type.startsWith("system:")) continue;
            const payload = (r as any).payload;
            if (payload?.watchId || r.type === "system:watch-file" || r.type === "system:watch") continue;
            // Check if this record is referenced by a watch-file
            const isWatched = watchManager.getAllStatuses().some(w => {
              const files = watchManager.getWatchFiles(w.id);
              return files.some(f => f.dataRecordId === r.id);
            });
            if (!isWatched) unwatchedRecords.push(r);
          }

          if (unwatchedRecords.length > 0) {
            folders.push({ name: "Library", id: "virtual:library", type: "virtual", itemCount: unwatchedRecords.length });
          }

          json(res, { path: "/", folders, files: [] });
          return;
        }

        // /watch:<watchId> or /watch:<watchId>/subfolder/path
        const watchMatch = browsePath.match(/^\/watch:([^/]+)(\/.*)?$/);
        if (watchMatch) {
          const watchId = watchMatch[1]!;
          const subPath = (watchMatch[2] || "").replace(/^\//, "");
          const allFiles = watchManager.getWatchFiles(watchId);
          const status = watchManager.getStatus(watchId);

          // Collect immediate children at this subpath level
          const folders = new Set<string>();
          const files: { name: string; relativePath: string; recordId: string; contentHash: string }[] = [];

          for (const f of allFiles) {
            const rel = f.relativePath;
            // Check if this file is within the subpath
            if (subPath && !rel.startsWith(subPath + "/") && rel !== subPath) continue;
            const remainder = subPath ? rel.slice(subPath.length + 1) : rel;
            if (!remainder) continue;

            const slashIdx = remainder.indexOf("/");
            if (slashIdx === -1) {
              // Direct child file
              files.push({ name: remainder, relativePath: rel, recordId: f.dataRecordId, contentHash: f.contentHash });
            } else {
              // Subfolder
              folders.add(remainder.slice(0, slashIdx));
            }
          }

          const folderList = Array.from(folders).sort().map(name => ({
            name,
            id: `watch:${watchId}/${subPath ? subPath + "/" : ""}${name}`,
            type: "folder" as const,
            itemCount: allFiles.filter(f => f.relativePath.startsWith((subPath ? subPath + "/" : "") + name + "/")).length,
          }));

          // Fetch record details for files
          const fileList = [];
          for (const f of files) {
            try {
              const record = await sdk.data.get(f.recordId as any);
              if (record) {
                fileList.push({
                  id: record.id,
                  name: f.name,
                  relativePath: f.relativePath,
                  mime_type: record.mimeType,
                  size_bytes: record.sizeBytes,
                  updated_at: new Date(record.updatedAt.wallTime).toISOString(),
                  created_at: new Date(record.createdAt.wallTime).toISOString(),
                });
              }
            } catch {}
          }

          json(res, { path: browsePath, watchId, folders: folderList, files: fileList });
          return;
        }

        // /Library — untracked records grouped by type
        if (browsePath === "/virtual:library") {
          const allData = await databaseAdapter.query({ kind: "data", limit: 100000 });
          const typeCounts = new Map<string, number>();

          for (const r of allData.records) {
            if (r.deletedAt || r.type.startsWith("system:")) continue;
            const isWatched = watchManager.getAllStatuses().some(w => {
              return watchManager.getWatchFiles(w.id).some(f => f.dataRecordId === r.id);
            });
            if (!isWatched) {
              typeCounts.set(r.type, (typeCounts.get(r.type) || 0) + 1);
            }
          }

          const folders = Array.from(typeCounts.entries()).map(([type, count]) => ({
            name: type,
            id: `library-type:${type}`,
            type: "virtual" as const,
            itemCount: count,
          }));

          json(res, { path: browsePath, folders, files: [] });
          return;
        }

        // /library-type:<type> — flat list of untracked records of a type
        const libraryTypeMatch = browsePath.match(/^\/library-type:(.+)$/);
        if (libraryTypeMatch) {
          const recordType = libraryTypeMatch[1]!;
          const result = await databaseAdapter.query({
            kind: "data",
            filters: [{ field: "type" as const, operator: "eq" as const, value: recordType }],
            limit: 10000,
          });

          const files = result.records
            .filter(r => !r.deletedAt)
            .filter(r => {
              return !watchManager.getAllStatuses().some(w => {
                return watchManager.getWatchFiles(w.id).some(f => f.dataRecordId === r.id);
              });
            })
            .map(r => ({
              id: r.id,
              name: ((r as any).payload?.title || (r as any).payload?.name || (r as any).payload?.fileName || r.id) + (extensionForMime((r as any).mimeType) || ""),
              mime_type: (r as any).mimeType,
              size_bytes: (r as any).sizeBytes,
              updated_at: new Date(r.updatedAt.wallTime).toISOString(),
              created_at: new Date(r.createdAt.wallTime).toISOString(),
            }));

          json(res, { path: browsePath, folders: [], files });
          return;
        }

        res.writeHead(404);
        json(res, { error: "Browse path not found" });
        return;
      }

      // GET /data/types — list record types with counts
      if (path === "/data/types" && req.method === "GET") {
        const result = await databaseAdapter.query({ kind: "data", limit: 10000 });

        const typeCounts = new Map<string, { count: number; latest: number }>();
        for (const record of result.records) {
          if (record.deletedAt) continue;
          const existing = typeCounts.get(record.type);
          const wallTime = record.updatedAt.wallTime;
          if (!existing) {
            typeCounts.set(record.type, { count: 1, latest: wallTime });
          } else {
            existing.count++;
            if (wallTime > existing.latest) existing.latest = wallTime;
          }
        }

        const types = Array.from(typeCounts.entries()).map(([type, info]) => ({
          record_type: type,
          count: info.count,
          latest_updated: new Date(info.latest).toISOString(),
        }));
        types.sort((a, b) => b.count - a.count);

        json(res, { types, total: result.records.filter(r => !r.deletedAt).length });
        return;
      }

      // GET /data/records?type=xxx&limit=100
      if (path === "/data/records" && req.method === "GET") {
        const recordType = url.searchParams.get("type");
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);

        const filters = recordType
          ? [{ field: "type" as const, operator: "eq" as const, value: recordType }]
          : [];

        const result = await databaseAdapter.query({
          kind: "data",
          filters,
          limit,
          sort: [{ field: "updatedAt", direction: "desc" as const }],
        });

        const records = await Promise.all(
          result.records
            .filter(r => !r.deletedAt)
            .map(async r => ({
              id: r.id,
              kind: r.kind,
              type: r.type,
              created_at: new Date(r.createdAt.wallTime).toISOString(),
              updated_at: new Date(r.updatedAt.wallTime).toISOString(),
              owner_id: r.ownerId,
              sync_status: r.syncStatus,
              version: r.version,
              payload: r.kind === "data" ? r.content : null,
              content_hash: r.kind === "data" ? r.contentHash : null,
              object_storage_key: r.kind === "data" ? r.objectStorageKey : null,
              mime_type: r.kind === "data" ? r.mimeType : null,
              size_bytes: r.kind === "data" ? r.sizeBytes : null,
              original_filename: r.kind === "data" ? r.originalFilename : null,
              path: r.kind === "data" && r.objectStorageKey
                ? await localAdapter.resolvePath(r.objectStorageKey)
                : null,
            }))
        );

        json(res, { records });
        return;
      }

      // POST /data/records — create a record, optionally with a file
      // Body: JSON { type, payload, fileName?, contentType?, fileBase64?, filePath? }
      if (path === "/data/records" && req.method === "POST") {
        const body = await readBody(req);
        const { type, payload, fileName, contentType, fileBase64, filePath } = JSON.parse(body);
        if (!type) {
          res.writeHead(400);
          json(res, { error: "type is required" });
          return;
        }

        let record;
        let uploadedBuffer: Buffer | null = null;
        if (filePath) {
          const resolvedName = fileName ?? (filePath as string).split("/").pop() ?? filePath;
          record = await sdk.data.putWithLocalFile(
            { type, ownerId: OWNER_ID, content: { ...payload, ...(resolvedName ? { fileName: resolvedName } : {}) }, originalFilename: resolvedName },
            filePath,
            contentType,
          );
        } else if (fileBase64) {
          uploadedBuffer = Buffer.from(fileBase64, "base64");
          record = await sdk.data.putWithFile(
            { type, ownerId: OWNER_ID, content: { ...payload, ...(fileName ? { fileName } : {}) }, originalFilename: fileName ?? null },
            uploadedBuffer,
            contentType,
          );
        } else {
          record = await sdk.data.put({ type, ownerId: OWNER_ID, content: payload || {} });
        }

        // Dual-write to remote S3 + Aurora DSQL when cloud config is present.
        // S3 write is awaited so the file is available for presigned URLs immediately
        // after the response is returned (avoids 404 on the first file-url request).
        if (remoteAdapter && record.objectStorageKey) {
          const fileData = uploadedBuffer
            ?? (await localAdapter.get(record.objectStorageKey).catch(() => null))?.data
            ?? null;
          if (fileData) {
            await remoteAdapter
              .put(record.objectStorageKey, fileData, { contentType: record.mimeType ?? undefined })
              .catch((err: Error) => console.error("S3 remote write failed (non-fatal):", err.message));
          }
        }
        if (remoteDatabaseAdapter) {
          remoteDatabaseAdapter
            .put(record)
            .catch((err: Error) => console.error("Aurora DSQL write failed (non-fatal):", err.message));
        }

        json(res, {
          record: {
            id: record.id,
            type: record.type,
            created_at: new Date(record.createdAt.wallTime).toISOString(),
            updated_at: new Date(record.updatedAt.wallTime).toISOString(),
            owner_id: record.ownerId,
            payload: record.content,
            mime_type: record.mimeType,
            size_bytes: record.sizeBytes,
            object_storage_key: record.objectStorageKey,
            original_filename: record.originalFilename,
            path: record.objectStorageKey
              ? await localAdapter.resolvePath(record.objectStorageKey)
              : null,
          },
        });
        return;
      }

      // POST /data/metadata — accept app-generated metadata (app-side generator results)
      // Body: { targetId, targetType, generatorId, generatorVersion, value }
      // Apps run generators locally and push the results here so they are stored in the
      // shared metadata_sync table alongside other syncable metadata.
      if (path === "/data/metadata" && req.method === "POST") {
        const body = await readBody(req);
        const { targetId, targetType, generatorId, generatorVersion, value } = JSON.parse(body);
        if (!targetId || !targetType || !generatorId) {
          res.writeHead(400);
          json(res, { error: "targetId, targetType, and generatorId are required" });
          return;
        }
        const now = clock.now();
        await databaseAdapter.upsertSyncableMetadata({
          targetId,
          targetType,
          generatorId,
          generatorVersion: generatorVersion ?? 1,
          inputHash: null,
          updatedAt: now,
          value: value ?? {},
        });
        json(res, { ok: true });
        return;
      }

      // GET /data/records/:id/file-url — time-limited URL for file access
      const fileUrlMatch = path.match(/^\/data\/records\/([^/]+)\/file-url$/);
      if (fileUrlMatch && req.method === "GET") {
        const record = await sdk.data.get(fileUrlMatch[1]! as any);
        if (!record) {
          res.writeHead(404);
          json(res, { error: "Record not found" });
          return;
        }
        if (!record.objectStorageKey) {
          res.writeHead(404);
          json(res, { error: "Record has no attached file" });
          return;
        }
        const expiresIn = parseInt(url.searchParams.get("expiresIn") || "3600", 10);
        const mimeType = record.mimeType ?? "application/octet-stream";

        // When remoteAdapter (S3) is configured, prefer presigned URLs so that remote
        // clients (e.g. API Gateway → Lambda) don't receive a http://127.0.0.1 token URL
        // that only works on the local machine. For local-only deployments, fall back to
        // the fast local file token.
        if (remoteAdapter && remoteAdapter.getSignedUrl) {
          const fileUrl = await remoteAdapter.getSignedUrl(
            record.objectStorageKey,
            { expiresIn },
          );
          json(res, { url: fileUrl, source: "remote", mimeType: record.mimeType, sizeBytes: record.sizeBytes, expiresIn });
          return;
        }

        // Local-only: serve directly from the FS adapter via a signed token
        const localHit = await localAdapter.get(record.objectStorageKey).catch(() => null);
        if (localHit) {
          const token = createFileToken(record.objectStorageKey, mimeType, expiresIn);
          json(res, {
            url: `http://127.0.0.1:${PORT}/data/files/${token}`,
            source: "local",
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
            expiresIn,
          });
          return;
        }

        res.writeHead(404);
        json(res, { error: "File not found locally and no remote storage configured" });
        return;
      }

      // GET /data/files/:token — serve file content, validating the signed token
      const fileServeMatch = path.match(/^\/data\/files\/([^/]+)$/);
      if (fileServeMatch && req.method === "GET") {
        const parsed = verifyFileToken(fileServeMatch[1]!);
        if (!parsed) {
          res.writeHead(403);
          json(res, { error: "Invalid or expired file token" });
          return;
        }
        const fileResult = await localAdapter.get(parsed.key);
        if (!fileResult) {
          res.writeHead(404);
          json(res, { error: "File not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": parsed.mimeType,
          "Content-Length": fileResult.size,
          "Cache-Control": "private, no-store",
        });
        res.end(Buffer.from(fileResult.data));
        return;
      }

      // GET /data/records/:id/metadata — list metadata_sync entries for a record
      const metadataMatch = path.match(/^\/data\/records\/([^/]+)\/metadata$/);
      if (metadataMatch && req.method === "GET") {
        const metadata = databaseAdapter.getMetadataForRecord(metadataMatch[1]!);
        json(res, { metadata });
        return;
      }

      // GET /data/records/:id
      const recordMatch = path.match(/^\/data\/records\/([^/]+)$/);
      if (recordMatch && req.method === "GET") {
        const record = await sdk.data.get(recordMatch[1]! as any);
        if (!record) {
          res.writeHead(404);
          json(res, { error: "Record not found" });
          return;
        }
        json(res, {
          record: {
            id: record.id,
            kind: record.kind,
            type: record.type,
            created_at: new Date(record.createdAt.wallTime).toISOString(),
            updated_at: new Date(record.updatedAt.wallTime).toISOString(),
            owner_id: record.ownerId,
            sync_status: record.syncStatus,
            version: record.version,
            payload: record.content,
            content_hash: record.contentHash,
            object_storage_key: record.objectStorageKey,
            mime_type: record.mimeType,
            size_bytes: record.sizeBytes,
            original_filename: record.originalFilename,
            path: record.kind === "data" && record.objectStorageKey
              ? await localAdapter.resolvePath(record.objectStorageKey)
              : null,
          },
        });
        return;
      }

      // ---------------------------------------------------------------
      // Watch endpoints
      // ---------------------------------------------------------------

      // POST /watches — register a new directory watch
      if (path === "/watches" && req.method === "POST") {
        const body = await readBody(req);
        const { directoryPath, targetType, recursive, includePatterns, excludePatterns } = JSON.parse(body);
        if (!directoryPath || !targetType) {
          res.writeHead(400);
          json(res, { error: "directoryPath and targetType are required" });
          return;
        }
        // Validate directory exists
        try {
          const s = await fsStat(directoryPath);
          if (!s.isDirectory()) {
            res.writeHead(400);
            json(res, { error: "Path is not a directory" });
            return;
          }
        } catch {
          res.writeHead(400);
          json(res, { error: "Directory does not exist" });
          return;
        }
        // Create system:watch record
        const record = await sdk.data.put({
          type: "system:watch",
          ownerId: OWNER_ID,
          payload: { directoryPath, targetType, recursive: recursive ?? true, includePatterns, excludePatterns },
        });
        // Start watching
        await watchManager.startWatch({
          id: record.id,
          directoryPath,
          targetType,
          recursive: recursive ?? true,
          includePatterns,
          excludePatterns,
        });
        const status = watchManager.getStatus(record.id);
        if (status?.state === "error") {
          await sdk.data.delete(record.id as any);
          res.writeHead(500);
          json(res, { error: status.error ?? "Failed to watch directory" });
          return;
        }
        json(res, { watch: status });
        return;
      }

      // GET /watches — list all watches
      if (path === "/watches" && req.method === "GET") {
        json(res, { watches: watchManager.getAllStatuses() });
        return;
      }

      // GET /watches/file-status?path=... — check if a file is watched/synced
      if (path === "/watches/file-status" && req.method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          res.writeHead(400);
          json(res, { error: "path query param required" });
          return;
        }
        json(res, watchManager.getFileStatus(filePath));
        return;
      }

      // GET /watches/directory-status?path=... — check if a directory is watched
      if (path === "/watches/directory-status" && req.method === "GET") {
        const dirPath = url.searchParams.get("path");
        if (!dirPath) {
          res.writeHead(400);
          json(res, { error: "path query param required" });
          return;
        }
        json(res, watchManager.getDirectoryStatus(dirPath));
        return;
      }

      // GET /watches/:id — single watch detail
      const watchDetailMatch = path.match(/^\/watches\/([^/]+)$/);
      if (watchDetailMatch && req.method === "GET") {
        const status = watchManager.getStatus(watchDetailMatch[1]!);
        if (!status) {
          res.writeHead(404);
          json(res, { error: "Watch not found" });
          return;
        }
        json(res, { watch: status });
        return;
      }

      // GET /watches/:id/files — list files in a watch
      const watchFilesMatch = path.match(/^\/watches\/([^/]+)\/files$/);
      if (watchFilesMatch && req.method === "GET") {
        const files = watchManager.getWatchFiles(watchFilesMatch[1]!);
        json(res, { files });
        return;
      }

      // DELETE /watches/:id — stop and remove a watch
      const watchDeleteMatch = path.match(/^\/watches\/([^/]+)$/);
      if (watchDeleteMatch && req.method === "DELETE") {
        await watchManager.stopWatch(watchDeleteMatch[1]!);
        await sdk.data.delete(watchDeleteMatch[1]! as any);
        json(res, { ok: true });
        return;
      }

      res.writeHead(404);
      json(res, { error: "Not found" });
    } catch (err) {
      console.error("Request error:", err);
      res.writeHead(500);
      json(res, { error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Starkeep data server listening on http://127.0.0.1:${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    if (pullTimer) clearTimeout(pullTimer);
    if (pushTimer) clearTimeout(pushTimer);
    await watchManager.shutdown();
    await sdk.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", async () => {
    // Reuse shutdown so Ctrl-C on a dev process drains cleanly.
    await shutdown();
  });
}

function extensionForMime(mime: string | null): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "image/heic": ".heic", "application/pdf": ".pdf", "text/plain": ".txt",
    "text/markdown": ".md", "application/json": ".json", "video/mp4": ".mp4",
  };
  return map[mime] ?? "";
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: import("node:http").ServerResponse, body: unknown) {
  if (!res.headersSent) res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Encode storage key + mime + expiry into a URL-safe signed token. */
function createFileToken(key: string, mimeType: string, expiresIn: number): string {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const payload = `${key}|${mimeType}|${expires}`;
  const sig = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

/** Verify and decode a file token. Returns null if invalid or expired. */
function verifyFileToken(token: string): { key: string; mimeType: string } | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const payload = Buffer.from(payloadB64, "base64url").toString();
  const expected = createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
  if (sig !== expected) return null;
  const parts = payload.split("|");
  if (parts.length !== 3) return null;
  const expires = parseInt(parts[2]!, 10);
  if (Date.now() / 1000 > expires) return null;
  return { key: parts[0]!, mimeType: parts[1]! };
}

main().catch((err) => {
  console.error("Failed to start data server:", err);
  process.exit(1);
});
