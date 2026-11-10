/**
 * A web app's served build output: the files CloudFront answers from the app
 * assets bucket rather than from the app's Lambda.
 *
 * Every request that reaches a Lambda counts against the account's small
 * concurrency pool and must fit in a 6 MB response. A browser app loads tens
 * of build files per page, and a Flutter or WebAssembly build ships files
 * larger than that limit. So the platform serves two reserved prefixes,
 * `/apps/<appId>/_immutable/*` and `/apps/<appId>/_static/*`, from S3. The
 * installer copies `<assetsDir>/_immutable/` and `<assetsDir>/_static/` out
 * of `dist.zip` into `apps/<appId>/` in the bucket. CloudFront's request path
 * is the object key, so no rewrite sits between them.
 *
 * The objects carry the headers the local responder sends for the same file
 * (`createStaticResponder` in `@starkeep/app-client`), so a file behaves the
 * same on both surfaces.
 */

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { unzipSync } from "fflate";
import {
  publicPathCovers,
  SERVED_ASSET_PREFIXES,
  type AppManifest,
} from "@starkeep/admin-manifest";
import {
  contentTypeFor,
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
} from "@starkeep/app-client/web";
import type { AwsCredentials } from "./session";
import { retryOnAccessDenied } from "./retry-on-access-denied";

/**
 * The largest file the installer lets a Lambda serve. Lambda caps a response
 * at 6 MB and the web adapter base64-encodes a binary body, which leaves about
 * 4.5 MB. The check keeps a margin below that.
 */
export const MAX_LAMBDA_SERVED_FILE_BYTES = 4 * 1024 * 1024;

/** The deployment record's key under `apps/<appId>/`. CloudFront cannot read it. */
const DEPLOYMENTS_RECORD = ".deployments.json";

/** The app assets bucket the bootstrap stack creates. */
export function appAssetsBucketName(
  stackPrefix: string,
  accountId: string,
  region: string,
): string {
  return `${stackPrefix}-app-assets-${accountId}-${region}`;
}

export interface StaticAsset {
  /** The key under `apps/<appId>/`, for example `_immutable/app.3f2a.js`. */
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

/** A bundle the installer refuses before any install step runs. */
export class StaticAssetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticAssetsError";
  }
}

/**
 * Read the served files out of `dist.zip`, and refuse a bundle whose Lambda
 * would have to serve a file too large for a Lambda response.
 *
 * Only handlers that declare `assetsDir` contribute. The manifest schema
 * already refuses a handler whose `staticAssetPaths` reach a served prefix
 * without one.
 */
export function collectStaticAssets(manifest: AppManifest, zip: Uint8Array): StaticAsset[] {
  const handlers = manifest.infraRequirements.compute.handlers.filter(
    (h): h is typeof h & { assetsDir: string } => h.assetsDir !== undefined,
  );
  if (handlers.length === 0) return [];

  const oversize: string[] = [];
  const seenDirs = new Set<string>();
  const files = unzipSync(zip, {
    // Decide from the central directory, before decompressing: a file S3
    // serves is read, a file the Lambda serves is only measured, and anything
    // else is skipped.
    //
    // Only a path `staticAssetPaths` declares is served. CloudFront answers
    // the two prefixes for anyone, signed in or not, so an undeclared file
    // copied into the bucket would be an anonymous path the manifest never
    // named. A declared path is already one, because `publicPaths` must cover
    // every `staticAssetPaths` entry.
    filter: (file) => {
      if (file.name.endsWith("/")) return false;
      for (const handler of handlers) {
        const dir = `${handler.assetsDir}/`;
        if (!file.name.startsWith(dir)) continue;
        seenDirs.add(handler.assetsDir);
        const rel = file.name.slice(dir.length);
        const declared = handler.staticAssetPaths.some((p) => publicPathCovers(p, `/${rel}`));
        if (!declared) continue;
        const top = rel.split("/")[0] as (typeof SERVED_ASSET_PREFIXES)[number];
        if (SERVED_ASSET_PREFIXES.includes(top)) return true;
        if (file.originalSize > MAX_LAMBDA_SERVED_FILE_BYTES) {
          oversize.push(`${file.name} (${(file.originalSize / 1024 / 1024).toFixed(1)} MB)`);
        }
      }
      return false;
    },
  });

  for (const handler of handlers) {
    if (!seenDirs.has(handler.assetsDir)) {
      throw new StaticAssetsError(
        `Handler "${handler.name}" declares assetsDir "${handler.assetsDir}", but dist.zip ` +
          `has no files under ${handler.assetsDir}/. Check the bundle script's zip command.`,
      );
    }
  }
  if (oversize.length > 0) {
    throw new StaticAssetsError(
      `The app's Lambda would serve files larger than a Lambda response can carry: ` +
        `${oversize.join(", ")}. Move each one under _static/, or under _immutable/ with a ` +
        `content hash in its name. CloudFront serves those prefixes from S3, with no size ` +
        `limit and no Lambda invocation.`,
    );
  }

  const assets = new Map<string, StaticAsset>();
  for (const [name, body] of Object.entries(files)) {
    const handler = handlers.find((h) => name.startsWith(`${h.assetsDir}/`))!;
    const key = name.slice(handler.assetsDir.length + 1);
    // A zip entry name is author-controlled. CloudFront normalizes `..` and
    // empty segments out of a request path, so such a key could never be
    // served, and refusing it keeps every key a plain path under the prefix.
    if (key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new StaticAssetsError(`dist.zip entry "${name}" is not a plain relative path.`);
    }
    if (assets.has(key)) {
      throw new StaticAssetsError(
        `Two handlers' assetsDir both hold ${key}. Each served file must come from one handler.`,
      );
    }
    assets.set(key, {
      key,
      body,
      contentType: contentTypeFor(key),
      cacheControl: key.startsWith("_immutable/")
        ? IMMUTABLE_CACHE_CONTROL
        : REVALIDATE_CACHE_CONTROL,
    });
  }
  return [...assets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

interface DeploymentsRecord {
  current: string[];
  previous: string[];
}

function makeS3Client(creds: AwsCredentials, region: string): S3Client {
  return new S3Client({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

/** The bucket the bootstrap stack should have created is not there. */
export class MissingAppAssetsBucketError extends Error {
  constructor(bucket: string) {
    super(
      `The app assets bucket ${bucket} does not exist. Download the bootstrap template ` +
        `from admin-web and update the bootstrap stack in the CloudFormation console, then ` +
        `install again.`,
    );
    this.name = "MissingAppAssetsBucketError";
  }
}

/**
 * Name the bootstrap update when the bucket does not exist. The bucket comes
 * from the bootstrap stack, and a deployment created before it existed has to
 * update that stack by hand.
 */
function explainMissingBucket(bucket: string, err: unknown): never {
  if ((err as { name?: string })?.name === "NoSuchBucket") {
    throw new MissingAppAssetsBucketError(bucket);
  }
  throw err;
}

/** Each S3 action on a fresh temp policy propagates on its own; see retryOnAccessDenied. */
function s3Call<T>(label: string, bucket: string, fn: () => Promise<T>): Promise<T> {
  return retryOnAccessDenied(label, fn, { maxAttempts: 30, maxDelayMs: 10_000 }).catch((err) =>
    explainMissingBucket(bucket, err),
  );
}

async function readRecord(s3: S3Client, bucket: string, key: string): Promise<DeploymentsRecord> {
  try {
    const res = await s3Call(`s3:GetObject ${bucket}/${key}`, bucket, () =>
      s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
    );
    const parsed = JSON.parse((await res.Body?.transformToString()) ?? "{}") as
      | Partial<DeploymentsRecord>
      | undefined;
    return {
      current: Array.isArray(parsed?.current) ? parsed.current : [],
      previous: Array.isArray(parsed?.previous) ? parsed.previous : [],
    };
  } catch (err) {
    if ((err as { name?: string })?.name === "NoSuchKey") return { current: [], previous: [] };
    throw err;
  }
}

async function listKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3Call(`s3:ListBucket ${bucket}/${prefix}`, bucket, () =>
      s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      ),
    );
    for (const obj of page.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/**
 * Delete keys in batches of S3's 1,000-key cap. `DeleteObjects` reports a
 * refused key in its result rather than throwing, so the result is checked.
 */
async function deleteKeys(s3: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await s3Call(`s3:DeleteObject ${bucket}`, bucket, () =>
      s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      ),
    );
    const failed = res.Errors ?? [];
    if (failed.length > 0) {
      const first = failed[0]!;
      throw new Error(
        `Could not delete ${failed.length} object(s) from ${bucket}, starting with ` +
          `${first.Key}: ${first.Code} ${first.Message ?? ""}`.trim(),
      );
    }
  }
}

function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((k) => set.has(k));
}

/**
 * Put the app's served files in the bucket, then delete the files that
 * neither this deployment nor the one before it named.
 *
 * Runs before the compute stack changes, so a new shell never names a file
 * that is not there yet. The previous deployment's files stay one more round,
 * so a tab opened before the update can still load the code it asks for.
 *
 * Idempotent. A rerun of the same bundle after a failure keeps the record's
 * previous deployment, because the Lambda may still serve that deployment's
 * shell.
 */
export async function uploadStaticAssets(
  appId: string,
  bucket: string,
  assets: StaticAsset[],
  region: string,
  infraCreds: AwsCredentials,
): Promise<void> {
  const s3 = makeS3Client(infraCreds, region);
  const prefix = `apps/${appId}/`;
  const recordKey = `${prefix}${DEPLOYMENTS_RECORD}`;
  const record = await readRecord(s3, bucket, recordKey);

  const queue = [...assets];
  const worker = async (): Promise<void> => {
    for (let asset = queue.shift(); asset; asset = queue.shift()) {
      const key = `${prefix}${asset.key}`;
      const body = asset.body;
      await s3Call(`s3:PutObject ${bucket}/${key}`, bucket, () =>
        s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: asset.contentType,
            CacheControl: asset.cacheControl,
          }),
        ),
      );
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const current = assets.map((a) => a.key);
  const next: DeploymentsRecord = sameKeys(current, record.current)
    ? { current, previous: record.previous }
    : { current, previous: record.current };
  await s3Call(`s3:PutObject ${bucket}/${recordKey}`, bucket, () =>
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: recordKey,
        Body: JSON.stringify(next),
        ContentType: "application/json",
      }),
    ),
  );

  const keep = new Set([...next.current, ...next.previous].map((k) => `${prefix}${k}`));
  keep.add(recordKey);
  const stale = (await listKeys(s3, bucket, prefix)).filter((k) => !keep.has(k));
  await deleteKeys(s3, bucket, stale);
}

/** Delete everything under `apps/<appId>/` in the bucket. A missing bucket holds nothing. */
export async function deleteStaticAssets(
  appId: string,
  bucket: string,
  region: string,
  infraCreds: AwsCredentials,
): Promise<void> {
  const s3 = makeS3Client(infraCreds, region);
  let keys: string[];
  try {
    keys = await listKeys(s3, bucket, `apps/${appId}/`);
  } catch (err) {
    if (err instanceof MissingAppAssetsBucketError) return;
    throw err;
  }
  await deleteKeys(s3, bucket, keys);
}
