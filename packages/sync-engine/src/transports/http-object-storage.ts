import type {
  ByteRange,
  FilePartDigests,
  ObjectStorageAdapter,
  PutOptions,
  GetResult,
  ListOptions,
  ListResult,
  ObjectAvailability,
  ObjectFacts,
  PutStreamOptions,
} from "@starkeep/storage-adapter";
import {
  ChecksumMismatchError,
  FileUriTransferRefused,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  hashFactory,
  multipartPartSpan,
  partChecksumBase64,
  sha256Base64ToHex,
  verifyingStream,
} from "@starkeep/storage-adapter";
import type {
  PresignUploadAnswer,
  PresignUploadItem,
  PresignedPut,
  UploadBatchReport,
} from "../uploader.js";

/** Lowercase-hex SHA-256 of bytes in hand, with the platform's portable hasher. */
function hashHex(data: Uint8Array): string {
  const hash = hashFactory()();
  hash.update(data);
  return hash.digestHex();
}

/**
 * What the server hands back when it signs an upload.
 *
 * Every field except the URL is something the *server* decided and bound into
 * the signature: which bytes may be written there, which storage class they
 * land in, and which tags they carry. The client's job is to echo them exactly,
 * not to have opinions about them — which is why they arrive as values rather
 * than as parameters the client passes in.
 */
interface PresignResponse {
  readonly url: string;
  readonly checksumSha256?: string;
  readonly storageClass?: string;
  readonly tagging?: Record<string, string>;
}

/**
 * S3's own explanation of a failed PUT, as a suffix for the thrown message.
 *
 * A presigned PUT can fail 403 for reasons that demand opposite fixes —
 * `AccessDenied` is an IAM gap, `SignatureDoesNotMatch` is a header the
 * uploader dropped or encoded differently — and the status line alone cannot
 * tell them apart. S3 says which in the response body; throwing it away turns
 * a five-second diagnosis into an afternoon.
 *
 * Best-effort: a body that cannot be read must not replace the real error.
 */
async function s3ErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.text()).trim();
    if (!body) return "";
    // Collapsed to a single line: S3's error document is pretty-printed XML,
    // and a multi-line throw splits across log lines — where any per-line
    // prefix or filter keeps the first line ("<?xml version…") and discards
    // the <Code> that is the entire reason for reading it.
    const oneLine = body.replace(/\s+/g, " ");
    // Truncated because the Code and Message lead the document; the rest is
    // request-id boilerplate that would bury the line it came from.
    return ` — ${oneLine.slice(0, 500)}`;
  } catch {
    return "";
  }
}

/**
 * Turn a presign response into the headers the PUT must carry.
 *
 * These are mandatory when present, not optional extras: each one is inside the
 * signature, so omitting it fails the request rather than uploading something
 * unverified, untiered or untagged. That is the property being relied on —
 * the client cannot quietly drop one.
 */
function presignHeaders(response: {
  checksumSha256?: string;
  storageClass?: string;
  tagging?: Record<string, string>;
}): Record<string, string> {
  return {
    ...(response.checksumSha256 ? { "x-amz-checksum-sha256": response.checksumSha256 } : {}),
    ...(response.storageClass ? { "x-amz-storage-class": response.storageClass } : {}),
    ...(response.tagging && Object.keys(response.tagging).length > 0
      ? {
          // Same encoding the signer used. Tag keys contain a colon
          // (`starkeep:intent`), which survives naive concatenation and then
          // fails signature validation reporting only "SignatureDoesNotMatch".
          "x-amz-tagging": Object.entries(response.tagging)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&"),
        }
      : {}),
  };
}

export interface HttpObjectStorageAdapterOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Produce per-request auth headers from the HTTP method, the request path
   * (relative to the per-app mount, i.e. starting at `/files...` or `/health`),
   * and the serialized body bytes (the empty string for GET/HEAD/DELETE).
   * HMAC-signs the request for the cloud verifier; mirrors the shape
   * `@starkeep/app-client/sign.ts` emits (method/path/ts bound).
   */
  readonly signRequest?: (method: string, path: string, body: string) => Record<string, string>;
  /**
   * Send a file's bytes to a URL without reading them into JS.
   *
   * Supplying this turns on {@link ObjectStorageAdapter.putFromFileUri}; absent,
   * the adapter has no way to honour a file URI and does not claim to. Injected
   * for the same reason `fetch` and `signRequest` are: the only implementation
   * that matters is a platform one (expo-file-system's upload task on React
   * Native, which streams from a `ContentProviderFile`'s input stream), and this
   * package must not import it.
   *
   * Must not buffer the file. An implementation that reads the bytes and posts
   * them is worse than the stream path it is displacing, and silently so.
   */
  readonly uploadFile?: UploadFile;
  /**
   * The two ports a resumable multipart upload needs. With both, a file above
   * `MULTIPART_THRESHOLD_BYTES` goes up as fixed `MULTIPART_PART_BYTES` parts,
   * and an interrupted upload keeps every finished part. With either absent,
   * every file keeps the single PUT.
   */
  readonly hashFileParts?: HashFileParts;
  readonly uploadFileRange?: UploadFileRange;
  /**
   * Where each key's in-progress upload is remembered between attempts. The
   * default keeps it in memory, so a restart of the process starts the upload
   * over; a node that wants resumption across restarts supplies a durable one.
   */
  readonly multipartSessions?: MultipartSessionStore;
}

/**
 * Hash a file whole and in parts of `partBytes`, in one read.
 *
 * One read, so the part digests S3 checks and the whole-file digest the key
 * names describe the same bytes. Must not buffer the file.
 */
export type HashFileParts = (fileUri: string, partBytes: number) => Promise<FilePartDigests>;

/**
 * Send one byte range of a file to a URL without reading it into JS.
 *
 * Resolves for any completed response, as {@link UploadFile} does, plus the
 * response's `ETag`: completing a multipart upload names each part by it.
 */
export type UploadFileRange = (
  fileUri: string,
  range: { readonly offset: number; readonly length: number },
  url: string,
  init: { readonly method: "PUT"; readonly headers: Record<string, string> },
) => Promise<{ readonly status: number; readonly body: string; readonly etag: string | null }>;

/**
 * An upload in progress, as the uploader remembers it.
 *
 * The uploader keeps this rather than the cloud, because finding an upload by
 * key needs `s3:ListBucketMultipartUploads`, which no policy can narrow to one
 * user's keys. `partSha256Hex` pins the session to one version of the file: a
 * file whose bytes changed starts a new upload rather than mixing parts.
 */
export interface MultipartUploadSession {
  readonly uploadId: string;
  readonly partSha256Hex: readonly string[];
  /** ETag of each finished part, by part number. */
  readonly etags: Readonly<Record<string, string>>;
}

export interface MultipartSessionStore {
  get(key: string): Promise<MultipartUploadSession | null>;
  set(key: string, session: MultipartUploadSession): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The default store: resumes within one process, forgets on restart. */
export function inMemoryMultipartSessions(): MultipartSessionStore {
  const sessions = new Map<string, MultipartUploadSession>();
  return {
    get: async (key) => sessions.get(key) ?? null,
    set: async (key, session) => void sessions.set(key, session),
    delete: async (key) => void sessions.delete(key),
  };
}

interface MultipartPresignResponse {
  readonly uploadId: string;
  readonly parts: ReadonlyArray<{ readonly partNumber: number; readonly url: string }>;
}

/** S3 answers a part PUT for an upload it no longer holds with this code. */
function isNoSuchUpload(status: number, body: string): boolean {
  return status === 404 && body.includes("NoSuchUpload");
}

/**
 * One line per step of a multipart upload, under one prefix, so a device log
 * filtered on `[multipart]` reads as the upload's whole story.
 */
function multipartLog(key: string, message: string): void {
  console.log(`[multipart] ${key}: ${message}`);
}

function multipartWarn(key: string, message: string): void {
  console.warn(`[multipart] ${key}: ${message}`);
}

function throughput(bytes: number, ms: number): string {
  return ms > 0 ? `${(bytes / 1024 / 1024 / (ms / 1000)).toFixed(1)} MiB/s` : "instant";
}

function sameDigests(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((hex, i) => hex === b[i]);
}

/**
 * The platform uploader port. Resolves for any completed response, including a
 * non-2xx one — a 403 from S3 is a fact about the request, not a transport
 * failure, and the caller needs the body to tell which 403 it is.
 */
export type UploadFile = (
  fileUri: string,
  url: string,
  init: { readonly method: "PUT"; readonly headers: Record<string, string> },
) => Promise<{ readonly status: number; readonly body: string }>;

/**
 * Adapter that speaks `/files/:key` HTTP to a remote Starkeep sync server
 * (see sync-engine's createHttpSyncHandler).
 *
 * put() and get() bypass API Gateway by requesting presigned S3 URLs from the
 * server and transferring directly to/from S3. has() uses a lightweight HEAD
 * request through the API (no body, well within limits).
 */
export class HttpObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly signRequest?: (
    method: string,
    path: string,
    body: string,
  ) => Record<string, string>;

  /**
   * Present only when the caller supplied an uploader.
   *
   * Assigned rather than declared as a method because the capability is
   * genuinely conditional: `file-sync-engine` decides whether to offer a file
   * URI by asking whether this exists, and a method that was always there and
   * threw would make every phone transfer take a wrong turn before failing.
   */
  readonly putFromFileUri?: (
    key: string,
    fileUri: string,
    options?: PutStreamOptions,
  ) => Promise<void>;

  private readonly uploadFile: UploadFile | null;

  private readonly multipart: {
    readonly hashFileParts: HashFileParts;
    readonly uploadFileRange: UploadFileRange;
    readonly sessions: MultipartSessionStore;
  } | null;

  constructor(options: HttpObjectStorageAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.signRequest = options.signRequest;
    this.uploadFile = options.uploadFile ?? null;
    this.multipart =
      options.hashFileParts && options.uploadFileRange
        ? {
            hashFileParts: options.hashFileParts,
            uploadFileRange: options.uploadFileRange,
            sessions: options.multipartSessions ?? inMemoryMultipartSessions(),
          }
        : null;
    if (options.uploadFile) {
      const uploadFile = options.uploadFile;
      this.putFromFileUri = (key, fileUri, putOptions) => {
        const sizeBytes = putOptions?.sizeBytes;
        return this.multipart && sizeBytes !== undefined && sizeBytes > MULTIPART_THRESHOLD_BYTES
          ? this.sendFileInParts(this.multipart, key, fileUri, { ...putOptions, sizeBytes })
          : this.sendFile(uploadFile, key, fileUri, putOptions);
      };
    }
  }

  private url(key: string): string {
    return `${this.baseUrl}/${encodeURIComponent(key)}`;
  }

  // Base URL without the /files suffix, for presign endpoints.
  private apiBase(): string {
    return this.baseUrl.replace(/\/files$/, "");
  }

  // The signed path is logical (relative to the per-app mount) and decoded —
  // `/files/<key>` rather than the percent-encoded wire form — so it matches
  // the subPath the cloud verifier routes on after API Gateway normalizes it.
  private headers(
    method: string,
    path: string,
    body: string,
    extra?: Record<string, string>,
  ): Record<string, string> {
    return {
      ...(extra ?? {}),
      ...(this.signRequest?.(method, path, body) ?? {}),
    };
  }

  async init(): Promise<void> {
    /* no-op; remote is expected to be up */
  }

  async close(): Promise<void> {
    /* no-op */
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.apiBase()}/health`, {
        headers: this.headers("GET", "/health", ""),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Ask the server to sign an upload of this key. One round trip, shared by
   * every write path — the three of them must not drift in what they send, or a
   * PUT signed one way and issued another fails as `SignatureDoesNotMatch`.
   */
  private async presignPut(
    key: string,
    contentType: string | undefined,
    contentHash: string | undefined,
  ): Promise<PresignResponse> {
    // The hash goes with every request that knows it. A shared key names its
    // own hash and the server derives it; an app-syncable key does not, and
    // the server pins what the uploader declares, so every object S3 stores
    // carries a whole-object SHA-256.
    const presignBody = JSON.stringify({
      key,
      contentType,
      ...(contentHash ? { contentHash } : {}),
    });
    const presignRes = await this.fetchImpl(`${this.apiBase()}/files/presign`, {
      method: "POST",
      headers: this.headers("POST", "/files/presign", presignBody, {
        "Content-Type": "application/json",
      }),
      body: presignBody,
    });
    if (!presignRes.ok) {
      throw new Error(`presign PUT ${key} failed: ${presignRes.status} ${presignRes.statusText}`);
    }
    return (await presignRes.json()) as PresignResponse;
  }

  /**
   * Ask the cloud about a batch of uploads in one request: for each file,
   * whether it already holds the bytes, refuses them, or signs a PUT.
   *
   * One request in place of a HEAD and a presign per file. The answers come
   * back in the request's order. `report` is the uploader's account of its
   * own activity, which the cloud logs and does not act on.
   */
  async presignUploads(
    items: readonly PresignUploadItem[],
    report?: UploadBatchReport,
  ): Promise<PresignUploadAnswer[]> {
    const body = JSON.stringify({ items, ...(report ? { report } : {}) });
    const res = await this.fetchImpl(`${this.apiBase()}/files/presign-batch`, {
      method: "POST",
      headers: this.headers("POST", "/files/presign-batch", body, {
        "Content-Type": "application/json",
      }),
      body,
    });
    if (!res.ok) {
      throw new Error(
        `presign batch of ${items.length} failed: ${res.status} ${res.statusText}${await s3ErrorDetail(res)}`,
      );
    }
    const parsed = (await res.json()) as { answers?: PresignUploadAnswer[] };
    if (!Array.isArray(parsed.answers) || parsed.answers.length !== items.length) {
      throw new Error(
        `presign batch of ${items.length} answered ${parsed.answers?.length ?? "no"} items`,
      );
    }
    return parsed.answers;
  }

  /**
   * Whether a file this size goes up in parts from `source`: above the
   * multipart threshold, with the multipart ports configured and a file URI to
   * read the parts from. The parts path signs its own URLs, so the batch asks
   * only whether the cloud holds such a file.
   */
  sendsInParts(key: string, sizeBytes: number, source: ObjectStorageAdapter): boolean {
    return (
      this.multipart !== null &&
      this.putFromFileUri !== undefined &&
      sizeBytes > MULTIPART_THRESHOLD_BYTES &&
      (source.localFileUriFor?.(key) ?? null) !== null
    );
  }

  /**
   * Send a file to a URL the batch presign signed. The bytes go
   * platform-to-platform when the source names a file and this adapter has an
   * uploader, and as a verified stream otherwise, as `file-sync-engine.ts`
   * decides for a single transfer.
   */
  async uploadPresigned(
    key: string,
    signed: PresignedPut,
    source: ObjectStorageAdapter,
    options: PutStreamOptions,
  ): Promise<void> {
    const fileUri = source.localFileUriFor?.(key) ?? null;
    if (fileUri !== null && this.uploadFile) {
      try {
        await this.sendFile(this.uploadFile, key, fileUri, options, signed);
        return;
      } catch (err) {
        // Raised before a byte moved, so the stream below costs nothing extra.
        if (!(err instanceof FileUriTransferRefused)) throw err;
        console.warn(
          `[sync] ${key}: the file-URI upload was refused (${err.message}); sending it as a stream instead`,
        );
      }
    }
    const body = await source.getStream(key);
    if (!body) throw new Error(`${key} could not be read from this node`);
    try {
      await this.sendStream(key, body, signed, options);
    } catch (err) {
      await body.cancel().catch(() => {});
      throw err;
    }
  }

  /**
   * Upload a file the platform can read, without its bytes entering JS.
   *
   * See `ObjectStorageAdapter.putFromFileUri` for the contract, and the plan in
   * `photos-mobile/native-blob-transfer-plan.md` for why a phone needs it.
   */
  private async sendFile(
    uploadFile: UploadFile,
    key: string,
    fileUri: string,
    options?: PutStreamOptions,
    signed?: PresignedPut,
  ): Promise<void> {
    const presigned =
      signed ?? (await this.presignPut(key, options?.contentType, options?.expectedSha256Hex));

    // The one refusal, raised here — after the presign round trip and before a
    // single byte moves, which is exactly where the contract permits it.
    //
    // `putStream` verifies the digest in JS as the bytes pass. Nothing here
    // sees a byte, so the only thing that can make the same promise is S3
    // checking the checksum the server pinned into the signature. Without a
    // pin there is nobody to check, and quietly uploading unverified bytes
    // because the fast path was available would be the worst of the three
    // possible behaviours.
    if (options?.expectedSha256Hex && !presigned.checksumSha256) {
      throw new FileUriTransferRefused(
        key,
        "the caller asked for a whole-object SHA-256 and the server pinned no checksum, " +
          "so nothing would verify these bytes",
      );
    }

    const result = await uploadFile(fileUri, presigned.url, {
      method: "PUT",
      headers: {
        ...(options?.contentType ? { "Content-Type": options.contentType } : {}),
        ...presignHeaders(presigned),
        // No Content-Length: the uploader knows the file's length and sets it
        // from the request body. Sending it here would duplicate the header.
      },
    });
    if (result.status < 200 || result.status >= 300) {
      const detail = result.body.trim().replace(/\s+/g, " ").slice(0, 500);
      throw new Error(
        `S3 PUT ${key} from ${fileUri} failed: ${result.status}${detail ? ` — ${detail}` : ""}`,
      );
    }
  }

  /**
   * Upload a large file as fixed-size parts, resuming any upload this node
   * already started for the key.
   *
   * The file is hashed whole and in parts in one read, and the whole-file
   * digest must equal the hash the caller expects. That check is the only
   * link between the parts and the key: S3 verifies each part against its
   * pinned digest, but nothing in the cloud can tie the parts to the
   * whole-file hash without reading the object.
   *
   * Only parts the session lacks go up. A finished part's ETag is saved before
   * the next part starts, so an attempt aborted mid-file keeps its progress.
   * An upload S3 no longer holds, or a completion S3 refuses, drops the
   * session, and the next attempt starts over.
   */
  private async sendFileInParts(
    multipart: NonNullable<HttpObjectStorageAdapter["multipart"]>,
    key: string,
    fileUri: string,
    options: PutStreamOptions & { readonly sizeBytes: number },
  ): Promise<void> {
    const attemptStart = Date.now();
    const digests = await multipart.hashFileParts(fileUri, MULTIPART_PART_BYTES);
    const total = digests.partSha256Hex.length;
    multipartLog(
      key,
      `hashed ${digests.sizeBytes} bytes into ${total} parts in ${Date.now() - attemptStart} ms ` +
        `(${throughput(digests.sizeBytes, Date.now() - attemptStart)})`,
    );
    if (digests.sizeBytes !== options.sizeBytes) {
      multipartWarn(
        key,
        `refused: the file is ${digests.sizeBytes} bytes, the record says ${options.sizeBytes}`,
      );
      throw new Error(
        `${fileUri} is ${digests.sizeBytes} bytes, but the record for ${key} says ${options.sizeBytes}`,
      );
    }
    if (options.expectedSha256Hex && digests.sha256Hex !== options.expectedSha256Hex) {
      multipartWarn(key, `refused: the file hashes to ${digests.sha256Hex}, not the key's hash`);
      throw new ChecksumMismatchError(key, options.expectedSha256Hex, digests.sha256Hex);
    }

    let session = await multipart.sessions.get(key);
    if (session && !sameDigests(session.partSha256Hex, digests.partSha256Hex)) {
      multipartWarn(key, `the file changed since upload ${session.uploadId} began; starting over`);
      await multipart.sessions.delete(key);
      session = null;
    }

    const partNumbers = digests.partSha256Hex.map((_, i) => i + 1);
    const missing = partNumbers.filter((n) => !session?.etags[String(n)]);
    multipartLog(
      key,
      session
        ? `resuming upload ${session.uploadId}: ${total - missing.length}/${total} parts already sent`
        : "no upload in progress; starting one",
    );
    if (missing.length > 0) {
      const presignStart = Date.now();
      const presigned = await this.presignParts(key, options.contentType, digests, {
        uploadId: session?.uploadId,
        partNumbers: missing,
      });
      multipartLog(
        key,
        `presigned ${presigned.parts.length} parts for upload ${presigned.uploadId} in ${Date.now() - presignStart} ms`,
      );
      if (!session || session.uploadId !== presigned.uploadId) {
        session = { uploadId: presigned.uploadId, partSha256Hex: digests.partSha256Hex, etags: {} };
        await multipart.sessions.set(key, session);
      }
      for (const { partNumber, url } of presigned.parts) {
        const span = multipartPartSpan(digests.sizeBytes, partNumber);
        const partStart = Date.now();
        let result: Awaited<ReturnType<UploadFileRange>>;
        try {
          result = await multipart.uploadFileRange(fileUri, span, url, {
            method: "PUT",
            headers: {
              "x-amz-checksum-sha256": partChecksumBase64(digests.partSha256Hex[partNumber - 1]!),
            },
          });
        } catch (err) {
          multipartWarn(
            key,
            `part ${partNumber}/${total} failed after ${Date.now() - partStart} ms: ${(err as Error).message}; ` +
              `${Object.keys(session.etags).length}/${total} parts kept for the next attempt`,
          );
          throw err;
        }
        if (isNoSuchUpload(result.status, result.body)) {
          multipartWarn(key, `S3 no longer holds upload ${session.uploadId}; dropping it`);
          await multipart.sessions.delete(key);
          throw new Error(`S3 no longer holds the upload for ${key}; the next attempt starts over`);
        }
        if (result.status < 200 || result.status >= 300) {
          const detail = result.body.trim().replace(/\s+/g, " ").slice(0, 500);
          multipartWarn(
            key,
            `part ${partNumber}/${total} answered ${result.status}${detail ? ` — ${detail}` : ""}`,
          );
          throw new Error(
            `S3 PUT ${key} part ${partNumber} from ${fileUri} failed: ${result.status}${detail ? ` — ${detail}` : ""}`,
          );
        }
        if (!result.etag) {
          multipartWarn(key, `part ${partNumber}/${total} answered ${result.status} with no ETag`);
          throw new Error(`S3 PUT ${key} part ${partNumber} returned no ETag`);
        }
        session = { ...session, etags: { ...session.etags, [String(partNumber)]: result.etag } };
        await multipart.sessions.set(key, session);
        multipartLog(
          key,
          `part ${partNumber}/${total} sent: ${span.length} bytes in ${Date.now() - partStart} ms ` +
            `(${throughput(span.length, Date.now() - partStart)})`,
        );
      }
    }

    const completeStart = Date.now();
    const completeBody = JSON.stringify({
      key,
      uploadId: session!.uploadId,
      parts: partNumbers.map((n) => ({
        partNumber: n,
        etag: session!.etags[String(n)],
        checksumSha256: partChecksumBase64(digests.partSha256Hex[n - 1]!),
      })),
    });
    const res = await this.fetchImpl(`${this.apiBase()}/files/multipart/complete`, {
      method: "POST",
      headers: this.headers("POST", "/files/multipart/complete", completeBody, {
        "Content-Type": "application/json",
      }),
      body: completeBody,
    });
    if (res.status === 409) {
      multipartWarn(key, `the cloud refused to complete upload ${session!.uploadId}; dropping it`);
      await multipart.sessions.delete(key);
    }
    if (!res.ok) {
      const detail = await s3ErrorDetail(res);
      multipartWarn(key, `completing upload ${session!.uploadId} answered ${res.status}${detail}`);
      throw new Error(`complete multipart ${key} failed: ${res.status} ${res.statusText}${detail}`);
    }
    await multipart.sessions.delete(key);
    multipartLog(
      key,
      `completed upload ${session!.uploadId} in ${Date.now() - completeStart} ms; ` +
        `this attempt took ${Date.now() - attemptStart} ms`,
    );
  }

  private async presignParts(
    key: string,
    contentType: string | undefined,
    digests: FilePartDigests,
    request: { readonly uploadId: string | undefined; readonly partNumbers: readonly number[] },
  ): Promise<MultipartPresignResponse> {
    const body = JSON.stringify({
      key,
      contentType,
      contentHash: digests.sha256Hex,
      ...(request.uploadId ? { uploadId: request.uploadId } : {}),
      parts: request.partNumbers.map((n) => ({
        partNumber: n,
        checksumSha256: partChecksumBase64(digests.partSha256Hex[n - 1]!),
      })),
    });
    const res = await this.fetchImpl(`${this.apiBase()}/files/multipart/presign`, {
      method: "POST",
      headers: this.headers("POST", "/files/multipart/presign", body, {
        "Content-Type": "application/json",
      }),
      body,
    });
    if (!res.ok) {
      throw new Error(
        `presign multipart ${key} failed: ${res.status} ${res.statusText}${await s3ErrorDetail(res)}`,
      );
    }
    return (await res.json()) as MultipartPresignResponse;
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    // Request a presigned S3 PUT URL from the server to bypass API Gateway limits.
    // The bytes are in hand, so the hash always is too.
    const declared = options?.checksumSha256 ? sha256Base64ToHex(options.checksumSha256) : null;
    const contentHash = declared ?? hashHex(data);
    const { url, checksumSha256, storageClass, tagging } = await this.presignPut(
      key,
      options?.contentType,
      contentHash,
    );

    // Upload directly to S3 — presigned URL carries credentials, no auth header needed.
    //
    // When the server pinned a checksum into the signature (it derives one for
    // every content-addressed key, since the key *is* the hash), the header is
    // mandatory: it is part of the signature, so omitting it fails the request
    // rather than silently uploading unverified bytes. That is the point — the
    // uploader has no say in what it is allowed to write at this key, and a
    // successful PUT means S3 confirmed the bytes are the bytes the key names.
    const s3Res = await this.fetchImpl(url, {
      method: "PUT",
      headers: {
        ...(options?.contentType ? { "Content-Type": options.contentType } : {}),
        ...presignHeaders({ checksumSha256, storageClass, tagging }),
      },
      body: data as BodyInit,
    });
    if (!s3Res.ok) {
      throw new Error(
        `S3 PUT ${key} failed: ${s3Res.status} ${s3Res.statusText}${await s3ErrorDetail(s3Res)}`,
      );
    }
  }

  // There is no confirm step, and the absence is deliberate.
  //
  // A `POST /files/confirm` used to follow every upload, to tell the server the
  // blob had landed so it could eagerly flip pending download records. Nothing
  // implemented either half. No server has ever served the route — not the
  // cloud data server, not the local one — and the record type the call existed
  // to update appears nowhere in this codebase. Only the testkit's fake cloud
  // answered it, which is why a green suite sat on top of a call that 404'd on
  // every real upload and logged a warning per blob.
  //
  // The cost was not only noise. Each call was a signed HTTP round trip per
  // object, on the mobile uplink where round trips are the binding constraint,
  // in exchange for nothing.
  //
  // Availability does not depend on it. The cloud records archive and restore
  // state from S3 events and a daily inventory reconcile, and a record with no
  // availability row reads as available — so a freshly uploaded blob is
  // readable the moment the PUT returns. A server that later wants an eager
  // signal should add the route and the call together, with the record type
  // that gives it a purpose.

  async get(key: string): Promise<GetResult | null> {
    // Request a presigned S3 GET URL from the server to bypass API Gateway response limits.
    const presignRes = await this.fetchImpl(`${this.url(key)}/presign`, {
      headers: this.headers("GET", `/files/${key}/presign`, ""),
    });
    if (presignRes.status === 404) return null;
    if (!presignRes.ok) {
      throw new Error(`presign GET ${key} failed: ${presignRes.status} ${presignRes.statusText}`);
    }
    const { url } = (await presignRes.json()) as { url: string };

    // Download directly from S3.
    const s3Res = await this.fetchImpl(url);
    if (!s3Res.ok) {
      throw new Error(`S3 GET ${key} failed: ${s3Res.status} ${s3Res.statusText}`);
    }
    // `Uint8Array`, not `Buffer` — this adapter runs on React Native now, where
    // `Buffer` is not a global. It typechecked before because a Buffer *is* a
    // Uint8Array in Node, which is exactly how this kind of thing reaches a
    // handset and fails there instead of here.
    const bytes = new Uint8Array(await s3Res.arrayBuffer());
    const contentType = s3Res.headers.get("content-type") ?? undefined;
    return {
      data: bytes,
      contentType,
      size: bytes.byteLength,
    };
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const presignRes = await this.fetchImpl(`${this.url(key)}/presign`, {
      headers: this.headers("GET", `/files/${key}/presign`, ""),
    });
    if (presignRes.status === 404) return null;
    if (!presignRes.ok) {
      throw new Error(`presign GET ${key} failed: ${presignRes.status} ${presignRes.statusText}`);
    }
    const { url } = (await presignRes.json()) as { url: string };

    // The Range rides on the fetch, not the presign: the signature covers the
    // URL, and a presigned URL is deliberately reusable across ranges.
    const res = await this.fetchImpl(
      url,
      range ? { headers: { Range: `bytes=${range.start}-${range.end ?? ""}` } } : undefined,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GET ${key} failed: ${res.status} ${res.statusText}`);
    }
    // A server that ignores Range answers 200 with the whole object, which is a
    // *success* status carrying the wrong bytes. Left unchecked the caller
    // writes a full object into a slot sized for one chunk and the corruption
    // only surfaces later, in the assembled file. Fail here instead.
    if (range && res.status !== 206) {
      throw new Error(
        `GET ${key} ignored the requested range (status ${res.status}, expected 206)`,
      );
    }
    // The response body, not `arrayBuffer()` — a multi-GB clip must not be
    // materialized here, which is the entire point of this method existing
    // alongside get().
    return res.body as ReadableStream<Uint8Array> | null;
  }

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: PutStreamOptions,
  ): Promise<void> {
    const signed = await this.presignPut(key, options?.contentType, options?.expectedSha256Hex);
    await this.sendStream(key, body, signed, options);
  }

  /** PUT a stream to a URL the server already signed. */
  private async sendStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    signed: PresignedPut,
    options?: PutStreamOptions,
  ): Promise<void> {
    const { url, checksumSha256, storageClass, tagging } = signed;

    // Hash on the way past and fail the stream on a mismatch, which aborts the
    // request rather than completing it. S3 checks the pinned `checksumSha256`
    // too; this catches a mismatch before the last byte leaves the device.
    const verified = options?.expectedSha256Hex
      ? verifyingStream(body, { key, expectedSha256Hex: options.expectedSha256Hex })
      : body;

    let s3Res: Response;
    try {
      s3Res = await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          ...(options?.contentType ? { "Content-Type": options.contentType } : {}),
          ...presignHeaders({ checksumSha256, storageClass, tagging }),
          // S3 rejects a presigned PUT with chunked transfer encoding, so a
          // streamed body needs an explicit length. Records always carry
          // sizeBytes, so this is present in practice; when it isn't, the
          // request goes out chunked and will fail against real S3 rather than
          // silently uploading something truncated.
          ...(options?.sizeBytes !== undefined
            ? { "Content-Length": String(options.sizeBytes) }
            : {}),
        },
        body: verified,
        // Required by undici whenever the body is a stream: without it the
        // request fails with "duplex option is required when sending a body".
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    } catch (err) {
      // fetch rejects when the body stream errors — which is exactly what a
      // checksum mismatch does. Cancel so the source isn't left open.
      await verified.cancel().catch(() => {});
      throw err;
    }
    if (!s3Res.ok) {
      await verified.cancel().catch(() => {});
      throw new Error(
        `S3 PUT ${key} failed: ${s3Res.status} ${s3Res.statusText}${await s3ErrorDetail(s3Res)}`,
      );
    }
  }

  /**
   * Whether the remote holds these bytes.
   *
   * A 404 is "no". Anything else that is not ok — a 500, a 403, a gateway
   * timeout — is **"could not tell"**, and it throws rather than answering.
   * Returning `response.ok` made every one of those read as absence, which is
   * the same family as the bug `list()` was fixed for a few lines below:
   * returning an empty page said "the prefix is empty", *a wrong answer* rather
   * than a missing feature. `stat()` above already draws this distinction; this
   * did not.
   *
   * The immediate consequence was mild — `runTransfer` re-uploads on a false,
   * which is the safe direction — but `has()` is also what "Free up space"
   * would reach for to ask "is it safe to drop my copy?", and there a 403
   * reading as absence is the wrong answer in the direction that destroys data.
   * (`assessDurability` deliberately uses `stat()` and treats a throw as
   * `probe-failed`, which is exactly this rule stated one layer up.)
   */
  async has(key: string): Promise<boolean> {
    const response = await this.fetchImpl(this.url(key), {
      method: "HEAD",
      headers: this.headers("HEAD", `/files/${key}`, ""),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`has ${key} failed: ${response.status} ${response.statusText}`);
    }
    return true;
  }

  async stat(key: string): Promise<ObjectFacts | null> {
    const response = await this.fetchImpl(`${this.url(key)}/stat`, {
      headers: this.headers("GET", `/files/${key}/stat`, ""),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`stat ${key} failed: ${response.status} ${response.statusText}`);
    }
    const facts = (await response.json()) as {
      sizeBytes: number;
      checksumSha256: string | null;
      storageClass: string | null;
      availability: ObjectAvailability;
      contentType?: string;
    };
    return facts;
  }

  async setTags(key: string, tags: Record<string, string>): Promise<void> {
    const body = JSON.stringify({ tags });
    const res = await this.fetchImpl(`${this.url(key)}/tags`, {
      method: "PUT",
      headers: this.headers("PUT", `/files/${key}/tags`, body, {
        "Content-Type": "application/json",
      }),
      body,
    });
    if (!res.ok) {
      throw new Error(`setTags ${key} failed: ${res.status} ${res.statusText}`);
    }
  }

  async restoreObject(
    key: string,
    options: { tier: string; days: number },
  ): Promise<"started" | "already-in-progress"> {
    const body = JSON.stringify(options);
    const res = await this.fetchImpl(`${this.url(key)}/restore`, {
      method: "POST",
      headers: this.headers("POST", `/files/${key}/restore`, body, {
        "Content-Type": "application/json",
      }),
      body,
    });
    if (!res.ok) throw new Error(`restore ${key} failed: ${res.status} ${res.statusText}`);
    const parsed = (await res.json()) as { result?: "started" | "already-in-progress" };
    return parsed.result ?? "started";
  }

  async delete(key: string): Promise<void> {
    // DELETE signs over the empty body — matches the cloud verifier, which
    // treats GET/HEAD as empty and accepts an empty DELETE body the same way
    // (the cloud handler doesn't read a DELETE body for /files/{key}).
    const response = await this.fetchImpl(this.url(key), {
      method: "DELETE",
      headers: this.headers("DELETE", `/files/${key}`, ""),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`DELETE ${key} failed: ${response.status} ${response.statusText}`);
    }
  }

  async list(_prefix: string, _options?: ListOptions): Promise<ListResult> {
    // There is no listing route behind this adapter — `/files/{key}` addresses
    // one object and nothing enumerates the bucket. Returning an empty page
    // said "the prefix is empty", which is a *wrong answer* rather than a
    // missing feature: a caller reconciling against storage would conclude
    // every object under it had been lost. Nothing in the sync path lists
    // today; whatever does first should fail here loudly and get a route.
    throw new Error("HttpObjectStorageAdapter cannot list: no listing route exists behind /files");
  }
}
