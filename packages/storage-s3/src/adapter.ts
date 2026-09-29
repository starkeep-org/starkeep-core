import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectTaggingCommand,
  RestoreObjectCommand,
} from "@aws-sdk/client-s3";
import type { PutObjectCommandInput } from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type {
  ByteRange,
  PutOptions,
  GetResult,
  ListOptions,
  ListResult,
  ObjectAvailability,
  ObjectFacts,
  PutStreamOptions,
  SignedUrlOptions,
  SignedPutUrlOptions,
} from "@starkeep/storage-adapter";
import type { S3ObjectStorageAdapterOptions } from "./types.js";

/**
 * The largest object one PutObject request may carry.
 *
 * Every object this adapter writes goes up in one request, because only a
 * single-request upload can carry a whole-object SHA-256. S3 stores a
 * multipart upload's SHA-256 as a composite over the parts, suffixed
 * `-<partCount>`, which is not the object's hash; full-object checksums for
 * multipart exist only for the CRC algorithms. Without a whole-object SHA-256
 * no node can prove the cloud holds a file, so "Free up space" could never
 * free it. The presigned uploads devices use are single requests too, so this
 * is already the largest file the system can hold.
 */
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3;

function sha256Base64(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("base64");
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function tooLarge(key: string, bytes: number): Error {
  return new Error(
    `${key} is ${bytes} bytes; S3 takes at most ${MAX_SINGLE_PUT_BYTES} in one request, ` +
      "and only a single-request upload carries a whole-object SHA-256",
  );
}

export class S3ObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly options: S3ObjectStorageAdapterOptions;
  private client: S3Client | null = null;

  constructor(options: S3ObjectStorageAdapterOptions) {
    this.options = options;
  }

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: this.options.region,
        // When credentialProvider is set, pass it directly to the AWS SDK.
        // The SDK calls it before each signed request, so STS credentials
        // (e.g. from a Cognito Identity Pool) are always fresh.
        credentials: this.options.credentialProvider
          ? this.options.credentialProvider
          : this.options.credentials,
      });
    }
    return this.client;
  }

  private resolveKey(key: string): string {
    return `${this.options.keyPrefix ?? ""}${key}`;
  }

  async init(): Promise<void> {
    // No-op: S3 client is created lazily on first use
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getClient().send(
        new HeadBucketCommand({ Bucket: this.options.bucketName }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async put(
    key: string,
    data: Buffer | Uint8Array,
    options?: PutOptions,
  ): Promise<void> {
    const resolvedKey = this.resolveKey(key);
    const contentType = options?.contentType;

    if (data.byteLength > MAX_SINGLE_PUT_BYTES) throw tooLarge(key, data.byteLength);
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.options.bucketName,
        Key: resolvedKey,
        Body: data,
        ...(contentType ? { ContentType: contentType } : {}),
        ...(options?.metadata ? { Metadata: options.metadata } : {}),
        // Always a whole-object SHA-256: the caller's, or one computed here
        // from the bytes in hand. S3 rejects a body that doesn't match rather
        // than storing it, so a 200 means "S3 confirmed these bytes", and
        // `stat()` reports a checksum a node can prove a replica against.
        ChecksumSHA256: options?.checksumSha256 ?? sha256Base64(data),
      }),
    );
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const response = await this.getClient().send(
        new GetObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key),
          // S3's Range header is inclusive at both ends and an absent end means
          // "to the last byte" — the same shape as ByteRange, so this is a
          // formatting change and not a semantic one.
          ...(range
            ? { Range: `bytes=${range.start}-${range.end ?? ""}` }
            : {}),
        }),
      );
      if (!response.Body) return null;
      // The SDK hands back a Node Readable in this runtime; the adapter
      // contract is a web ReadableStream so the same interface is
      // implementable on React Native and in a browser. `transformToWebStream`
      // is the SDK's own conversion, so no bytes are buffered here.
      return (response.Body as { transformToWebStream(): ReadableStream<Uint8Array> })
        .transformToWebStream();
    } catch (error: unknown) {
      if (isMissingOrForbidden(error)) return null;
      throw error;
    }
  }

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: PutStreamOptions,
  ): Promise<void> {
    const resolvedKey = this.resolveKey(key);
    const base: PutObjectCommandInput = {
      Bucket: this.options.bucketName,
      Key: resolvedKey,
      ...(options?.contentType ? { ContentType: options.contentType } : {}),
      ...(options?.metadata ? { Metadata: options.metadata } : {}),
    };

    // A known length streams straight through in one request. With the
    // expected hash, S3 checks the whole object against it; without one, the
    // SDK computes a SHA-256 as the bytes pass and S3 stores it as a
    // whole-object checksum.
    if (options?.sizeBytes !== undefined) {
      if (options.sizeBytes > MAX_SINGLE_PUT_BYTES) throw tooLarge(key, options.sizeBytes);
      await this.getClient().send(
        new PutObjectCommand({
          ...base,
          Body: Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
          ContentLength: options.sizeBytes,
          ...(options.expectedSha256Hex
            ? { ChecksumSHA256: hexToBase64(options.expectedSha256Hex) }
            : { ChecksumAlgorithm: "SHA256" as const }),
        }),
      );
      return;
    }

    // An unknown length cannot be one request, so the bytes spool to a
    // temporary file while they hash, and go up from there with both.
    const dir = await mkdtemp(join(tmpdir(), "starkeep-s3-put-"));
    const path = join(dir, "body");
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
        async function* (source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            hash.update(chunk);
            bytes += chunk.byteLength;
            if (bytes > MAX_SINGLE_PUT_BYTES) throw tooLarge(key, bytes);
            yield chunk;
          }
        },
        createWriteStream(path),
      );
      const digest = hash.digest();
      if (options?.expectedSha256Hex && digest.toString("hex") !== options.expectedSha256Hex) {
        throw new Error(
          `${key}: the streamed bytes hash to ${digest.toString("hex")}, not ${options.expectedSha256Hex}`,
        );
      }
      await this.getClient().send(
        new PutObjectCommand({
          ...base,
          Body: createReadStream(path),
          ContentLength: bytes,
          ChecksumSHA256: digest.toString("base64"),
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async get(key: string): Promise<GetResult | null> {
    try {
      const response = await this.getClient().send(
        new GetObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key),
        }),
      );

      if (!response.Body) {
        return null;
      }

      const byteArray = await response.Body.transformToByteArray();
      const buffer = Buffer.from(byteArray);

      return {
        data: buffer,
        contentType: response.ContentType,
        size: buffer.length,
      };
    } catch (error: unknown) {
      if (isMissingOrForbidden(error)) {
        return null;
      }
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.getClient().send(
        new HeadObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key),
        }),
      );
      return true;
    } catch (error: unknown) {
      if (isMissingOrForbidden(error)) {
        // S3 returns 403 (Forbidden) instead of 404 to callers without
        // s3:ListBucket on the prefix — see the per-app permissions boundary
        // in data-roles-and-permissions.md, which intentionally withholds ListBucket
        // on shared/*. The two cases are indistinguishable from the SDK, so
        // treat both as "not present". A genuine permission problem will
        // surface clearly on the subsequent put/get of the same key.
        return false;
      }
      throw error;
    }
  }

  async stat(key: string): Promise<ObjectFacts | null> {
    let response;
    try {
      response = await this.getClient().send(
        new HeadObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key),
          // Without this S3 omits the stored checksum from the response even
          // when the object has one.
          ChecksumMode: "ENABLED",
        }),
      );
    } catch (error: unknown) {
      // Same 403-means-404 caveat as has(); see the comment there.
      if (isMissingOrForbidden(error)) return null;
      throw error;
    }

    // S3 omits StorageClass entirely for STANDARD.
    const storageClass = response.StorageClass ?? "STANDARD";
    return {
      sizeBytes: response.ContentLength ?? 0,
      checksumSha256: response.ChecksumSHA256 ?? null,
      storageClass,
      availability: availabilityOf(
        storageClass,
        response.ArchiveStatus ?? null,
        response.Restore ?? null,
      ),
      ...(response.ContentType ? { contentType: response.ContentType } : {}),
      ...(response.Metadata ? { metadata: response.Metadata } : {}),
    };
  }

  async setTags(key: string, tags: Record<string, string>): Promise<void> {
    await this.getClient().send(
      new PutObjectTaggingCommand({
        Bucket: this.options.bucketName,
        Key: this.resolveKey(key),
        Tagging: {
          TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        },
      }),
    );
  }

  async restoreObject(
    key: string,
    options: { tier: string; days: number },
  ): Promise<"started" | "already-in-progress"> {
    try {
      await this.getClient().send(
        new RestoreObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key),
          RestoreRequest: {
            Days: options.days,
            GlacierJobParameters: { Tier: options.tier as "Standard" | "Bulk" | "Expedited" },
          },
        }),
      );
      return "started";
    } catch (error: unknown) {
      // S3 reports an in-flight restore as an error, not a success. Treating it
      // as a failure would make the ordinary case of two clients asking at once
      // look broken, and would tempt a caller into retrying — which cannot help
      // and costs another request.
      if ((error as Error)?.name === "RestoreAlreadyInProgress") {
        return "already-in-progress";
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.getClient().send(
      new DeleteObjectCommand({
        Bucket: this.options.bucketName,
        Key: this.resolveKey(key),
      }),
    );
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const resolvedPrefix = this.resolveKey(prefix);
    const prefixOffset = (this.options.keyPrefix ?? "").length;

    const response = await this.getClient().send(
      new ListObjectsV2Command({
        Bucket: this.options.bucketName,
        Prefix: resolvedPrefix,
        MaxKeys: options?.limit,
        ContinuationToken: options?.cursor ?? undefined,
      }),
    );

    const keys = (response.Contents ?? []).map(
      (object) => (object.Key ?? "").slice(prefixOffset),
    );

    return {
      keys,
      nextCursor: response.NextContinuationToken ?? null,
      hasMore: response.IsTruncated ?? false,
    };
  }

  async getSignedUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string> {
    const expiresInSeconds = options?.expiresIn ?? 3600;
    const command = new GetObjectCommand({
      Bucket: this.options.bucketName,
      Key: this.resolveKey(key),
    });

    return awsGetSignedUrl(this.getClient(), command, {
      expiresIn: expiresInSeconds,
    });
  }

  async getSignedPutUrl(
    key: string,
    options?: SignedPutUrlOptions,
  ): Promise<string> {
    const expiresInSeconds = options?.expiresIn ?? 3600;
    const command = new PutObjectCommand({
      Bucket: this.options.bucketName,
      Key: this.resolveKey(key),
      ...(options?.contentType ? { ContentType: options.contentType } : {}),
      // Binds the permitted body into the signature: the holder of this URL
      // may write these exact bytes to this key and nothing else. S3 rejects a
      // mismatched body rather than storing it, so "200" becomes a statement
      // about the bytes and not just about the request.
      ...(options?.checksumSha256
        ? { ChecksumSHA256: options.checksumSha256 }
        : {}),
      ...(options?.storageClass
        ? { StorageClass: options.storageClass as PutObjectCommandInput["StorageClass"] }
        : {}),
      ...(options?.tagging ? { Tagging: encodeTagging(options.tagging) } : {}),
    });

    // An unsigned header is one the uploader can simply drop: it would upload
    // unverified bytes, into whichever storage class it liked, tagged however
    // it liked. Signing them makes sending the exact values mandatory.
    //
    // `signableHeaders` alone does NOT achieve that. The S3 presigner's default
    // is to *hoist* every `x-amz-*` header into the query string, which leaves
    // `SignedHeaders=host` — and a client that then sends the values as headers
    // (which is what "signed header" asks of it) gets a 403 from S3:
    //
    //   AccessDenied: There were headers present in the request which were not
    //   signed — x-amz-checksum-sha256, x-amz-storage-class
    //
    // `unhoistableHeaders` is what keeps them in the signature as headers. It
    // has to name the same set: hoisting wins otherwise, and the failure lands
    // on the uploader as an access error about permissions it does hold.
    const signableHeaders = new Set<string>();
    if (options?.checksumSha256) signableHeaders.add("x-amz-checksum-sha256");
    if (options?.storageClass) signableHeaders.add("x-amz-storage-class");
    if (options?.tagging) signableHeaders.add("x-amz-tagging");

    return awsGetSignedUrl(this.getClient(), command, {
      expiresIn: expiresInSeconds,
      ...(signableHeaders.size > 0
        ? { signableHeaders, unhoistableHeaders: new Set(signableHeaders) }
        : {}),
    });
  }
}

/**
 * Map HEAD's storage-class / archive-status / restore triple onto whether the
 * bytes can be read right now.
 *
 * The three inputs disagree in a way that matters: an Intelligent-Tiering
 * object reports `StorageClass: INTELLIGENT_TIERING` whether or not it has sunk
 * into an async archive tier — only `ArchiveStatus` says which. Reading storage
 * class alone would call a DEEP_ARCHIVE_ACCESS object instantly readable.
 *
 * (Our bucket must never enable I-T's async tiers, so `ArchiveStatus` should
 * always be absent in practice. It is handled anyway because "should" is doing
 * a lot of work there, and the failure mode of ignoring it is a read that hangs
 * for 12 hours.)
 */
function availabilityOf(
  storageClass: string,
  archiveStatus: string | null,
  restore: string | null,
): ObjectAvailability {
  const archivedTier =
    storageClass === "GLACIER" || storageClass === "DEEP_ARCHIVE"
      ? storageClass
      : archiveStatus === "ARCHIVE_ACCESS" || archiveStatus === "DEEP_ARCHIVE_ACCESS"
        ? archiveStatus
        : null;
  if (!archivedTier) return { state: "instant" };

  // Restore header forms:
  //   ongoing-request="true"                              → restore in flight
  //   ongoing-request="false", expiry-date="<http-date>"  → temporarily readable
  //   (absent)                                            → not restored
  if (restore) {
    if (/ongoing-request="true"/.test(restore)) {
      return { state: "restoring", readyAt: null };
    }
    if (/ongoing-request="false"/.test(restore)) {
      // A restored copy exists and is readable until its expiry. Callers that
      // care when it lapses read `storageClass`; for "can I read it now" the
      // answer is simply yes.
      return { state: "instant" };
    }
  }

  return {
    state: "archived",
    tier: archivedTier,
    // Standard-tier retrieval, which is what the restore flow requests. Bulk is
    // cheaper by hundredths of a cent and slower by a day and a half, so it is
    // only used for batch restores.
    expectedLatencyHours:
      archivedTier === "DEEP_ARCHIVE" || archivedTier === "DEEP_ARCHIVE_ACCESS" ? 12 : 5,
  };
}

/**
 * S3 takes object tags as a URL-encoded query string, not JSON.
 *
 * Encoded here rather than by callers because the keys involved contain a
 * colon (`starkeep:intent`), which survives naive concatenation and then fails
 * signature validation in a way that reports only "SignatureDoesNotMatch".
 */
function encodeTagging(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function isMissingOrForbidden(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name;
  if (name === "NoSuchKey" || name === "NotFound") return true;
  if (name === "Forbidden" || name === "AccessDenied") return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404 || status === 403;
}
