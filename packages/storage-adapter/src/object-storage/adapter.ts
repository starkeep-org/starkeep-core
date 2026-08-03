import type { ByteRange, PutOptions, PutStreamOptions, GetResult, ListOptions, ListResult, ObjectFacts, SignedUrlOptions, SignedPutUrlOptions } from "./types.js";

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
   *
   * `range` reads a byte range instead of the whole object. This exists for
   * video: a `<video>` element seeks by issuing `Range` requests, and an
   * implementation that read from zero and discarded the prefix would turn a
   * scrub to the ten-minute mark into a ten-minute download. Every backend here
   * supports ranged reads natively, so honouring it costs one parameter.
   *
   * A range beyond the end of the object is the caller's error to handle; the
   * adapter reports what the backend reports rather than clamping, because a
   * silently-clamped range is indistinguishable from a correct short read.
   */
  getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
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

  /**
   * The URI of a file the platform can read directly for this key, or `null`.
   *
   * Half of a negotiation: a source that can name a file and a destination that
   * can {@link putFromFileUri} one together move an object without its bytes
   * entering the JS heap. Either side absent falls back to the stream path,
   * which is why both are optional and why neither may be load-bearing for
   * correctness.
   *
   * This matters on React Native, where `fetch` buffers a `ReadableStream`
   * request body into a `Uint8Array` before sending it — the "streamed" path
   * costs several times the object size in JS heap, and a 24 MB video is enough
   * to take the process down on a memory-pressured handset.
   *
   * Synchronous, and must stay cheap: it is asked before every transfer. An
   * adapter that would need a network round trip to answer should return
   * `null`. Returning a URI is not a promise that the bytes are still there —
   * the same staleness rules as `has()` apply.
   */
  localFileUriFor?(key: string): string | null;
  /**
   * Store an object by sending a platform file's bytes directly.
   *
   * The other half of the negotiation described on {@link localFileUriFor}.
   * Implementations hand the URI to a platform uploader; the bytes never cross
   * into JS.
   *
   * ## Verification, and why dropping the JS checksum is safe here
   *
   * {@link PutStreamOptions.expectedSha256Hex} cannot be honoured in JS on this
   * path — nothing in JS sees a byte. An implementation may only accept the
   * transfer when the *backend* verifies the same digest (S3 checks a
   * whole-object SHA-256 pinned into a presigned single-part PUT), or when no
   * verification was asked for.
   *
   * When it can offer neither, it must throw {@link FileUriTransferRefused},
   * and it must do so **before any bytes move** — the caller responds by
   * retrying through the stream path, and a refusal raised mid-upload would
   * push the whole object through the JS heap a second time, which is the exact
   * failure this method exists to avoid. Every other error is an ordinary
   * failed transfer.
   */
  putFromFileUri?(key: string, fileUri: string, options?: PutStreamOptions): Promise<void>;
}
