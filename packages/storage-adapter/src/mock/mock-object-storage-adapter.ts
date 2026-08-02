import type { ObjectStorageAdapter } from "../object-storage/adapter.js";
import {
  collectStream,
  streamFromBytes,
  verifyingStream,
  hashFactory,
} from "../object-storage/stream-verify.js";
import { sha256HexToBase64 } from "../object-storage/checksum.js";
import type {
  ByteRange,
  PutOptions,
  PutStreamOptions,
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
      tags?: Record<string, string>;
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
      // Through the injectable factory rather than node:crypto directly. The
      // mock is exported from the package index, so a module-scope
      // `node:crypto` import here makes the whole package unbundleable on
      // React Native — even though nothing on a phone would ever construct a
      // mock.
      const hash = hashFactory()();
      hash.update(data);
      const actual = sha256HexToBase64(hash.digestHex());
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

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (!range) return streamFromBytes(entry.data);
    // `end` is inclusive, so +1 for subarray's exclusive bound. Getting this
    // wrong in the mock is worse than getting it wrong in a real adapter: every
    // ranged test would agree with the bug and the truncation would only show
    // up against live S3.
    return streamFromBytes(
      entry.data.subarray(range.start, range.end === undefined ? undefined : range.end + 1),
    );
  }

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: PutStreamOptions,
  ): Promise<void> {
    // Verification happens *before* anything is stored, so a mismatched stream
    // leaves no object behind — matching what the real adapters do by aborting
    // the multipart upload / discarding the temp file. A mock that stored first
    // and threw afterwards would let a test pass against an implementation that
    // keeps corrupt bytes.
    const verified = options?.expectedSha256Hex
      ? verifyingStream(body, { key, expectedSha256Hex: options.expectedSha256Hex })
      : body;
    const data = await collectStream(verified);
    this.store.set(key, {
      data: new Uint8Array(data),
      contentType: options?.contentType,
      metadata: options?.metadata,
      // The streamed path carries no store-verified checksum, exactly as S3's
      // multipart path doesn't: what it has instead is the writer's own
      // whole-object check, which is not a statement the *store* can make.
      availability: { state: "instant" },
      storageClass: null,
    });
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

  async restoreObject(
    key: string,
    options: { tier: string; days: number },
  ): Promise<"started" | "already-in-progress"> {
    const entry = this.store.get(key);
    if (!entry) throw new Error(`restoreObject: no object at key ${key}`);
    if (entry.availability.state === "restoring") return "already-in-progress";
    entry.availability = { state: "restoring", readyAt: null };
    this.restoreRequests.push({ key, ...options });
    return "started";
  }

  /** Test accessor: every restore that was actually requested. */
  readonly restoreRequests: Array<{ key: string; tier: string; days: number }> = [];

  async setTags(key: string, tags: Record<string, string>): Promise<void> {
    const entry = this.store.get(key);
    if (!entry) throw new Error(`setTags: no object at key ${key}`);
    // Replaces, as S3 does. A merging mock would let a test pass against an
    // implementation that leaves a stale ladder=complete tag behind.
    entry.tags = { ...tags };
  }

  /** Test accessor: what tags an object carries. */
  tagsOf(key: string): Record<string, string> {
    return { ...(this.store.get(key)?.tags ?? {}) };
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
