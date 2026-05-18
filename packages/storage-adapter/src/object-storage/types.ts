export interface PutOptions {
  contentType?: string;
  /** Free-form user metadata; preserved by adapters that support it. */
  metadata?: Record<string, string>;
}

export interface GetResult {
  data: Uint8Array;
  contentType?: string;
  /** User metadata supplied at write time. */
  metadata?: Record<string, string>;
  size: number;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface ListResult {
  keys: string[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SignedUrlOptions {
  expiresIn?: number;
}

export interface SignedPutUrlOptions {
  contentType?: string;
  expiresIn?: number;
}
