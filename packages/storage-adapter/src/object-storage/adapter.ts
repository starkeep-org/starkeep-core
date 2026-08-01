import type { PutOptions, PutStreamOptions, GetResult, ListOptions, ListResult, ObjectFacts, SignedUrlOptions, SignedPutUrlOptions } from "./types.js";

export interface ObjectStorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;

  put(key: string, data: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<GetResult | null>;
  /**
   * Read an object as a stream, or `null` if there is none.
   *
   * The buffered {@link get} is retained for callers that genuinely want the
   * bytes in hand (a small JSON blob, a thumbnail). It is not usable for media:
   * `get()` then `put()` holds the whole object in memory, so a 2 GB clip
   * cannot sync at all.
   *
   * Web `ReadableStream` rather than a Node stream, deliberately — the same
   * adapter interface has to be implementable on React Native and in a browser,
   * where Node streams do not exist. Node-side adapters convert at their own
   * edge, which costs one wrapper and keeps the contract portable.
   */
  getStream(key: string): Promise<ReadableStream<Uint8Array> | null>;
  /**
   * Write an object from a stream, without buffering it.
   *
   * Adapters that support multipart must use it above their own threshold and
   * must send per-part checksums. See {@link PutStreamOptions.expectedSha256Hex}
   * for why the whole-object verification has to happen here rather than being
   * delegated to the store.
   */
  putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: PutStreamOptions,
  ): Promise<void>;
  /**
   * Cheap existence check — must not download the object body.
   *
   * **Existence is not readability.** This answers "is there an object at this
   * key", and returns true for an archived object that cannot currently be read
   * at all. Anything deciding whether a read will succeed, or whether it is safe
   * to drop the only other copy of these bytes, must use {@link stat} and look
   * at `availability` and `checksumSha256`. `has()` is for the cases that
   * genuinely only care about presence — the transfer short-circuit, a 404
   * check.
   */
  has(key: string): Promise<boolean>;
  /**
   * Everything the backend knows about the object, or `null` if there is none.
   * Same underlying call and same cost as {@link has} — a bare boolean throws
   * away the size, checksum, storage class and restore state that HEAD already
   * returned.
   */
  stat(key: string): Promise<ObjectFacts | null>;
  /**
   * Replace an object's tags.
   *
   * Tags are how a bucket-wide lifecycle rule selects objects without knowing
   * anything about records. Separate from `put` because the fact being recorded
   * — "this record's derived ladder is confirmed complete" — becomes true long
   * after the bytes were written, and re-uploading a 40 MB original to change a
   * tag would be absurd.
   *
   * Replaces rather than merges, matching S3's own semantics: a partial update
   * would need a read first, and two writers merging into the same tag set is
   * how an object ends up carrying a stale `ladder=complete` from before a
   * respec.
   */
  setTags(key: string, tags: Record<string, string>): Promise<void>;
  /**
   * Ask the backend to make an archived object readable again.
   *
   * Returns `"started"` when a restore was newly initiated, and
   * `"already-in-progress"` when one was already running — S3 answers the
   * second case with a distinct error rather than a success, and collapsing
   * them into a throw would make a retry look like a failure when it is the
   * ordinary outcome of two clients asking at once.
   *
   * Restoring does not move the object out of its archived storage class. It
   * creates a temporary readable copy that lapses after `days`, which is why
   * `availability` returns to `archived` on its own and no code has to
   * remember to undo anything.
   */
  restoreObject(
    key: string,
    options: { tier: string; days: number },
  ): Promise<"started" | "already-in-progress">;
  delete(key: string): Promise<void>;
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
  getSignedUrl?(key: string, options?: SignedUrlOptions): Promise<string>;
  getSignedPutUrl?(key: string, options?: SignedPutUrlOptions): Promise<string>;
  putSymlink?(key: string, targetPath: string, options?: PutOptions): Promise<void>;
}
