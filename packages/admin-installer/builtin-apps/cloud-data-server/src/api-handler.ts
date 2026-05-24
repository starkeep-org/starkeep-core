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
 *   AWS_REGION       — set automatically by Lambda runtime
 *
 * The CDS Lambda's broker capability is the cloud-data-server role's
 * "broker-power" inline policy + each per-app role trusting the CDS role
 * directly. AssumeRole is a single hop: Lambda exec role → per-app role.
 * Manager is not involved in the runtime data path.
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
  CORE_TYPES,
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
import { ok, clientErr, type APIGatewayEvent, type LambdaContext } from "./handler-utils.js";
import { loadAccessGrants, canRead, canWrite, type AccessGrants } from "./access-enforcer.js";

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

async function getAppCreds(appId: string, accountId: string): Promise<CachedCreds> {
  const cached = credentialCache.get(appId);
  if (cached && cached.expiresAt - Date.now() > CRED_REFRESH_BUFFER_MS) {
    return cached;
  }

  const stackPrefix = process.env.STACK_PREFIX;
  const region = process.env.AWS_REGION ?? "us-east-1";
  if (!stackPrefix) {
    throw new Error("STACK_PREFIX env var is required");
  }

  const appRoleArn = `arn:aws:iam::${accountId}:role/${stackPrefix}-app-${appId}-role`;

  // Single-hop AssumeRole: the CDS Lambda exec role's broker-power policy
  // permits sts:AssumeRole on ${prefix}-app-*, and every per-app role's
  // trust policy lists the CDS role as a principal. No Manager involvement.
  const sts = new STSClient({ region });
  const appResult = await sts.send(new AssumeRoleCommand({
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

// Account ID parsed from the Lambda invocation context's ARN. Lambda does not
// expose the function ARN as an env var — only the invocation context does
// (`context.invokedFunctionArn`), so the caller must thread it in.
function getAccountId(invokedFunctionArn: string): string {
  const arnParts = invokedFunctionArn.split(":");
  const accountId = arnParts[4];
  if (!accountId) {
    throw new Error(`Cannot parse account ID from invokedFunctionArn: ${invokedFunctionArn}`);
  }
  return accountId;
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

// Authorize an object-storage key against the caller's grants. Keys live in
// two namespaces (see packages/core/src/storage/object-keys.ts):
//   shared/<typeId>/<shard>/<hash>   — gated by per-type read/write grants
//   apps/<appId>/syncable/<...>      — owned by the named app; only that app
//                                       may touch it via its own files routes
function parseObjectKey(
  callerAppId: string,
  decodedKey: string,
  grants: AccessGrants,
  mode: "read" | "write",
): { ok: true } | { ok: false; status: number; message: string } {
  if (decodedKey.startsWith("shared/")) {
    const segments = decodedKey.split("/");
    if (segments.length < 4 || !segments[1] || !segments[2] || !segments[3]) {
      return { ok: false, status: 400, message: "Invalid shared key" };
    }
    const typeId = segments[1]!;
    const allowed = mode === "read" ? canRead(grants, typeId) : canWrite(grants, typeId);
    if (!allowed) return { ok: false, status: 403, message: "Forbidden" };
    return { ok: true };
  }
  if (decodedKey.startsWith("apps/")) {
    const segments = decodedKey.split("/");
    if (
      segments.length < 4 ||
      !segments[1] ||
      segments[2] !== "syncable" ||
      !segments[3]
    ) {
      return { ok: false, status: 400, message: "Invalid app-syncable key" };
    }
    if (segments[1] !== callerAppId) {
      return { ok: false, status: 403, message: "Forbidden (cross-app syncable key)" };
    }
    return { ok: true };
  }
  return { ok: false, status: 400, message: "Unknown key namespace" };
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

export async function handler(event: APIGatewayEvent, context: LambdaContext) {
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

    const accountId = getAccountId(context.invokedFunctionArn);
    const creds = await getAppCreds(appId, accountId);
    const { db, storage, clock, clientFactory, auroraEndpoint, region } = makeAdapters(appId, creds);

    await db.init();

    // Per-type read/write enforcement on shared.records. DSQL has no RLS and
    // the table is shared across every type, so we load the caller app's
    // grants once per request and gate both the records and sync paths below.
    const grantClient = await clientFactory.createClient({ hostname: auroraEndpoint, region });
    let grants: AccessGrants;
    try {
      grants = await loadAccessGrants(grantClient, appId);
    } finally {
      await grantClient.end();
    }

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
      if (grants.readableTypes.size === 0) return ok({ types: [], total: 0 });
      const result = await db.query({
        filters: [{ field: "type", operator: "in", value: [...grants.readableTypes] }],
        limit: 10000,
      });
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

      // Per-type read enforcement. An explicit ?type= must be in the caller's
      // readable set; otherwise constrain the scan to readable types.
      if (type !== undefined) {
        if (!canRead(grants, type)) return clientErr("Forbidden", 403);
      } else if (grants.readableTypes.size === 0) {
        return ok({ records: [], hasMore: false, nextCursor: null });
      }

      const filters: { field: string; operator: "gt" | "in"; value: string | string[] }[] = [];
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
      if (type === undefined) {
        filters.push({ field: "type", operator: "in", value: [...grants.readableTypes] });
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
      if (!canWrite(grants, body.type)) return clientErr("Forbidden", 403);

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
      if (!canWrite(grants, typeId)) return clientErr("Forbidden", 403);
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

    // POST /apps/{appId}/files/presign — issue a presigned S3 PUT URL.
    // Body: { key, contentType? }. The local-data-server's HttpObjectStorageAdapter
    // uploads directly to S3 with the returned URL, bypassing API Gateway size limits.
    if (method === "POST" && subPath === "/files/presign") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as { key?: string; contentType?: string };
      if (!body.key) return clientErr("key is required", 400);
      const check = parseObjectKey(appId, body.key, grants, "write");
      if (!check.ok) return clientErr(check.message, check.status);
      const url = await storage.getSignedPutUrl!(body.key, {
        expiresIn: 3600,
        ...(body.contentType ? { contentType: body.contentType } : {}),
      });
      return ok({ url });
    }

    // GET /apps/{appId}/files/{encodedKey}/presign — presigned S3 GET URL.
    // The caller URL-encodes the full storage key (slashes become %2F) so it
    // arrives as a single path segment.
    const filePresignGetMatch = subPath.match(/^\/files\/([^/]+)\/presign$/);
    if (filePresignGetMatch && method === "GET") {
      const key = decodeURIComponent(filePresignGetMatch[1]!);
      const check = parseObjectKey(appId, key, grants, "read");
      if (!check.ok) return clientErr(check.message, check.status);
      const exists = await storage.has(key);
      if (!exists) return clientErr("Not found", 404);
      const url = await storage.getSignedUrl!(key, { expiresIn: 3600 });
      return ok({ url });
    }

    // HEAD|DELETE /apps/{appId}/files/{encodedKey}
    const fileObjectMatch = subPath.match(/^\/files\/([^/]+)$/);
    if (fileObjectMatch && method === "HEAD") {
      const key = decodeURIComponent(fileObjectMatch[1]!);
      const check = parseObjectKey(appId, key, grants, "read");
      if (!check.ok) return { statusCode: check.status, body: "" };
      const exists = await storage.has(key);
      return { statusCode: exists ? 200 : 404, body: "" };
    }
    if (fileObjectMatch && method === "DELETE") {
      const key = decodeURIComponent(fileObjectMatch[1]!);
      const check = parseObjectKey(appId, key, grants, "write");
      if (!check.ok) return clientErr(check.message, check.status);
      await storage.delete(key);
      return ok({ ok: true });
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
      // Promotion is a read of `unknown` (gated by canPromoteFromUnknown) plus
      // a write of the target type (gated by the normal writable set).
      if (!canRead(grants, "unknown")) return clientErr("Forbidden", 403);
      if (!canWrite(grants, body.targetType)) return clientErr("Forbidden", 403);

      const now = clock.now();
      const promoted: DataRecord = { ...record, type: body.targetType, updatedAt: now, version: record.version + 1 };
      await db.put(promoted);

      return ok({ record: recordToResponse(promoted) });
    }

    // POST /apps/{appId}/data/records/:id/metadata — write type-specific metadata.
    // The calling app does the extraction (e.g. EXIF); the server validates keys
    // against the declared type schema and persists via the database adapter.
    const metadataWriteMatch = subPath.match(/^\/data\/records\/([^/]+)\/metadata$/);
    if (metadataWriteMatch && method === "POST") {
      const recordId = decodeURIComponent(metadataWriteMatch[1]!) as StarkeepId;
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const { typeId, metadata } = JSON.parse(rawBody) as { typeId?: string; metadata?: Record<string, unknown> };
      if (!typeId) return clientErr("typeId is required", 400);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return clientErr("metadata must be an object", 400);
      }
      const coreType = CORE_TYPES.find((t) => t.id === typeId);
      if (!coreType) return clientErr(`Unknown type "${typeId}" — only core types support metadata`, 400);
      // Writing metadata for a type counts as writing that type — gate on the
      // caller's writable set. PG GRANTs back this up at the metadata table.
      if (!canWrite(grants, typeId)) return clientErr("Forbidden", 403);
      const allowedColumns = new Set(coreType.metadataColumns.map((c) => c.name));
      const unknownKeys = Object.keys(metadata).filter((k) => !allowedColumns.has(k));
      if (unknownKeys.length > 0) {
        return clientErr(`Unknown metadata columns: ${unknownKeys.join(", ")}`, 400);
      }
      await db.putMetadata(typeId, { recordId, ...metadata });
      return ok({ ok: true });
    }

    // GET /apps/{appId}/data/records/:id/metadata/:typeId — read type-specific metadata.
    const metadataReadMatch = subPath.match(/^\/data\/records\/([^/]+)\/metadata\/([^/]+)$/);
    if (metadataReadMatch && method === "GET") {
      const recordId = decodeURIComponent(metadataReadMatch[1]!) as StarkeepId;
      const typeId = decodeURIComponent(metadataReadMatch[2]!);
      if (!canRead(grants, typeId)) return clientErr("Forbidden", 403);
      const metadata = await db.getMetadata(typeId, recordId);
      return ok({ metadata });
    }

    // GET /apps/{appId}/data/records/:id/file-url
    const fileUrlMatch = subPath.match(/^\/data\/records\/([^/]+)\/file-url$/);
    if (fileUrlMatch && method === "GET") {
      const id = decodeURIComponent(fileUrlMatch[1]!) as StarkeepId;
      const record = await db.get(id);
      if (!record) return clientErr("Record not found", 404);
      if (!canRead(grants, record.type)) return clientErr("Forbidden", 403);
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
        if (!canRead(grants, record.type)) return clientErr("Forbidden", 403);
        return ok({ record: recordToResponse(record) });
      }

      if (method === "PUT") {
        // Records are immutable apart from system mutations (promotion, sync,
        // tombstones). Editing user fields lives in app-specific data which is
        // out of scope; the PUT endpoint accepts only originalFilename and
        // parentId for now.
        const existing = await db.get(id);
        if (!existing) return clientErr("Record not found", 404);
        if (!canWrite(grants, existing.type)) return clientErr("Forbidden", 403);
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
        const existing = await db.get(id);
        if (!existing) return clientErr("Record not found", 404);
        if (!canWrite(grants, existing.type)) return clientErr("Forbidden", 403);
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
    //
    // Sync push replays records produced by the local data server under the
    // *originating* app's IAM identity, not the caller's. We group incoming
    // record changes by `originAppId`, re-assume that role per group via the
    // broker capability on this Lambda's app role, and apply each group with
    // its own STS-assumed credentials. Records whose origin app is not
    // installed in the cloud are rejected with 409 — never silently written
    // under any other identity. Records of type `unknown` require the origin
    // role to hold canIngestUnknown (access_grants), otherwise 403.
    if (method === "POST" && subPath === "/sync/push") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        changes?: Array<{ recordSnapshot: DataRecord } & Record<string, unknown>>;
        appSyncableRows?: Array<{ appId: string } & Record<string, unknown>>;
      };

      // Group record changes by originAppId, validate every group, and only
      // start applying once all groups have been validated. This makes the
      // 409/403 path observable to callers without partial application.
      const changesByOrigin = new Map<string, typeof body.changes>();
      for (const change of body.changes ?? []) {
        const originAppId = change.recordSnapshot?.originAppId;
        if (!originAppId) return clientErr("change.recordSnapshot.originAppId is required", 400);
        const arr = changesByOrigin.get(originAppId) ?? [];
        arr.push(change);
        changesByOrigin.set(originAppId, arr);
      }

      // Validate each origin can be assumed and has the needed grants.
      type OriginContext = {
        creds: CachedCreds;
        grants: AccessGrants;
      };
      const originContexts = new Map<string, OriginContext>();
      for (const [originAppId, group] of changesByOrigin) {
        let originCreds: CachedCreds;
        try {
          originCreds = await getAppCreds(originAppId, accountId);
        } catch (err) {
          if (isUninstalledOriginError(err)) {
            return clientErr(`originAppId "${originAppId}" is not installed`, 409);
          }
          throw err;
        }
        const originAdapters = makeAdapters(originAppId, originCreds);
        const grantClient = await originAdapters.clientFactory.createClient({
          hostname: originAdapters.auroraEndpoint,
          region: originAdapters.region,
        });
        let originGrants: AccessGrants;
        try {
          originGrants = await loadAccessGrants(grantClient, originAppId);
        } finally {
          await grantClient.end();
        }
        // Type=unknown records require canIngestUnknown on the origin role.
        for (const change of group ?? []) {
          const recordType = change.recordSnapshot?.type;
          if (recordType === "unknown" && !canWrite(originGrants, "unknown")) {
            return clientErr(
              `originAppId "${originAppId}" cannot ingest type=unknown`,
              403,
            );
          }
          // Defense-in-depth: every record's type must be writable for its origin.
          if (typeof recordType === "string" && !canWrite(originGrants, recordType)) {
            return clientErr(
              `originAppId "${originAppId}" is not writable for type "${recordType}"`,
              403,
            );
          }
        }
        originContexts.set(originAppId, { creds: originCreds, grants: originGrants });
      }

      // Apply per-origin record changes under each origin's STS-assumed db.
      // App-syncable rows ride along with their declared appId; we keep them
      // on the caller-scoped transport since they're already gated by the
      // applier's namespace check (see in-process-transport.ts).
      const accepted: string[] = [];
      const rejected: unknown[] = [];
      let latestTimestamp = { wallTime: 0, counter: 0, nodeId: "" };
      for (const [originAppId, group] of changesByOrigin) {
        const ctx = originContexts.get(originAppId)!;
        const originAdapters = makeAdapters(originAppId, ctx.creds);
        await originAdapters.db.init();
        const originAppSyncableSource = await buildAppSyncableSource(
          originAdapters.clientFactory,
          originAdapters.auroraEndpoint,
          originAdapters.region,
        );
        const originTransport = createInProcessSyncTransport({
          databaseAdapter: originAdapters.db,
          clock: originAdapters.clock,
          appSyncableSource: originAppSyncableSource,
        });
        const partial = await originTransport.pushChanges({ changes: group ?? [] } as never);
        accepted.push(...(partial.accepted as unknown as string[]));
        rejected.push(...(partial.rejected as unknown as unknown[]));
        if (
          partial.latestTimestamp.wallTime > latestTimestamp.wallTime ||
          (partial.latestTimestamp.wallTime === latestTimestamp.wallTime &&
            partial.latestTimestamp.counter > latestTimestamp.counter)
        ) {
          latestTimestamp = partial.latestTimestamp;
        }
      }

      // App-syncable rows still go via the caller's db (cheap path); the
      // applier enforces per-app namespace membership.
      if ((body.appSyncableRows ?? []).length > 0) {
        const appSyncableSource = await buildAppSyncableSource(clientFactory, auroraEndpoint, region);
        const transport = createInProcessSyncTransport({ databaseAdapter: db, clock, appSyncableSource });
        const partial = await transport.pushChanges({ changes: [], appSyncableRows: body.appSyncableRows } as never);
        if (
          partial.latestTimestamp.wallTime > latestTimestamp.wallTime ||
          (partial.latestTimestamp.wallTime === latestTimestamp.wallTime &&
            partial.latestTimestamp.counter > latestTimestamp.counter)
        ) {
          latestTimestamp = partial.latestTimestamp;
        }
      }

      return ok({ accepted, rejected, latestTimestamp });
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

/**
 * AssumeRole on a non-existent app role surfaces as a STS error. The local
 * data server may push records whose `originAppId` refers to an app that has
 * been uninstalled (or never installed in the cloud) — see the "Registered
 * but not deployed" section of permissions-gaps.md. We map those to 409 so
 * callers can distinguish them from a real auth failure on an existing role.
 */
function isUninstalledOriginError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  return name === "NoSuchEntityException" || name === "NoSuchEntity";
}

function isAccessDenied(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === "AccessDenied" || name === "Forbidden") return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 403;
}
