export interface PutOptions {
  contentType?: string;
  /** Free-form user metadata; preserved by adapters that support it. */
  metadata?: Record<string, string>;
  /**
   * Base64 SHA-256 of `data`. Backends that support it hand this to the store,
   * which rejects a mismatched body instead of storing it — see
   * {@link SignedPutUrlOptions.checksumSha256} for why that matters.
   */
  checksumSha256?: string;
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
  /**
   * Base64 SHA-256 of the exact bytes the holder of this URL is permitted to
   * write, bound into the signature. The uploader must send it back as
   * `x-amz-checksum-sha256`; a body that hashes to anything else is **rejected
   * rather than stored**.
   *
   * This is what turns "the store returned 200" into "the store confirmed
   * these bytes are the bytes this key names". Our record keys already *are*
   * the SHA-256, so the signer derives this from the key and never trusts a
   * client-supplied value — the uploader has no say in what it is allowed to
   * write there. Costs no extra request.
   *
   * Note the encoding difference: `contentHash` is lowercase hex throughout
   * Starkeep; S3 wants base64 of the raw digest. Use `sha256HexToBase64`.
   */
  checksumSha256?: string;
}

/**
 * What the storage backend actually knows about a stored object — everything a
 * single HEAD-equivalent call already returns. Same call and same cost as a
 * bare existence check, which is why {@link ObjectStorageAdapter.stat} exists
 * rather than a family of accessors.
 *
 * Existence is *not* readability: an archived object exists and cannot be read.
 * Anything deciding whether it is safe to drop a local copy, or whether a read
 * will succeed, must consult {@link availability} and {@link checksumSha256}
 * rather than presence alone.
 */
export interface ObjectFacts {
  sizeBytes: number;
  /**
   * Base64 SHA-256 the *store* verified at write time, when it carries one.
   * `null` for objects written before checksums were sent, and for backends
   * with no such concept — which is why callers must treat `null` as "unknown",
   * never as "mismatch" and never as "verified".
   */
  checksumSha256: string | null;
  /**
   * Backend-specific storage class (`"STANDARD"`, `"INTELLIGENT_TIERING"`,
   * `"DEEP_ARCHIVE"`, …). `null` for backends without storage classes.
   * Informational — decide on {@link availability}, not on this string.
   */
  storageClass: string | null;
  availability: ObjectAvailability;
  contentType?: string;
  metadata?: Record<string, string>;
}

/**
 * Whether an object's bytes can be read *right now*, and if not, what it would
 * take. Mirrors the record-level `availability` reported by the data servers,
 * minus `absent` — at this layer "not held" is `stat()` returning `null`.
 */
export type ObjectAvailability =
  | { state: "instant" }
  /** A restore is in flight. `readyAt` is null when the backend won't estimate. */
  | { state: "restoring"; readyAt: string | null }
  | { state: "archived"; tier: string; expectedLatencyHours: number };
