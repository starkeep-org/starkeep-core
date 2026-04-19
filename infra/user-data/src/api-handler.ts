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
      const limit = Math.min(parseInt(query["limit"] ?? "50", 10), 200);
      const cursor = query["cursor"];
      const result = await db.query({ type, limit: limit + 1, cursor });
      const hasMore = result.records.length > limit;
      const records = hasMore ? result.records.slice(0, limit) : result.records;
      return ok({ records, hasMore, nextCursor: hasMore ? records[records.length - 1].id : null });
    }

    // GET /data/records/:id
    const recordIdMatch = path.match(/^\/data\/records\/([^/]+)$/);
    if (recordIdMatch) {
      const id = decodeURIComponent(recordIdMatch[1]) as StarkeepId;

      if (method === "GET") {
        const record = await db.get(id);
        if (!record) return clientErr("Record not found", 404);
        return ok({ record });
      }

      if (method === "PUT") {
        const existing = await db.get(id);
        if (!existing) return clientErr("Record not found", 404);
        const body = event.body ? (JSON.parse(event.body) as { content?: Record<string, unknown> }) : null;
        if (!body?.content) return clientErr("content is required", 400);
        const now = clock.now();
        const updated: DataRecord = { ...existing, content: body.content, updatedAt: now, version: existing.version + 1 };
        await db.put(updated);
        return ok({ record: updated });
      }

      if (method === "DELETE") {
        await db.delete(id);
        return ok({ deleted: true });
      }
    }

    // POST /data/records — create a record
    if (method === "POST" && path === "/data/records") {
      const body = event.body ? (JSON.parse(event.body) as { type?: string; content?: Record<string, unknown> }) : null;
      if (!body?.type) return clientErr("type is required", 400);
      const now = clock.now();
      const record: DataRecord = {
        id: generateId(),
        kind: "data",
        type: body.type,
        content: body.content ?? {},
        ownerId,
        createdAt: now,
        updatedAt: now,
        syncStatus: SyncStatus.Synced,
        deletedAt: null,
        version: 1,
        contentHash: null,
        objectStorageKey: null,
        mimeType: null,
        sizeBytes: null,
        originalFilename: null,
      };
      await db.put(record);
      return ok({ record }, 201);
    }

    return clientErr("Not found", 404);
  } catch (e) {
    console.error("Handler error:", e);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Internal server error" }) };
  }
}
