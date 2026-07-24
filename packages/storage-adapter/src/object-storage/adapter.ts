import type { PutOptions, GetResult, HeadResult, ListOptions, ListResult, SignedUrlOptions, SignedPutUrlOptions } from "./types.js";

export interface ObjectStorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;

  put(key: string, data: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<GetResult | null>;
  // Cheap existence check — must not download the object body.
  has(key: string): Promise<boolean>;
  // Cheap metadata read (size + content type) — must not download the body.
  // Returns null when the object is missing OR unreadable to this principal
  // (S3 collapses both to 403 for callers without ListBucket), so a non-null
  // result is a positive proof of readability. Optional: adapters that can't
  // HEAD without a download omit it.
  head?(key: string): Promise<HeadResult | null>;
  delete(key: string): Promise<void>;
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
  getSignedUrl?(key: string, options?: SignedUrlOptions): Promise<string>;
  getSignedPutUrl?(key: string, options?: SignedPutUrlOptions): Promise<string>;
  putSymlink?(key: string, targetPath: string, options?: PutOptions): Promise<void>;
}
