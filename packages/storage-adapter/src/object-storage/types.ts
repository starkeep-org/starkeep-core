export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface GetResult {
  data: Buffer | Uint8Array;
  contentType?: string;
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
