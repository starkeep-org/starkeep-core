export interface PutOptions {
  contentType?: string;
}

export interface GetResult {
  data: Uint8Array;
  contentType?: string;
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
