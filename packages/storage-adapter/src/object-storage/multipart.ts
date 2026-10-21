/**
 * The multipart upload protocol's shared constants and its composite checksum.
 *
 * A file above {@link MULTIPART_THRESHOLD_BYTES} goes to S3 as a multipart
 * upload in parts of exactly {@link MULTIPART_PART_BYTES}, the last part
 * shorter. Each part carries its own SHA-256, which S3 checks as the part
 * arrives. The assembled object's stored checksum is then a *composite*: the
 * SHA-256 of the concatenated raw part digests, base64, suffixed
 * `-<partCount>`. It is not the object's SHA-256, and the object keeps its
 * whole-file SHA-256 as its `contentHash` and its key all the same.
 *
 * ## Why the part size is permanent
 *
 * With one system-wide part size, the composite depends only on the file's
 * bytes, so a node holding the file can recompute it and compare it with what
 * `HeadObject` reports. That comparison is the eviction proof for a multipart
 * object (see sync-engine's `durability.ts`). Changing the part size breaks the
 * recomputation for every object already stored. The threshold, by contrast,
 * may move freely: a verifier recognizes a multipart object by the `-<n>`
 * suffix, never by its size.
 *
 * Portable: no `Buffer`, no `node:crypto`. The composite is computed on phones
 * as well as in Node.
 */

import { hashFactory } from "./stream-verify.js";

/** The size of every part but the last. Permanent; see the module comment. */
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;

/**
 * Files strictly larger than this go multipart when the uploader can send byte
 * ranges. A tuning knob, not a format constant: nothing reads it to verify.
 */
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** S3's ceiling on parts per upload. */
export const MULTIPART_MAX_PARTS = 10_000;

/** How many parts a file of `sizeBytes` splits into. Zero bytes is one empty part. */
export function multipartPartCount(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / MULTIPART_PART_BYTES));
}

/** The byte span of a 1-based part number, for a file of `sizeBytes`. */
export function multipartPartSpan(
  sizeBytes: number,
  partNumber: number,
): { readonly offset: number; readonly length: number } {
  const offset = (partNumber - 1) * MULTIPART_PART_BYTES;
  return { offset, length: Math.max(0, Math.min(MULTIPART_PART_BYTES, sizeBytes - offset)) };
}

/**
 * A file's whole-file digest and its part digests, from one read.
 *
 * One read, because the two answer different questions and both are needed at
 * once: the part digests are what S3 checks, and the whole-file digest is what
 * links those parts to the key. A hasher that produced them from two reads
 * could pair the parts of one version of a file with the hash of another.
 */
export interface FilePartDigests {
  /** Lowercase hex SHA-256 of the whole file. */
  readonly sha256Hex: string;
  /** Lowercase hex SHA-256 of each {@link MULTIPART_PART_BYTES} part, in order. */
  readonly partSha256Hex: readonly string[];
  readonly sizeBytes: number;
}

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(n >> 18) & 63]!;
    out += BASE64_ALPHABET[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[n & 63]! : "=";
  }
  return out;
}

function requireSha256Hex(hex: string): void {
  if (!HEX_SHA256.test(hex)) {
    throw new Error(`expected a 64-character lowercase hex sha256, got ${JSON.stringify(hex)}`);
  }
}

/**
 * Lowercase-hex SHA-256 → the base64 form S3's `x-amz-checksum-sha256` takes,
 * without `Buffer`. Same contract as `sha256HexToBase64`, for code that runs on
 * a phone.
 */
export function partChecksumBase64(hex: string): string {
  requireSha256Hex(hex);
  return bytesToBase64(hexToBytes(hex));
}

/**
 * The checksum S3 stores for a multipart object assembled from these parts:
 * base64 of the SHA-256 over the concatenated raw part digests, then
 * `-<partCount>`. Compare it with `ObjectFacts.checksumSha256` as a string.
 */
export function compositeSha256Checksum(partSha256Hex: readonly string[]): string {
  if (partSha256Hex.length === 0) throw new Error("a multipart object has at least one part");
  const joined = new Uint8Array(partSha256Hex.length * 32);
  partSha256Hex.forEach((hex, i) => {
    requireSha256Hex(hex);
    joined.set(hexToBytes(hex), i * 32);
  });
  const hash = hashFactory()();
  hash.update(joined);
  return `${bytesToBase64(hexToBytes(hash.digestHex()))}-${partSha256Hex.length}`;
}

/** The part count a composite checksum names, or `null` for a whole-object checksum. */
export function compositePartCount(checksum: string): number | null {
  const match = /^[A-Za-z0-9+/]{43}=-(\d+)$/.exec(checksum);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 1 && n <= MULTIPART_MAX_PARTS ? n : null;
}
