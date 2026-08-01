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

export interface PutStreamOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  /**
   * Total size when known. Lets an adapter take the cheaper single-request
   * path for a small object instead of always negotiating a multipart upload.
   * Omitted is fine — adapters must not require it, because a stream from a
   * peer may not know its length until it ends.
   */
  sizeBytes?: number;
  /**
   * Lowercase-hex SHA-256 the streamed bytes must hash to. The adapter hashes
   * as it streams and **fails the write** on a mismatch rather than storing
   * the object.
   *
   * This is how a large object gets verified at all. A whole-object
   * `x-amz-checksum-sha256` is not available for multipart uploads — S3
   * supports full-object checksums for multipart only with the CRC algorithms,
   * because only those linearize from part checksums — so for anything above
   * the multipart threshold the store cannot check a SHA-256 for us. Per-part
   * checksums (which the adapter also sends) protect each part in transit;
   * this protects the object as a whole.
   */
  expectedSha256Hex?: string;
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
  /**
   * Backend storage class the object must land in, bound into the signature.
   *
   * Set at write time rather than moved afterwards: a transition costs a
   * request per object and, for a large library, more than the storage it
   * saves. It is signed for the same reason the checksum is — otherwise the
   * uploader chooses, and "this app's blobs are all in the cheap tier" would be
   * a hope rather than a property.
   */
  storageClass?: string;
  /**
   * Object tags to write, bound into the signature.
   *
   * Tags are how a bucket-wide lifecycle rule selects objects without the rule
   * needing to know anything about records. Signing them means an uploader
   * cannot tag its way into (or out of) a rule it was not granted.
   */
  tagging?: Record<string, string>;
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
