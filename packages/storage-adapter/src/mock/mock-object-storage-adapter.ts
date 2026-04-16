import type { ObjectStorageAdapter } from "../object-storage/adapter.js";
import type { PutOptions, GetResult, ListOptions, ListResult } from "../object-storage/types.js";

export class MockObjectStorageAdapter implements ObjectStorageAdapter {
  private store = new Map<string, { data: Uint8Array; contentType?: string }>();
  private initialized = false;

  async init(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.initialized;
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    this.store.set(key, {
      data: new Uint8Array(data),
      contentType: options?.contentType,
    });
  }

  async get(key: string): Promise<GetResult | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      data: new Uint8Array(entry.data),
      contentType: entry.contentType,
      size: entry.data.length,
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const allKeys = Array.from(this.store.keys())
      .filter((candidateKey) => candidateKey.startsWith(prefix))
      .sort();

    const limit = options?.limit ?? allKeys.length;
    const cursorIndex = options?.cursor
      ? allKeys.indexOf(options.cursor) + 1
      : 0;

    const keys = allKeys.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < allKeys.length;

    return {
      keys,
      nextCursor: hasMore ? keys[keys.length - 1] : null,
      hasMore,
    };
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
