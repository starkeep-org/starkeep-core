import type {
  ObjectStorageAdapter,
  PutOptions,
  GetResult,
  ListOptions,
  ListResult,
} from "@starkeep/storage-adapter";

export interface HttpObjectStorageAdapterOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly getAuthHeader?: () => string | undefined;
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
  private readonly getAuthHeader?: () => string | undefined;

  constructor(options: HttpObjectStorageAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.getAuthHeader = options.getAuthHeader;
  }

  private url(key: string): string {
    return `${this.baseUrl}/${encodeURIComponent(key)}`;
  }

  // Base URL without the /files suffix, for presign endpoints.
  private apiBase(): string {
    return this.baseUrl.replace(/\/files$/, "");
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    const auth = this.getAuthHeader?.();
    if (auth) headers["Authorization"] = auth;
    return headers;
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
        { headers: this.headers() },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    // Request a presigned S3 PUT URL from the server to bypass API Gateway limits.
    const presignRes = await this.fetchImpl(`${this.apiBase()}/files/presign`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ key, contentType: options?.contentType }),
    });
    if (!presignRes.ok) {
      throw new Error(`presign PUT ${key} failed: ${presignRes.status} ${presignRes.statusText}`);
    }
    const { url } = await presignRes.json() as { url: string };

    // Upload directly to S3 — presigned URL carries credentials, no auth header needed.
    const s3Res = await this.fetchImpl(url, {
      method: "PUT",
      headers: options?.contentType ? { "Content-Type": options.contentType } : {},
      body: Buffer.from(data),
    });
    if (!s3Res.ok) {
      throw new Error(`S3 PUT ${key} failed: ${s3Res.status} ${s3Res.statusText}`);
    }

    // Tell the server the blob has landed so it can eagerly flip matching
    // PendingFileDownload records to Synced. Best-effort: the server's lazy
    // reconcile on pull is the correctness-critical path, so a failed confirm
    // is a warning, not an error — the blob is durably in S3 either way.
    try {
      const confirmRes = await this.fetchImpl(`${this.apiBase()}/files/confirm`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ key }),
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
      headers: this.headers(),
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
    const buffer = Buffer.from(await s3Res.arrayBuffer());
    const contentType = s3Res.headers.get("content-type") ?? undefined;
    return {
      data: buffer,
      contentType,
      size: buffer.length,
    };
  }

  async has(key: string): Promise<boolean> {
    const response = await this.fetchImpl(this.url(key), {
      method: "HEAD",
      headers: this.headers(),
    });
    return response.ok;
  }

  async delete(key: string): Promise<void> {
    const response = await this.fetchImpl(this.url(key), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`DELETE ${key} failed: ${response.status} ${response.statusText}`);
    }
  }

  async list(_prefix: string, _options?: ListOptions): Promise<ListResult> {
    return { keys: [], nextCursor: null, hasMore: false };
  }
}
