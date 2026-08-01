import { createHash } from "node:crypto";
import type { ObjectStorageAdapter } from "../object-storage/adapter.js";
import type {
  PutOptions,
  GetResult,
  ListOptions,
  ListResult,
  ObjectAvailability,
  ObjectFacts,
} from "../object-storage/types.js";

export class MockObjectStorageAdapter implements ObjectStorageAdapter {
  private store = new Map<
    string,
    {
      data: Uint8Array;
      contentType?: string;
      metadata?: Record<string, string>;
      /** Only set when the writer supplied one, mirroring S3. */
      checksumSha256?: string;
      availability: ObjectAvailability;
      storageClass: string | null;
    }
  >();
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
    // Enforce the checksum the way S3 does: a body that doesn't match the
    // declared digest is **rejected, not stored**. Without this the mock would
    // happily accept a wrong checksum and every unit test of the verified-upload
    // path would pass whether or not the checksum was ever sent — which is the
    // one thing those tests exist to catch.
    if (options?.checksumSha256) {
      const actual = createHash("sha256").update(data).digest("base64");
      if (actual !== options.checksumSha256) {
        throw new Error(
          `BadDigest: body sha256 ${actual} does not match declared ${options.checksumSha256} for key ${key}`,
        );
      }
    }
    this.store.set(key, {
      data: new Uint8Array(data),
      contentType: options?.contentType,
      metadata: options?.metadata,
      // Unsent means unstored, as in S3 — so `stat()` reports null and callers
      // are forced to treat it as "unknown" rather than "verified".
      ...(options?.checksumSha256 ? { checksumSha256: options.checksumSha256 } : {}),
      availability: { state: "instant" },
      storageClass: null,
    });
  }

  async get(key: string): Promise<GetResult | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      // Return a Buffer (extends Uint8Array) so callers using `.toString()`
      // get a UTF-8 decode rather than the comma-joined byte representation.
      data: Buffer.from(entry.data),
      contentType: entry.contentType,
      metadata: entry.metadata,
      size: entry.data.length,
    };
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async stat(key: string): Promise<ObjectFacts | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      sizeBytes: entry.data.length,
      checksumSha256: entry.checksumSha256 ?? null,
      storageClass: entry.storageClass,
      availability: entry.availability,
      ...(entry.contentType ? { contentType: entry.contentType } : {}),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };
  }

  /**
   * Test hook: move an existing object into an archived or restoring state.
   *
   * The behaviours that matter most in this plan — never evict on the word of a
   * store that can't currently serve the bytes, never implicitly thaw — are
   * only reachable when a test can produce an object that *exists and cannot be
   * read*. There is no other way to get one in-process.
   */
  setAvailability(key: string, availability: ObjectAvailability, storageClass?: string): void {
    const entry = this.store.get(key);
    if (!entry) throw new Error(`setAvailability: no object at key ${key}`);
    entry.availability = availability;
    if (storageClass !== undefined) entry.storageClass = storageClass;
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
