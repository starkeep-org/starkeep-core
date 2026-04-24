/**
 * Photos Lambda handler — remote image thumbnail generation for the photos app.
 *
 * Handles POST /data/generate: fetches a source image from S3, runs sharp to
 * produce a downsize thumbnail, stores the result in S3, and upserts the
 * metadata record in Aurora DSQL so it becomes available via pullMetadata.
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
import { createHLCClock } from "@starkeep/core";
import type { StarkeepId } from "@starkeep/core";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "@starkeep/storage-aurora-dsql";
import { ok, clientErr, type APIGatewayEvent } from "./handler-utils.js";

// ---------------------------------------------------------------------------
// DSQL client factory using the Lambda execution role credentials
// ---------------------------------------------------------------------------

class LambdaDsqlClientFactory implements DatabaseClientFactory {
  async createClient(options: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    const { hostname, region } = options;

    const createPgClient = async (): Promise<pg.Client> => {
      const signer = new DsqlSigner({ hostname, region });
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

  const storage = new S3ObjectStorageAdapter({ bucketName: s3Bucket, region });

  const clock = createHLCClock({ nodeId: "cloud-photos-api", wallClockFunction: Date.now });

  adapters = { db, storage, clock };
  return adapters;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayEvent) {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;

    if (method === "OPTIONS") {
      return { statusCode: 200, body: "" };
    }

    // POST /data/generate — fetch source image from S3, run sharp, store thumbnail.
    if (method === "POST" && path === "/data/generate") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as { targetId?: string; generatorId?: string };
      if (!body.targetId || !body.generatorId) {
        return clientErr("targetId and generatorId are required", 400);
      }

      const { db, storage, clock } = await getAdapters();

      const record = await db.get(body.targetId as StarkeepId);
      if (!record) return clientErr("Record not found", 404);
      if (!record.objectStorageKey) return clientErr("Record has no attached file", 422);

      const downsizeMatch = body.generatorId.match(/^@starkeep\/image:downsize-(\d+)$/);
      if (!downsizeMatch) return clientErr(`Unsupported generatorId: ${body.generatorId}`, 400);
      const maxDimension = parseInt(downsizeMatch[1]!, 10);

      const sourceResult = await storage.get(record.objectStorageKey);
      if (!sourceResult) return clientErr("Source image not found in storage", 404);

      const { default: sharp } = await import("sharp") as { default: typeof import("sharp") };
      const inputBuffer = Buffer.from(
        sourceResult.data instanceof Uint8Array
          ? sourceResult.data
          : new Uint8Array(sourceResult.data as ArrayBuffer),
      );

      const meta = await sharp(inputBuffer).metadata();
      const hasAlpha = meta.hasAlpha ?? false;

      const resized = await sharp(inputBuffer)
        .resize(maxDimension, maxDimension, { fit: "inside", kernel: "cubic", withoutEnlargement: true })
        [hasAlpha ? "webp" : "jpeg"](hasAlpha ? { quality: 76 } : { quality: 85 })
        .toBuffer();

      const outputMeta = await sharp(resized).metadata();
      const format = hasAlpha ? "webp" : "jpeg";
      const mimeType = hasAlpha ? "image/webp" : "image/jpeg";

      const hash = createHash("sha256").update(new Uint8Array(resized)).digest("hex");
      const thumbnailKey = `metadata/${hash}`;
      await storage.put(thumbnailKey, resized, { contentType: mimeType });

      const now = clock.now();
      const metadataRecord = {
        targetId: body.targetId as StarkeepId,
        targetType: record.type,
        generatorId: body.generatorId,
        generatorVersion: 1,
        inputHash: null,
        updatedAt: now,
        value: {
          downsizeWidth: outputMeta.width ?? 0,
          downsizeHeight: outputMeta.height ?? 0,
          downsizeFormat: format,
        },
        objectStorageKey: thumbnailKey,
        contentHash: hash,
        mimeType,
        sizeBytes: resized.length,
      };
      await db.upsertSyncableMetadata(metadataRecord);

      return ok({ ok: true, metadata: metadataRecord });
    }

    return clientErr("Not found", 404);
  } catch (e) {
    console.error("Photos handler error:", e);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Internal server error" }) };
  }
}
