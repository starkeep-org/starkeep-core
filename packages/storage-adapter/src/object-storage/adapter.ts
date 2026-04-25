import type { PutOptions, GetResult, ListOptions, ListResult, SignedUrlOptions, SignedPutUrlOptions } from "./types.js";

export interface ObjectStorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;

  put(key: string, data: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<GetResult | null>;
  // Cheap existence check — must not download the object body.
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
  getSignedUrl?(key: string, options?: SignedUrlOptions): Promise<string>;
  getSignedPutUrl?(key: string, options?: SignedPutUrlOptions): Promise<string>;
  putSymlink?(key: string, targetPath: string, options?: PutOptions): Promise<void>;
}
