import type {
  ByteRange,
  ObjectStorageAdapter,
  PutOptions,
  GetResult,
  ListOptions,
  ListResult,
  ObjectAvailability,
  ObjectFacts,
  PutStreamOptions,
} from "@starkeep/storage-adapter";
import { verifyingStream } from "@starkeep/storage-adapter";

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
  readonly signRequest?: (
    method: string,
    path: string,
    body: string,
  ) => Record<string, string>;
}

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

  constructor(options: HttpObjectStorageAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.signRequest = options.signRequest;
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
      const response = await this.fetchImpl(
        `${this.apiBase()}/health`,
        { headers: this.headers("GET", "/health", "") },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    // Request a presigned S3 PUT URL from the server to bypass API Gateway limits.
    const presignBody = JSON.stringify({ key, contentType: options?.contentType });
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
    const { url, checksumSha256, storageClass, tagging } = await presignRes.json() as PresignResponse;

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
      throw new Error(`S3 PUT ${key} failed: ${s3Res.status} ${s3Res.statusText}`);
    }

    await this.confirm(key);
  }

  /**
   * Tell the server the blob has landed so it can eagerly flip matching
   * PendingFileDownload records to Synced. Best-effort: the server's lazy
   * reconcile on pull is the correctness-critical path, so a failed confirm
   * is a warning, not an error — the blob is durably in S3 either way.
   */
  private async confirm(key: string): Promise<void> {
    try {
      const confirmBody = JSON.stringify({ key });
      const confirmRes = await this.fetchImpl(`${this.apiBase()}/files/confirm`, {
        method: "POST",
        headers: this.headers("POST", "/files/confirm", confirmBody, {
          "Content-Type": "application/json",
        }),
        body: confirmBody,
      });
      if (!confirmRes.ok) {
        console.warn(
          `[http-object-storage] confirm ${key} returned ${confirmRes.status} — relying on lazy reconcile`,
        );
      }
    } catch (err) {
      console.warn(
        `[http-object-storage] confirm ${key} failed: ${(err as Error).message} — relying on lazy reconcile`,
      );
    }
  }

  async get(key: string): Promise<GetResult | null> {
    // Request a presigned S3 GET URL from the server to bypass API Gateway response limits.
    const presignRes = await this.fetchImpl(`${this.url(key)}/presign`, {
      headers: this.headers("GET", `/files/${key}/presign`, ""),
    });
    if (presignRes.status === 404) return null;
    if (!presignRes.ok) {
      throw new Error(`presign GET ${key} failed: ${presignRes.status} ${presignRes.statusText}`);
    }
    const { url } = await presignRes.json() as { url: string };

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
    const { url } = await presignRes.json() as { url: string };

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
    const presignBody = JSON.stringify({ key, contentType: options?.contentType });
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
    const { url, checksumSha256, storageClass, tagging } = await presignRes.json() as PresignResponse;

    // Hash on the way past and fail the stream on a mismatch, which aborts the
    // request rather than completing it. The server's pinned `checksumSha256`
    // covers the single-part case; above the multipart threshold S3 cannot
    // check a whole-object SHA-256 at all, so this is the only thing that does.
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
      throw new Error(`S3 PUT ${key} failed: ${s3Res.status} ${s3Res.statusText}`);
    }

    await this.confirm(key);
  }

  async has(key: string): Promise<boolean> {
    const response = await this.fetchImpl(this.url(key), {
      method: "HEAD",
      headers: this.headers("HEAD", `/files/${key}`, ""),
    });
    return response.ok;
  }

  async stat(key: string): Promise<ObjectFacts | null> {
    const response = await this.fetchImpl(`${this.url(key)}/stat`, {
      headers: this.headers("GET", `/files/${key}/stat`, ""),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`stat ${key} failed: ${response.status} ${response.statusText}`);
    }
    const facts = await response.json() as {
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
    return { keys: [], nextCursor: null, hasMore: false };
  }
}
