/**
 * Cloud API Lambda handler — the remote equivalent of the local data-server.
 *
 * Provides mediated access to Aurora DSQL and S3 behind an API Gateway JWT
 * authorizer. The Lambda execution role credentials are used for all AWS calls;
 * no credential management is required here.
 *
 * Environment variables (injected by SST):
 *   AURORA_ENDPOINT  — Aurora DSQL cluster hostname
 *   S3_BUCKET        — S3 bucket name for object storage
 *   AWS_REGION       — set automatically by Lambda runtime
 */

import { createHash } from "node:crypto";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { AuroraDsqlDatabaseAdapter } from "@starkeep/storage-aurora-dsql";
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3";
import { generateId, createHLCClock, SyncStatus, serializeHLC } from "@starkeep/core";
import type { DataRecord, StarkeepId, HLCTimestamp } from "@starkeep/core";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "@starkeep/storage-aurora-dsql";
import { ok, clientErr, type APIGatewayEvent } from "./handler-utils.js";

const ZERO_HLC: HLCTimestamp = { wallTime: 0, counter: 0, nodeId: "" };

// ---------------------------------------------------------------------------
// DSQL client factory using the Lambda execution role credentials
// ---------------------------------------------------------------------------

class LambdaDsqlClientFactory implements DatabaseClientFactory {
  async createClient(options: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    const { hostname, region } = options;

    const createPgClient = async (): Promise<pg.Client> => {
      const signer = new DsqlSigner({
        hostname,
        region,
        // No credentials specified — DsqlSigner uses the AWS default provider
        // chain, which picks up the Lambda execution role from the runtime env.
      });
      const token = await signer.getDbConnectAdminAuthToken();
      const client = new pg.Client({
        host: hostname,
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
          // IAM auth token expired (~15 min) — reconnect and retry once
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

// ---------------------------------------------------------------------------
// Adapter initialisation — cached across Lambda invocations (warm starts)
// ---------------------------------------------------------------------------

interface Adapters {
  db: AuroraDsqlDatabaseAdapter;
  storage: S3ObjectStorageAdapter;
  clock: ReturnType<typeof createHLCClock>;
}

let adapters: Adapters | null = null;

async function getAdapters(): Promise<Adapters> {
  if (adapters) return adapters;

  const region = process.env.AWS_REGION ?? "us-east-1";
  const auroraEndpoint = process.env.AURORA_ENDPOINT;
  const s3Bucket = process.env.S3_BUCKET;

  if (!auroraEndpoint) throw new Error("AURORA_ENDPOINT env var is required");
  if (!s3Bucket) throw new Error("S3_BUCKET env var is required");

  const db = new AuroraDsqlDatabaseAdapter(
    { hostname: auroraEndpoint, region },
    new LambdaDsqlClientFactory(),
  );
  await db.init();

  const storage = new S3ObjectStorageAdapter({
    bucketName: s3Bucket,
    region,
    // No credentials: S3Client uses the Lambda execution role via default chain
  });

  const clock = createHLCClock({ nodeId: "cloud-api", wallClockFunction: Date.now });

  adapters = { db, storage, clock };
  return adapters;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function recordToResponse(record: DataRecord) {
  return {
    id: record.id,
    type: record.type,
    created_at: new Date(record.createdAt.wallTime).toISOString(),
    updated_at: new Date(record.updatedAt.wallTime).toISOString(),
    owner_id: record.ownerId,
    sync_status: record.syncStatus,
    version: record.version,
    payload: record.content,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    content_hash: record.contentHash,
    object_storage_key: record.objectStorageKey,
    original_filename: record.originalFilename,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayEvent) {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;

    // CORS preflight — return 200 immediately (API Gateway adds CORS headers from gateway config).
    if (method === "OPTIONS") {
      return { statusCode: 200, body: "" };
    }

    const { db, storage, clock } = await getAdapters();
    const query = event.queryStringParameters ?? {};

    // Subject identity from Cognito JWT authorizer claims (set by API Gateway)
    const claims = event.requestContext.authorizer?.jwt?.claims;
    const ownerId = claims?.sub ?? "unknown";

    // GET /health
    if (method === "GET" && path === "/health") {
      const dbHealthy = await db.healthCheck();
      const storageHealthy = await storage.healthCheck();
      return ok({ status: dbHealthy && storageHealthy ? "ok" : "degraded", db: dbHealthy, storage: storageHealthy });
    }

    // GET /data/types — list record types with counts
    if (method === "GET" && path === "/data/types") {
      const result = await db.query({ limit: 10000 });
      const counts = new Map<string, number>();
      for (const record of result.records) {
        counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
      }
      const types = Array.from(counts.entries()).map(([record_type, count]) => ({ record_type, count }));
      return ok({ types, total: result.records.length });
    }

    // GET /data/records — list records with optional type filter, cursor pagination, and updated_after cursor
    if (method === "GET" && path === "/data/records") {
      const type = query["type"];
      const limit = Math.min(parseInt(query["limit"] ?? "50", 10), 500);
      const cursor = query["cursor"];
      const updatedAfter = query["updated_after"];

      const filters: { field: string; operator: "gt"; value: string }[] = [];
      if (updatedAfter) {
        const ms = new Date(updatedAfter).getTime();
        if (!isNaN(ms)) {
          filters.push({
            field: "updatedAt",
            operator: "gt",
            value: serializeHLC({ wallTime: ms, counter: 0, nodeId: "" }),
          });
        }
      }

      const result = await db.query({ type, filters: filters.length > 0 ? filters : undefined, limit: limit + 1, cursor });
      const hasMore = result.records.length > limit;
      const records = hasMore ? result.records.slice(0, limit) : result.records;
      return ok({ records: records.map(recordToResponse), hasMore, nextCursor: hasMore ? records[records.length - 1].id : null });
    }

    // POST /data/records — create a record, optionally with a file
    // Body: JSON { type, payload?, content?, fileName?, contentType?, fileBase64? }
    if (method === "POST" && path === "/data/records") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        type?: string;
        payload?: Record<string, unknown>;
        content?: Record<string, unknown>;
        fileName?: string;
        contentType?: string;
        fileBase64?: string;
      };
      if (!body.type) return clientErr("type is required", 400);

      const now = clock.now();
      const recordContent = body.payload ?? body.content ?? {};
      const originalFilename = body.fileName ?? null;
      const mimeType = body.contentType ?? null;

      let objectStorageKey: string | null = null;
      let contentHash: string | null = null;
      let sizeBytes: number | null = null;

      if (body.fileBase64) {
        const fileBuffer = Buffer.from(body.fileBase64, "base64");
        const hash = createHash("sha256").update(fileBuffer).digest("hex");
        contentHash = hash;
        objectStorageKey = `${hash.slice(0, 2)}/${hash}`;
        sizeBytes = fileBuffer.length;
        await storage.put(objectStorageKey, fileBuffer, { contentType: mimeType ?? undefined });
      }

      const record: DataRecord = {
        id: generateId(),
        kind: "data",
        type: body.type,
        content: { ...recordContent, ...(originalFilename ? { fileName: originalFilename } : {}) },
        ownerId,
        createdAt: now,
        updatedAt: now,
        syncStatus: SyncStatus.Synced,
        deletedAt: null,
        version: 1,
        contentHash,
        objectStorageKey,
        mimeType,
        sizeBytes,
        originalFilename,
      };
      await db.put(record);
      return ok({ record: recordToResponse(record) }, 201);
    }

    // POST /data/metadata — store app-generated metadata
    // Body: { targetId, targetType, generatorId, generatorVersion?, value?,
    //         objectStorageKey?, contentHash?, mimeType?, sizeBytes? }
    if (method === "POST" && path === "/data/metadata") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        targetId?: string;
        targetType?: string;
        generatorId?: string;
        generatorVersion?: number;
        value?: Record<string, unknown>;
        objectStorageKey?: string;
        contentHash?: string;
        mimeType?: string;
        sizeBytes?: number;
      };
      if (!body?.targetId || !body.targetType || !body.generatorId) {
        return clientErr("targetId, targetType, and generatorId are required", 400);
      }
      const now = clock.now();
      await db.upsertSyncableMetadata({
        targetId: body.targetId as StarkeepId,
        targetType: body.targetType,
        generatorId: body.generatorId,
        generatorVersion: body.generatorVersion ?? 1,
        inputHash: null,
        updatedAt: now,
        value: body.value ?? {},
        objectStorageKey: body.objectStorageKey ?? null,
        contentHash: body.contentHash ?? null,
        mimeType: body.mimeType ?? null,
        sizeBytes: body.sizeBytes ?? null,
      });
      return ok({ ok: true });
    }

    // POST /data/files — upload raw binary bytes to S3 (content-addressed)
    // Body: raw bytes. Content-Type header is the MIME type.
    // Returns: { key, contentHash, mimeType, sizeBytes }
    if (method === "POST" && path === "/data/files") {
      const headers = event.headers ?? {};
      const contentTypeHeader = headers["content-type"] ?? headers["Content-Type"] ?? "application/octet-stream";
      const mimeType = contentTypeHeader.split(";")[0]!.trim();
      const fileBuffer = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body ?? "", "binary");
      if (fileBuffer.length === 0) return clientErr("Request body must not be empty", 400);
      if (fileBuffer.length > 20_000_000) return clientErr("File too large (20 MB limit)", 413);
      const hex = createHash("sha256").update(fileBuffer).digest("hex");
      const key = `metadata/${hex}`;
      await storage.put(key, fileBuffer, { contentType: mimeType });
      return ok({ key, contentHash: hex, mimeType, sizeBytes: fileBuffer.length });
    }

    // GET /data/metadata/:targetId/:generatorId/file-url — presigned S3 URL for a
    // metadata-backed file (e.g. an image downsize thumbnail).
    const metaFileUrlMatch = path.match(/^\/data\/metadata\/([^/]+)\/(.+)\/file-url$/);
    if (metaFileUrlMatch && method === "GET") {
      const [, metaTargetId, encodedGeneratorId] = metaFileUrlMatch;
      const generatorId = decodeURIComponent(encodedGeneratorId!);
      const entries = await db.getMetadataForRecord(metaTargetId!);
      const entry = entries.find((e) => e.generatorId === generatorId);
      if (!entry?.objectStorageKey) return clientErr("No file-backed metadata found for this record and generator", 404);
      const expiresIn = parseInt(query["expiresIn"] ?? "3600", 10);
      const url = await storage.getSignedUrl!(entry.objectStorageKey, { expiresIn });
      return ok({ url, source: "remote", mimeType: entry.mimeType, expiresIn });
    }

    // GET /data/records/:id/file-url — generate a presigned S3 URL
    const fileUrlMatch = path.match(/^\/data\/records\/([^/]+)\/file-url$/);
    if (fileUrlMatch && method === "GET") {
      const id = decodeURIComponent(fileUrlMatch[1]!) as StarkeepId;
      const record = await db.get(id);
      if (!record) return clientErr("Record not found", 404);
      if (!record.objectStorageKey) return clientErr("Record has no attached file", 404);
      const expiresIn = parseInt(query["expiresIn"] ?? "3600", 10);
      const url = await storage.getSignedUrl!(record.objectStorageKey, { expiresIn });
      return ok({ url, source: "remote", mimeType: record.mimeType, sizeBytes: record.sizeBytes, expiresIn });
    }

    // GET /data/records/:id / PUT /data/records/:id / DELETE /data/records/:id
    const recordIdMatch = path.match(/^\/data\/records\/([^/]+)$/);
    if (recordIdMatch) {
      const id = decodeURIComponent(recordIdMatch[1]!) as StarkeepId;

      if (method === "GET") {
        const record = await db.get(id);
        if (!record) return clientErr("Record not found", 404);
        return ok({ record: recordToResponse(record) });
      }

      if (method === "PUT") {
        const existing = await db.get(id);
        if (!existing) return clientErr("Record not found", 404);
        const body = event.body ? (JSON.parse(event.body) as { content?: Record<string, unknown> }) : null;
        if (!body?.content) return clientErr("content is required", 400);
        const now = clock.now();
        const updated: DataRecord = { ...existing, content: body.content, updatedAt: now, version: existing.version + 1 };
        await db.put(updated);
        return ok({ record: recordToResponse(updated) });
      }

      if (method === "DELETE") {
        await db.delete(id);
        return ok({ deleted: true });
      }
    }

    // POST /sync/pull — pull changes since a given HLC timestamp
    if (method === "POST" && path === "/sync/pull") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody);
      const transport = createInProcessSyncTransport({ databaseAdapter: db, clock });
      const response = await transport.pullChanges(body);
      return ok(response);
    }

    // POST /sync/push — push local changes to the cloud
    if (method === "POST" && path === "/sync/push") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody);
      const transport = createInProcessSyncTransport({ databaseAdapter: db, clock });
      const response = await transport.pushChanges(body);
      return ok(response);
    }

    // GET /sync/metadata?since=<json-encoded-hlc> — list syncable metadata records changed since cursor.
    // Used by the local data-server's HttpRemoteMetadataAdapter for pullMetadata / pushMetadata.
    if (method === "GET" && path === "/sync/metadata") {
      const sinceParam = query["since"];
      const sinceHlc: HLCTimestamp = sinceParam
        ? (JSON.parse(decodeURIComponent(sinceParam)) as HLCTimestamp)
        : ZERO_HLC;
      const records = await db.getSyncableMetadataChangesSince(sinceHlc);
      return ok({ records });
    }

    // POST /files/presign — generate a presigned S3 PUT URL for direct upload.
    // Used by the local data-server to bypass API Gateway for large file uploads.
    if (method === "POST" && path === "/files/presign") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as { key?: string; contentType?: string; expiresIn?: number };
      if (!body.key) return clientErr("key is required", 400);
      const expiresIn = body.expiresIn ?? 3600;
      const url = await storage.getSignedPutUrl!(body.key, { contentType: body.contentType, expiresIn });
      return ok({ url, key: body.key, expiresIn });
    }

    // GET /files/{+key}/presign — generate a presigned S3 GET URL for direct download.
    // Must be matched before the general filesMatch block.
    const filesPresignMatch = path.match(/^\/files\/(.+)\/presign$/);
    if (filesPresignMatch && method === "GET") {
      const key = decodeURIComponent(filesPresignMatch[1]!);
      const exists = await storage.has(key);
      if (!exists) return clientErr("File not found", 404);
      const expiresIn = parseInt(query["expiresIn"] ?? "3600", 10);
      const url = await storage.getSignedUrl!(key, { expiresIn });
      return ok({ url, expiresIn });
    }

    // HEAD|GET|PUT /files/{+key} — S3 proxy for file-backed metadata sync.
    // The local data-server's HttpObjectStorageAdapter calls these to transfer
    // thumbnail files alongside metadata records during pullMetadata / pushMetadata.
    const filesMatch = path.match(/^\/files\/(.+)$/);
    if (filesMatch) {
      const key = decodeURIComponent(filesMatch[1]!);

      if (method === "HEAD") {
        const result = await storage.get(key);
        return { statusCode: result ? 200 : 404, headers: {}, body: "" };
      }

      if (method === "GET") {
        const result = await storage.get(key);
        if (!result) return clientErr("File not found", 404);
        const data = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer);
        return {
          statusCode: 200,
          headers: {
            "Content-Type": result.contentType ?? "application/octet-stream",
            "Content-Length": String(data.byteLength),
          },
          body: Buffer.from(data).toString("base64"),
          isBase64Encoded: true,
        };
      }

      if (method === "PUT") {
        const headers = event.headers ?? {};
        const contentType = (headers["content-type"] ?? headers["Content-Type"] ?? "application/octet-stream").split(";")[0]!.trim();
        const fileBuffer = event.isBase64Encoded && event.body
          ? Buffer.from(event.body, "base64")
          : Buffer.from(event.body ?? "", "binary");
        await storage.put(key, fileBuffer, { contentType });
        return ok({ ok: true });
      }
    }

    return clientErr("Not found", 404);
  } catch (e) {
    console.error("Handler error:", e);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Internal server error" }) };
  }
}
