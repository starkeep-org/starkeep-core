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
import { generateId, createHLCClock, SyncStatus } from "@starkeep/core";
import type { DataRecord, StarkeepId } from "@starkeep/core";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "@starkeep/storage-aurora-dsql";

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

function ok(body: unknown, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function clientErr(message: string, status: number) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}

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
// API Gateway HTTP proxy event (v2 / HTTP API format)
// ---------------------------------------------------------------------------

interface APIGatewayEvent {
  rawPath: string;
  requestContext: {
    http: { method: string };
    authorizer?: {
      jwt?: { claims?: Record<string, string> };
    };
  };
  body?: string;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string>;
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

    // GET /data/records — list records with optional type filter and pagination
    if (method === "GET" && path === "/data/records") {
      const type = query["type"];
      const limit = Math.min(parseInt(query["limit"] ?? "50", 10), 500);
      const cursor = query["cursor"];
      const result = await db.query({ type, limit: limit + 1, cursor });
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
    // Body: { targetId, targetType, generatorId, generatorVersion?, value? }
    if (method === "POST" && path === "/data/metadata") {
      const body = event.body ? (JSON.parse(event.body) as {
        targetId?: string;
        targetType?: string;
        generatorId?: string;
        generatorVersion?: number;
        value?: Record<string, unknown>;
      }) : null;
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
      });
      return ok({ ok: true });
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

    return clientErr("Not found", 404);
  } catch (e) {
    console.error("Handler error:", e);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Internal server error" }) };
  }
}
