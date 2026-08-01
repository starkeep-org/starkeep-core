import type { PutOptions, GetResult, ListOptions, ListResult, ObjectFacts, SignedUrlOptions, SignedPutUrlOptions } from "./types.js";

export interface ObjectStorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;

  put(key: string, data: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<GetResult | null>;
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
  delete(key: string): Promise<void>;
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
  getSignedUrl?(key: string, options?: SignedUrlOptions): Promise<string>;
  getSignedPutUrl?(key: string, options?: SignedPutUrlOptions): Promise<string>;
  putSymlink?(key: string, targetPath: string, options?: PutOptions): Promise<void>;
}
