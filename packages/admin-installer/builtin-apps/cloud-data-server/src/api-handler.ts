/**
 * Cloud API Lambda handler — per-app isolated access to DSQL and S3.
 *
 * The Lambda execution role has NO data-plane access. For every request:
 *   1. Extract appId from the path prefix /apps/{appId}/
 *   2. STS-assume the app's IAM role (${STACK_PREFIX}-app-{appId}-role), cached ~14 min
 *   3. Connect to DSQL as the app's PG role using DbConnect (not Admin)
 *   4. Scope all S3 access to apps/{appId}/ prefix under the app role
 *
 * Environment variables:
 *   AURORA_ENDPOINT  — Aurora DSQL cluster hostname
 *   S3_BUCKET        — S3 bucket for object storage (files)
 *   STACK_PREFIX     — e.g. "starkeep"
 *   MANAGER_ROLE_ARN — ARN of the Manager role to hop through for app role assumption
 *   AWS_REGION       — set automatically by Lambda runtime
 */

import { createHash } from "node:crypto";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { AuroraDsqlDatabaseAdapter } from "@starkeep/storage-aurora-dsql";
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3";
import {
  generateId,
  createHLCClock,
  SyncStatus,
  serializeHLC,
  dataRecordObjectKey,
} from "@starkeep/core";
import type { DataRecord, StarkeepId } from "@starkeep/core";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import {
  DsqlAppSyncableNamespaceStore,
  DsqlAppSyncableApplier,
} from "@starkeep/storage-aurora-dsql";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "@starkeep/storage-aurora-dsql";
import { ok, clientErr, type APIGatewayEvent } from "./handler-utils.js";

// ---------------------------------------------------------------------------
// Per-app credential cache (STS sessions ~15 min, refreshed at 14 min)
// ---------------------------------------------------------------------------

interface CachedCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number; // ms epoch
}

const credentialCache = new Map<string, CachedCreds>();
const CRED_REFRESH_BUFFER_MS = 60_000; // refresh 60s before expiry

async function getAppCreds(appId: string): Promise<CachedCreds> {
  const cached = credentialCache.get(appId);
  if (cached && cached.expiresAt - Date.now() > CRED_REFRESH_BUFFER_MS) {
    return cached;
  }

  const stackPrefix = process.env.STACK_PREFIX;
  const managerRoleArn = process.env.MANAGER_ROLE_ARN;
  const region = process.env.AWS_REGION ?? "us-east-1";
  if (!stackPrefix || !managerRoleArn) {
    throw new Error("STACK_PREFIX and MANAGER_ROLE_ARN env vars are required");
  }

  const appRoleArn = `arn:aws:iam::${getAccountId()}:role/${stackPrefix}-app-${appId}-role`;

  // Hop through Manager role first (Lambda exec role → Manager → app role)
  const sts = new STSClient({ region });
  const managerResult = await sts.send(new AssumeRoleCommand({
    RoleArn: managerRoleArn,
    RoleSessionName: `lambda-mgr-${Date.now()}`,
    DurationSeconds: 900,
  }));
  const mc = managerResult.Credentials;
  if (!mc?.AccessKeyId || !mc.SecretAccessKey || !mc.SessionToken) {
    throw new Error("Failed to assume Manager role");
  }

  const managerSts = new STSClient({
    region,
    credentials: {
      accessKeyId: mc.AccessKeyId,
      secretAccessKey: mc.SecretAccessKey,
      sessionToken: mc.SessionToken,
    },
  });
  const appResult = await managerSts.send(new AssumeRoleCommand({
    RoleArn: appRoleArn,
    RoleSessionName: `lambda-app-${appId}-${Date.now()}`,
    DurationSeconds: 900,
  }));
  const ac = appResult.Credentials;
  if (!ac?.AccessKeyId || !ac.SecretAccessKey || !ac.SessionToken || !ac.Expiration) {
    throw new Error(`Failed to assume app role for ${appId}`);
  }

  const creds: CachedCreds = {
    accessKeyId: ac.AccessKeyId,
    secretAccessKey: ac.SecretAccessKey,
    sessionToken: ac.SessionToken,
    expiresAt: ac.Expiration.getTime(),
  };
  credentialCache.set(appId, creds);
  return creds;
}

// Account ID parsed from Lambda ARN (available in every Lambda invocation)
function getAccountId(): string {
  const arnParts = (process.env.AWS_LAMBDA_FUNCTION_ARN ?? "").split(":");
  return arnParts[4] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Per-app DSQL client factory
// ---------------------------------------------------------------------------

class AppDsqlClientFactory implements DatabaseClientFactory {
  constructor(
    private readonly appId: string,
    private readonly creds: CachedCreds,
    private readonly stackPrefix: string,
  ) {}

  async createClient(options: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    const { hostname, region } = options;
    const pgUser = `${this.stackPrefix}_app_${this.appId}`.toLowerCase().replace(/-/g, "_");
    const appId = this.appId;
    const creds = this.creds;

    const createPgClient = async (): Promise<pg.Client> => {
      const signer = new DsqlSigner({
        hostname,
        region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
      const token = await signer.getDbConnectAuthToken();
      const client = new pg.Client({
        host: hostname,
        port: 5432,
        database: options.database ?? "postgres",
        user: pgUser,
        password: token,
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      await client.query("SET starkeep.app_id = $1", [appId]);
      return client;
    };

    let inner = await createPgClient();

    return {
      async query(text, values) {
        try {
          const result = await inner.query(text, values);
          return { rows: result.rows };
        } catch (err: unknown) {
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
// Per-request adapter creation (not cached — creds are cached separately)
// ---------------------------------------------------------------------------

function makeAdapters(appId: string, creds: CachedCreds) {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const auroraEndpoint = process.env.AURORA_ENDPOINT;
  const s3Bucket = process.env.S3_BUCKET;
  const stackPrefix = process.env.STACK_PREFIX ?? "starkeep";

  if (!auroraEndpoint) throw new Error("AURORA_ENDPOINT env var is required");
  if (!s3Bucket) throw new Error("S3_BUCKET env var is required");

  const clientFactory = new AppDsqlClientFactory(appId, creds, stackPrefix);

  const db = new AuroraDsqlDatabaseAdapter(
    { hostname: auroraEndpoint, region },
    clientFactory,
  );

  const storage = new S3ObjectStorageAdapter({
    bucketName: s3Bucket,
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });

  const clock = createHLCClock({ nodeId: appId, wallClockFunction: Date.now });

  return { db, storage, clock, clientFactory, auroraEndpoint, region };
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

function parseAppPath(rawPath: string): { appId: string; subPath: string } | null {
  const match = rawPath.match(/^\/apps\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return { appId: match[1]!, subPath: match[2] ?? "/" };
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
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    content_hash: record.contentHash,
    object_storage_key: record.objectStorageKey,
    original_filename: record.originalFilename,
    parent_id: record.parentId,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayEvent) {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const rawPath = event.rawPath;

    if (method === "OPTIONS") {
      return { statusCode: 200, body: "" };
    }

    // Unauthenticated health check — no app role needed
    if (method === "GET" && rawPath === "/health") {
      return ok({ status: "ok" });
    }

    // All other routes require /apps/{appId}/...
    const parsed = parseAppPath(rawPath);
    if (!parsed) return clientErr("Not found", 404);
    const { appId, subPath } = parsed;

    const creds = await getAppCreds(appId);
    const { db, storage, clock, clientFactory, auroraEndpoint, region } = makeAdapters(appId, creds);

    await db.init();

    const query = event.queryStringParameters ?? {};
    const claims = event.requestContext.authorizer?.jwt?.claims;
    const ownerId = claims?.sub ?? "unknown";

    // GET /apps/{appId}/health — app-scoped health check
    if (method === "GET" && subPath === "/health") {
      const dbHealthy = await db.healthCheck();
      const storageHealthy = await storage.healthCheck();
      return ok({ status: dbHealthy && storageHealthy ? "ok" : "degraded", db: dbHealthy, storage: storageHealthy });
    }

    // GET /apps/{appId}/data/types
    if (method === "GET" && subPath === "/data/types") {
      const result = await db.query({ limit: 10000 });
      const counts = new Map<string, number>();
      for (const record of result.records) {
        counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
      }
      const types = Array.from(counts.entries()).map(([record_type, count]) => ({ record_type, count }));
      return ok({ types, total: result.records.length });
    }

    // GET /apps/{appId}/data/records
    if (method === "GET" && subPath === "/data/records") {
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

    // POST /apps/{appId}/data/records
    if (method === "POST" && subPath === "/data/records") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        type?: string;
        fileName?: string;
        contentType?: string;
        fileBase64?: string;
        parentId?: string;
      };
      if (!body.type) return clientErr("type is required", 400);
      if (!body.fileBase64) return clientErr("fileBase64 is required — every record must be file-backed", 400);
      if (!body.contentType) return clientErr("contentType is required", 400);

      const now = clock.now();
      const fileBuffer = Buffer.from(body.fileBase64, "base64");
      const contentHash = createHash("sha256").update(fileBuffer).digest("hex");
      const objectStorageKey = dataRecordObjectKey(body.type, contentHash);
      await storage.put(objectStorageKey, fileBuffer, { contentType: body.contentType });

      const record: DataRecord = {
        id: generateId(),
        kind: "data",
        type: body.type,
        ownerId,
        originAppId: appId,
        createdAt: now,
        updatedAt: now,
        syncStatus: SyncStatus.Synced,
        deletedAt: null,
        version: 1,
        contentHash,
        objectStorageKey,
        mimeType: body.contentType,
        sizeBytes: fileBuffer.length,
        originalFilename: body.fileName ?? null,
        parentId: (body.parentId as DataRecord["parentId"]) ?? null,
      };
      await db.put(record);
      return ok({ record: recordToResponse(record) }, 201);
    }

    // POST /apps/{appId}/data/files?type=<typeId>
    // Writes raw bytes under shared/<typeId>/<shard>/<hash>. The app's IAM
    // role gates which shared/<typeId>/ prefixes it can write — the handler
    // does not re-check the manifest here.
    if (method === "POST" && subPath === "/data/files") {
      const typeId = query["type"];
      if (!typeId) return clientErr("type query param is required", 400);
      const headers = event.headers ?? {};
      const contentTypeHeader = headers["content-type"] ?? headers["Content-Type"] ?? "application/octet-stream";
      const mimeType = contentTypeHeader.split(";")[0]!.trim();
      const fileBuffer = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body ?? "", "binary");
      if (fileBuffer.length === 0) return clientErr("Request body must not be empty", 400);
      if (fileBuffer.length > 20_000_000) return clientErr("File too large (20 MB limit)", 413);
      const hex = createHash("sha256").update(fileBuffer).digest("hex");
      const key = dataRecordObjectKey(typeId, hex);
      await storage.put(key, fileBuffer, { contentType: mimeType });
      return ok({ key, contentHash: hex, mimeType, sizeBytes: fileBuffer.length });
    }

    // POST /apps/{appId}/data/records/:id/promote — promote an 'unknown' record to a typed record
    const promoteMatch = subPath.match(/^\/data\/records\/([^/]+)\/promote$/);
    if (promoteMatch && method === "POST") {
      const recordId = decodeURIComponent(promoteMatch[1]!);
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as { targetType?: string };
      if (!body.targetType) return clientErr("targetType is required", 400);

      const record = await db.get(recordId as StarkeepId);
      if (!record) return clientErr("Record not found", 404);
      if (record.type !== "unknown") return clientErr("Only 'unknown' records can be promoted", 409);

      const now = clock.now();
      const promoted: DataRecord = { ...record, type: body.targetType, updatedAt: now, version: record.version + 1 };
      await db.put(promoted);

      return ok({ record: recordToResponse(promoted) });
    }

    // GET /apps/{appId}/data/records/:id/file-url
    const fileUrlMatch = subPath.match(/^\/data\/records\/([^/]+)\/file-url$/);
    if (fileUrlMatch && method === "GET") {
      const id = decodeURIComponent(fileUrlMatch[1]!) as StarkeepId;
      const record = await db.get(id);
      if (!record) return clientErr("Record not found", 404);
      if (!record.objectStorageKey) return clientErr("Record has no attached file", 404);
      const expiresIn = parseInt(query["expiresIn"] ?? "3600", 10);
      const url = await storage.getSignedUrl!(record.objectStorageKey, { expiresIn });
      return ok({ url, source: "remote", mimeType: record.mimeType, sizeBytes: record.sizeBytes, expiresIn });
    }

    // GET|PUT|DELETE /apps/{appId}/data/records/:id
    const recordIdMatch = subPath.match(/^\/data\/records\/([^/]+)$/);
    if (recordIdMatch) {
      const id = decodeURIComponent(recordIdMatch[1]!) as StarkeepId;

      if (method === "GET") {
        const record = await db.get(id);
        if (!record) return clientErr("Record not found", 404);
        return ok({ record: recordToResponse(record) });
      }

      if (method === "PUT") {
        // Records are immutable apart from system mutations (promotion, sync,
        // tombstones). Editing user fields lives in app-specific data which is
        // out of scope; the PUT endpoint accepts only originalFilename and
        // parentId for now.
        const existing = await db.get(id);
        if (!existing) return clientErr("Record not found", 404);
        const body = event.body
          ? (JSON.parse(event.body) as { originalFilename?: string | null; parentId?: string | null })
          : null;
        if (!body) return clientErr("body is required", 400);
        const now = clock.now();
        const updated: DataRecord = {
          ...existing,
          originalFilename: body.originalFilename ?? existing.originalFilename,
          parentId: (body.parentId as DataRecord["parentId"]) ?? existing.parentId,
          updatedAt: now,
          version: existing.version + 1,
        };
        await db.put(updated);
        return ok({ record: recordToResponse(updated) });
      }

      if (method === "DELETE") {
        await db.delete(id);
        return ok({ deleted: true });
      }
    }

    // POST /apps/{appId}/sync/pull
    if (method === "POST" && subPath === "/sync/pull") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody);
      const appSyncableSource = await buildAppSyncableSource(clientFactory, auroraEndpoint, region);
      const transport = createInProcessSyncTransport({ databaseAdapter: db, clock, appSyncableSource });
      const response = await transport.pullChanges(body);
      return ok(response);
    }

    // POST /apps/{appId}/sync/push
    if (method === "POST" && subPath === "/sync/push") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody);
      const appSyncableSource = await buildAppSyncableSource(clientFactory, auroraEndpoint, region);
      const transport = createInProcessSyncTransport({ databaseAdapter: db, clock, appSyncableSource });
      const response = await transport.pushChanges(body);
      return ok(response);
    }

    return clientErr("Not found", 404);
  } catch (e) {
    // S3 AccessDenied surfaces when an app touches a key its per-app IAM role
    // can't reach — typically a write to shared/<typeId>/* for a type the
    // manifest only granted read access to. Map to 403 so callers can
    // distinguish a permission problem from an unexpected server fault.
    if (isAccessDenied(e)) {
      console.warn("Handler access denied:", (e as Error).message);
      return clientErr("AccessDenied", 403);
    }
    console.error("Handler error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

async function buildAppSyncableSource(
  clientFactory: AppDsqlClientFactory,
  hostname: string,
  region: string,
): Promise<{ namespaces: DsqlAppSyncableNamespaceStore; applier: DsqlAppSyncableApplier }> {
  const client = await clientFactory.createClient({ hostname, region });
  const namespaces = new DsqlAppSyncableNamespaceStore(client);
  await namespaces.load();
  const applier = new DsqlAppSyncableApplier(client, namespaces);
  return { namespaces, applier };
}

function isAccessDenied(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === "AccessDenied" || name === "Forbidden") return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 403;
}
