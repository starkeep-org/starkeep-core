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
        `${this.baseUrl.replace(/\/files$/, "")}/health`,
        { headers: this.headers() },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    const headers = this.headers({
      "Content-Type": options?.contentType ?? "application/octet-stream",
    });
    const response = await this.fetchImpl(this.url(key), {
      method: "PUT",
      headers,
      body: Buffer.from(data),
    });
    if (!response.ok) {
      throw new Error(`PUT ${key} failed: ${response.status} ${response.statusText}`);
    }
  }

  async get(key: string): Promise<GetResult | null> {
    const response = await this.fetchImpl(this.url(key), {
      headers: this.headers(),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GET ${key} failed: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? undefined;
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
