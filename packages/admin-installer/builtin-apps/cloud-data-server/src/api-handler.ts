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

import { createHash, randomUUID } from "node:crypto";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { AuroraDsqlDatabaseAdapter } from "@starkeep/storage-aurora-dsql";
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3";
import {
  generateId,
  createHLCClock,
  serializeHLC,
  deserializeHLC,
  appSyncableObjectKey,
  dataRecordObjectKey,
  categoryOf,
  getCategory,
  isCategoryId,
  KNOWN_EXTENSIONS,
} from "@starkeep/protocol-primitives";
import type { DataRecord, StarkeepId, HLCClock } from "@starkeep/protocol-primitives";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import {
  DsqlAppSyncableNamespaceStore,
  DsqlAppSyncableApplier,
} from "@starkeep/storage-aurora-dsql";
import { createAppSpecificFactory } from "@starkeep/shared-space-api";
import type { AppSpecificOperations } from "@starkeep/shared-space-api";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "@starkeep/storage-aurora-dsql";
import type { Filter } from "@starkeep/storage-adapter";
import { ok, clientErr, type APIGatewayEvent, type LambdaContext } from "./handler-utils.js";
import {
  loadAccessGrants,
  canRead,
  canWrite,
  canReadCategory,
  canWriteCategory,
  type AccessGrants,
} from "./access-enforcer.js";

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
      // Without an 'error' listener, an async socket failure (DSQL token
      // expiry, idle timeout, network blip) emits 'error' on the Client with
      // no handler → Node throws uncaughtException → the Lambda worker dies
      // mid-invocation and API Gateway returns its default 500. Attach a
      // no-op-with-log listener so socket errors stay async failures we can
      // surface in CloudWatch instead of process-killers.
      client.on("error", (err) => {
        console.warn("[cds] pg client async error:", (err as Error).message);
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

  return { db, storage, clientFactory, auroraEndpoint, region };
}

// Seed the cloud HLC clock from the highest cloud-stamped timestamp visible
// to this request's app role. Serialized HLCs sort lexically because the
// wall-time and counter components are zero-padded hex (see serializeHLC).
// Records with no cloud-stamped row return ZERO state; the wall clock will
// dominate going forward.
//
// Fragile invariant: the seed query is filtered by the caller's per-extension
// read grants (rows the assumed app role can SELECT). HLC correctness under
// LWW relies on "rows this request can affect" ⊆ "rows the seed reads". Today
// the only cloud-side write path is DELETE /data/records/{id} (tombstone),
// and an app can only delete rows of types it has write grants on — which
// implies it can also read them, so the set inclusion holds. If a future
// cloud write path is added that touches rows the caller cannot also SELECT
// (e.g. an admin endpoint, a cross-type cleanup pass, a sharing-token op),
// this seed will underestimate the true cloud max and let the new write
// mint a stamp lower than an existing cloud stamp on the same record.
// Per-Lambda-instance nodeId. The HLC clock requires nodeId to be unique
// per replica — using a literal "cloud" let two warm Lambda containers mint
// timestamps with the same (wallTime, counter, nodeId), violating ordering.
// AWS_LAMBDA_LOG_STREAM_NAME is set per execution-environment instance and
// stable across invocations within that env. Outside Lambda (local tests),
// fall back to a process-lifetime UUID so test runs still produce a stable
// id. The `cloud-` prefix lets makeCloudClock filter the records-table for
// any cloud replica's max stamp, regardless of which instance wrote it.
const CLOUD_NODE_ID = `cloud-${process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? randomUUID()}`;

async function makeCloudClock(client: DatabaseClient): Promise<HLCClock> {
  const result = await client.query(
    "SELECT updated_at FROM shared.records WHERE updated_at LIKE $1 ORDER BY updated_at DESC LIMIT 1",
    ["%:cloud-%"],
  );
  let initialState: { wallTime: number; counter: number } | undefined;
  if (result.rows.length > 0) {
    const row = result.rows[0] as { updated_at: string };
    const parsed = deserializeHLC(row.updated_at);
    initialState = { wallTime: parsed.wallTime, counter: parsed.counter };
  }
  return createHLCClock({
    nodeId: CLOUD_NODE_ID,
    wallClockFunction: Date.now,
    ...(initialState ? { initialState } : {}),
  });
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

// Mirrors CLOUD_APP_ID_RE in packages/admin-installer/src/iam.ts. Kept in sync
// by hand because the cloud handler lives in a separately-deployed artifact
// and cannot import from the installer package at runtime.
// The reserved app id of the Starkeep Drive (User-Data-Owner) channel — the
// single channel that carries all shared records. Mirrors
// USER_DATA_OWNER_APP_ID in packages/admin-installer/src/iam.ts; kept in sync by
// hand because this handler is a separately-deployed artifact.
const DRIVE_APP_ID = "starkeep-drive";

function parseAppPath(rawPath: string): { appId: string; subPath: string } | null {
  const match = rawPath.match(/^\/apps\/([a-z0-9][a-z0-9._-]*)(\/.*)?$/);
  if (!match) return null;
  return { appId: match[1]!, subPath: match[2] ?? "/" };
}

// Authorize an object-storage key against the caller's grants. Keys live in
// two namespaces (see packages/protocol-primitives/src/storage/object-keys.ts):
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
    // shared/<category>/<shard>/<hash> — the first segment is the derived
    // category (see object-keys.ts), so authorize at the category level.
    const category = segments[1]!;
    const allowed =
      mode === "read" ? canReadCategory(grants, category) : canWriteCategory(grants, category);
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
    category: categoryOf(record.type),
    created_at: new Date(record.createdAt.wallTime).toISOString(),
    updated_at: new Date(record.updatedAt.wallTime).toISOString(),
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
  // Track every DB client opened during this request so we can close them in
  // the finally below. Leaving clients open across Lambda freeze/thaw causes
  // their underlying TCP socket to fire 'error' on a later invocation, which
  // — combined with pg.Client's emit-or-throw default — has killed workers
  // mid-handler and made API Gateway return a default 500.
  const toClose: Array<() => Promise<void>> = [];
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
    const { db, storage, clientFactory, auroraEndpoint, region } = makeAdapters(appId, creds);

    await db.init();
    toClose.push(() => db.close());

    // Per-type read/write enforcement on shared.records. DSQL has no RLS and
    // the table is shared across every type, so we load the caller app's
    // grants once per request and gate both the records and sync paths below.
    // Also seed the cloud HLC clock from the highest cloud-stamped timestamp
    // visible on this request — same connection, one extra query.
    const grantClient = await clientFactory.createClient({ hostname: auroraEndpoint, region });
    let grants: AccessGrants;
    let clock: HLCClock;
    try {
      grants = await loadAccessGrants(grantClient, appId);
      clock = await makeCloudClock(grantClient);
    } finally {
      await grantClient.end();
    }

    const query = event.queryStringParameters ?? {};

    // Lazy per-request app-syncable source: needed by both /sync/exchange (the
    // per-app channel, not Drive) and /app-data/*. Build at most once; both
    // call sites share the same DSQL connection. The source's pg client gets
    // closed via toClose in the finally below.
    let appSyncableSource:
      | Awaited<ReturnType<typeof buildAppSyncableSource>>
      | null = null;
    async function getAppSyncableSource() {
      if (!appSyncableSource) {
        appSyncableSource = await buildAppSyncableSource(clientFactory, auroraEndpoint, region);
        toClose.push(() => appSyncableSource!.client.end());
      }
      return appSyncableSource;
    }

    // Lazy per-request app-specific view used by /app-data/*. Mirrors the
    // local-data-server's appSpecificFactory wiring (apps/local-data-server/
    // server.ts:429-439) — same shared-space-api factory, DSQL applier instead
    // of SQLite, S3 storage instead of local.
    //
    // We deliberately do NOT pass buildFileUrl: the factory's fileUrl() is
    // synchronous, but S3 presigning is async, so the GET /app-data/files
    // route below calls storage.getSignedUrl directly after the manifest gate.
    let appSpecificView: AppSpecificOperations | null | undefined;
    async function getAppSpecificView(): Promise<AppSpecificOperations | null> {
      if (appSpecificView !== undefined) return appSpecificView;
      const source = await getAppSyncableSource();
      const factory = createAppSpecificFactory({
        namespace: source.namespaces,
        applier: source.applier,
        fileStorage: storage,
        clock,
      });
      appSpecificView = factory({ subjectType: "app", subjectId: appId });
      return appSpecificView;
    }

    // Clamp a requested presigned-URL TTL (seconds) to the remaining STS
    // session lifetime minus a 30s safety buffer. Presigned URLs signed with
    // session credentials stop working when the session expires — capping
    // expiresIn here ensures the URL never outlives the credentials.
    function clampPresignExpiresIn(requested: number): number {
      const remainingSec = Math.floor((creds.expiresAt - Date.now()) / 1000) - 30;
      return Math.max(1, Math.min(requested, remainingSec));
    }

    // GET /apps/{appId}/health — app-scoped health check
    if (method === "GET" && subPath === "/health") {
      const dbHealthy = await db.healthCheck();
      const storageHealthy = await storage.healthCheck();
      return ok({ status: dbHealthy && storageHealthy ? "ok" : "degraded", db: dbHealthy, storage: storageHealthy });
    }

    // GET /apps/{appId}/data/types
    if (method === "GET" && subPath === "/data/types") {
      if (!grants.allAccess && grants.readableTypes.size === 0) return ok({ types: [], total: 0 });
      const filters: Filter[] = [{ field: "deletedAt", operator: "isNull" }];
      // Drive (allAccess) scans every type; others are constrained to their
      // readable extensions.
      if (!grants.allAccess) {
        filters.unshift({ field: "type", operator: "in", value: [...grants.readableTypes] });
      }
      const result = await db.query({ filters, limit: 10000 });
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
      } else if (!grants.allAccess && grants.readableTypes.size === 0) {
        return ok({ records: [], hasMore: false, nextCursor: null });
      }

      const filters: Filter[] = [{ field: "deletedAt", operator: "isNull" }];
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
      if (type === undefined && !grants.allAccess) {
        filters.push({ field: "type", operator: "in", value: [...grants.readableTypes] });
      }

      const result = await db.query({ type, filters, limit: limit + 1, cursor });
      const hasMore = result.records.length > limit;
      const records = hasMore ? result.records.slice(0, limit) : result.records;
      return ok({ records: records.map(recordToResponse), hasMore, nextCursor: hasMore ? records[records.length - 1].id : null });
    }

    // POST /apps/{appId}/data/records
    //
    // Body (key-ref form):
    //   { type, contentType, contentHash, sizeBytes, fileName?, parentId? }
    //
    // The caller PUTs the bytes to S3 via a presigned URL first (see POST
    // /files/presign), then registers the record by content-addressed key.
    if (method === "POST" && subPath === "/data/records") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as {
        type?: string;
        fileName?: string;
        contentType?: string;
        contentHash?: string;
        sizeBytes?: number;
        parentId?: string;
      };
      if (!body.type) return clientErr("type is required", 400);
      if (!body.contentType) return clientErr("contentType is required", 400);
      if (!canWrite(grants, body.type)) return clientErr("Forbidden", 403);
      if (!body.contentHash) {
        return clientErr(
          "contentHash is required — PUT the bytes via a presigned URL first, then register the record by content-addressed key",
          400,
        );
      }
      if (!/^[a-f0-9]{64}$/.test(body.contentHash)) {
        return clientErr("contentHash must be a 64-character lowercase hex sha256", 400);
      }
      if (typeof body.sizeBytes !== "number" || !Number.isFinite(body.sizeBytes) || body.sizeBytes < 0) {
        return clientErr("sizeBytes is required and must be a non-negative number", 400);
      }
      const contentHash = body.contentHash;
      const objectStorageKey = dataRecordObjectKey(body.type, contentHash);
      const sizeBytes = body.sizeBytes;
      const exists = await storage.has(objectStorageKey);
      if (!exists) {
        return clientErr(
          "Blob not found at the content-addressed key. PUT it via a presigned URL first.",
          409,
        );
      }

      // Dedup derived children (thumbnails) by (parentId, contentHash). A
      // byte-identical child of the same parent is a duplicate — e.g. two
      // concurrent /api/resize calls for one original. contentHash is part of
      // the key so distinct crops of the same source (same parent, different
      // bytes) are not collapsed. Idempotent: return the existing record.
      if (body.parentId) {
        const dup = await db.query({
          filters: [
            { field: "parentId", operator: "eq", value: body.parentId },
            { field: "contentHash", operator: "eq", value: contentHash },
            { field: "deletedAt", operator: "isNull" },
          ],
          limit: 1,
        });
        const existing = dup.records[0];
        if (existing) {
          return ok({ record: recordToResponse(existing) });
        }
      }

      const now = clock.now();
      const record: DataRecord = {
        id: generateId(),
        kind: "data",
        type: body.type,
        originAppId: appId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
        contentHash,
        objectStorageKey,
        mimeType: body.contentType,
        sizeBytes,
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
      // The blob lands at shared/<category>/…, so authorize the derived
      // category (the type param is normally an extension). Reject unknown
      // type ids up front rather than letting categoryOf's "other" fallback
      // silently coerce them — the caller's "other" grants would then gate
      // a misspelled type, which is a footgun.
      const normalizedExt = typeId.toLowerCase().replace(/^\./, "");
      if (!isCategoryId(typeId) && !KNOWN_EXTENSIONS.has(normalizedExt)) {
        return clientErr(`Unknown type id: ${typeId}`, 400);
      }
      const fileCategory = isCategoryId(typeId) ? typeId : categoryOf(typeId);
      if (!canWriteCategory(grants, fileCategory)) return clientErr("Forbidden", 403);
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
    // The caller URL-encodes the storage key, but API Gateway HTTP API
    // normalizes %2F back to "/" before forwarding to Lambda, so the captured
    // segment must allow embedded slashes (object keys are multi-segment, e.g.
    // shared/image/<shard>/<hash>).
    const filePresignGetMatch = subPath.match(/^\/files\/(.+)\/presign$/);
    if (filePresignGetMatch && method === "GET") {
      const key = decodeURIComponent(filePresignGetMatch[1]!);
      const check = parseObjectKey(appId, key, grants, "read");
      if (!check.ok) return clientErr(check.message, check.status);
      const exists = await storage.has(key);
      if (!exists) return clientErr("Not found", 404);
      const url = await storage.getSignedUrl!(key, { expiresIn: 3600 });
      return ok({ url });
    }

    // HEAD|DELETE /apps/{appId}/files/{encodedKey} — same multi-segment key
    // handling as the presign route above.
    const fileObjectMatch = subPath.match(/^\/files\/(.+)$/);
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

    // POST /apps/{appId}/data/records/:id/metadata — write metadata.
    // The calling app does the extraction (e.g. EXIF); the server validates keys
    // against the per-category schema and persists via the database adapter.
    // `typeId` is the record's extension (or a category id); the metadata table
    // is the derived category's. `other` has no metadata table.
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
      // Metadata tables are per-category, so gate on the caller's writable
      // categories (derived from its extension grants). PG GRANTs back this up
      // at the per-category metadata table.
      const category = isCategoryId(typeId) ? typeId : categoryOf(typeId);
      if (!canWriteCategory(grants, category)) return clientErr("Forbidden", 403);
      if (category === "other") {
        return clientErr(`Category "other" has no metadata table`, 400);
      }
      const categoryDef = getCategory(category)!;
      const allowedColumns = new Set(categoryDef.metadataColumns.map((c) => c.name));
      const unknownKeys = Object.keys(metadata).filter((k) => !allowedColumns.has(k));
      if (unknownKeys.length > 0) {
        return clientErr(`Unknown metadata columns: ${unknownKeys.join(", ")}`, 400);
      }
      await db.putMetadata(category, { recordId, ...metadata });
      return ok({ ok: true });
    }

    // GET /apps/{appId}/data/records/:id/metadata/:typeId — read metadata.
    const metadataReadMatch = subPath.match(/^\/data\/records\/([^/]+)\/metadata\/([^/]+)$/);
    if (metadataReadMatch && method === "GET") {
      const recordId = decodeURIComponent(metadataReadMatch[1]!) as StarkeepId;
      const typeId = decodeURIComponent(metadataReadMatch[2]!);
      const category = isCategoryId(typeId) ? typeId : categoryOf(typeId);
      if (!canReadCategory(grants, category)) return clientErr("Forbidden", 403);
      if (category === "other") return ok({ metadata: null });
      const metadata = await db.getMetadata(category, recordId);
      return ok({ metadata });
    }

    // GET /apps/{appId}/data/records/:id/file-url
    const fileUrlMatch = subPath.match(/^\/data\/records\/([^/]+)\/file-url$/);
    if (fileUrlMatch && method === "GET") {
      const id = decodeURIComponent(fileUrlMatch[1]!) as StarkeepId;
      const record = await db.get(id);
      if (!record || record.deletedAt) return clientErr("Record not found", 404);
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
        if (!record || record.deletedAt) return clientErr("Record not found", 404);
        if (!canRead(grants, record.type)) return clientErr("Forbidden", 403);
        return ok({ record: recordToResponse(record) });
      }

      if (method === "PUT") {
        // Records are immutable apart from system mutations (promotion, sync,
        // tombstones). Editing user fields lives in app-specific data which is
        // out of scope; the PUT endpoint accepts only originalFilename and
        // parentId for now.
        const existing = await db.get(id);
        if (!existing || existing.deletedAt) return clientErr("Record not found", 404);
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
        if (!existing || existing.deletedAt) return clientErr("Record not found", 404);
        if (!canWrite(grants, existing.type)) return clientErr("Forbidden", 403);
        await db.delete(id, clock.now());
        return ok({ deleted: true });
      }
    }

    // ---- App-specific syncable data (mirrors local-data-server) ----
    // All /app-data/... routes are scoped to the caller's appId (resolved
    // from the path prefix above). The factory's view refuses ops on tables/
    // files the app didn't declare; absence of the namespace means the app
    // didn't declare appSpecificSyncable in its manifest.
    if (subPath.startsWith("/app-data/")) {
      const view = await getAppSpecificView();
      if (!view) {
        return clientErr("App did not declare appSpecificSyncable in its manifest", 404);
      }

      const dbMatch = subPath.match(/^\/app-data\/db\/([^/]+)$/);
      if (dbMatch) {
        const table = decodeURIComponent(dbMatch[1]!);
        try {
          if (method === "POST") {
            const raw = event.isBase64Encoded && event.body
              ? Buffer.from(event.body, "base64").toString("utf8")
              : (event.body ?? "{}");
            const body = JSON.parse(raw) as { row?: Record<string, unknown> };
            if (!body.row) return clientErr("row is required", 400);
            await view.insertRow(table, body.row);
            return ok({ ok: true });
          }
          if (method === "PATCH") {
            const raw = event.isBase64Encoded && event.body
              ? Buffer.from(event.body, "base64").toString("utf8")
              : (event.body ?? "{}");
            const body = JSON.parse(raw) as {
              where?: Record<string, unknown>;
              patch?: Record<string, unknown>;
            };
            if (!body.where || !body.patch) {
              return clientErr("where and patch are required", 400);
            }
            const changes = await view.updateRow(table, body.where, body.patch);
            return ok({ changes });
          }
          if (method === "DELETE") {
            const raw = event.isBase64Encoded && event.body
              ? Buffer.from(event.body, "base64").toString("utf8")
              : (event.body ?? "{}");
            const body = JSON.parse(raw) as { where?: Record<string, unknown> };
            if (!body.where) return clientErr("where is required", 400);
            const changes = await view.deleteRow(table, body.where);
            return ok({ changes });
          }
          if (method === "GET") {
            const where: Record<string, unknown> = { ...query };
            const rows = await view.queryRows(table, Object.keys(where).length ? where : undefined);
            return ok({ rows });
          }
        } catch (err) {
          return clientErr(err instanceof Error ? err.message : String(err), 400);
        }
        return clientErr("Method not allowed", 405);
      }

      const fileMatch = subPath.match(/^\/app-data\/files\/(.+)$/);
      if (fileMatch) {
        const subKey = decodeURIComponent(fileMatch[1]!);
        try {
          if (method === "PUT") {
            if (!event.body) return clientErr("Request body must not be empty", 400);
            const bytes = event.isBase64Encoded
              ? Buffer.from(event.body, "base64")
              : Buffer.from(event.body, "utf8");
            if (bytes.length === 0) return clientErr("Request body must not be empty", 400);
            if (bytes.length > 20_000_000) return clientErr("File too large (20 MB limit)", 413);
            const mimeType = (event.headers?.["content-type"]
              ?? event.headers?.["Content-Type"]
              ?? "application/octet-stream").split(";")[0]!.trim();
            const result = await view.putFile(
              subKey,
              bytes as unknown as Uint8Array,
              mimeType,
            );
            return ok(result);
          }
          if (method === "GET") {
            // Manifest gate + key construction live in the factory; we use
            // getFile (which enforces filesEnabled and the per-app key prefix)
            // to verify existence, then presign directly because the factory's
            // fileUrl is sync and S3 presigning is async.
            const file = await view.getFile(subKey);
            if (!file) return clientErr("File not found", 404);
            const requested = parseInt(query["expiresIn"] ?? "3600", 10);
            const expiresIn = clampPresignExpiresIn(
              Number.isFinite(requested) ? requested : 3600,
            );
            const objectKey = appSyncableObjectKey(appId, subKey);
            const url = await storage.getSignedUrl(objectKey, { expiresIn });
            return ok({ url, expiresIn });
          }
          if (method === "DELETE") {
            await view.deleteFile(subKey);
            return ok({ ok: true });
          }
        } catch (err) {
          return clientErr(err instanceof Error ? err.message : String(err), 400);
        }
        return clientErr("Method not allowed", 405);
      }

      return clientErr("Not found", 404);
    }

    // POST /apps/{appId}/sync/exchange — version-vector exchange.
    // Body: SyncExchangeRequest. Writes go under the calling channel's
    // identity; PG GRANTs gate which types this channel can write. No
    // originAppId-grouping (deprecated under the exchange protocol).
    if (method === "POST" && subPath === "/sync/exchange") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody);

      // Channel split. The Starkeep Drive channel carries *all* shared
      // records (and nothing app-specific); every per-app channel carries only
      // that app's app-specific rows (and no shared records). This makes
      // shared-record sync identical regardless of which apps are cloud-
      // installed: the Drive channel always exists, so shared data always has
      // an authorized cloud writer.
      const isDriveChannel = appId === DRIVE_APP_ID;
      let transport;
      if (isDriveChannel) {
        transport = createInProcessSyncTransport({
          databaseAdapter: db,
          clock,
          objectStorage: storage,
          syncSharedRecords: true,
        });
      } else {
        const source = await getAppSyncableSource();
        transport = createInProcessSyncTransport({
          databaseAdapter: db,
          clock,
          appSyncableSource: source,
          objectStorage: storage,
          syncSharedRecords: false,
        });
      }
      const response = await transport.exchange(body);
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
  } finally {
    // Close every pg client we opened. Without this, sockets outlive the
    // handler, DSQL eventually closes them, and the resulting async 'error'
    // event arrives on a future invocation. Errors during close are
    // intentionally swallowed — at this point the handler has already
    // returned a response, and a failed .end() should not corrupt that.
    await Promise.allSettled(toClose.map((close) => close()));
  }
}

async function buildAppSyncableSource(
  clientFactory: AppDsqlClientFactory,
  hostname: string,
  region: string,
): Promise<{
  namespaces: DsqlAppSyncableNamespaceStore;
  applier: DsqlAppSyncableApplier;
  client: DatabaseClient;
}> {
  const client = await clientFactory.createClient({ hostname, region });
  const namespaces = new DsqlAppSyncableNamespaceStore(client);
  await namespaces.load();
  const applier = new DsqlAppSyncableApplier(client, namespaces);
  return { namespaces, applier, client };
}

function isAccessDenied(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === "AccessDenied" || name === "Forbidden") return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 403;
}
