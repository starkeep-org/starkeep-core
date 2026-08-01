/**
 * SHA-256 digest encoding, in one place because the two halves of the system
 * disagree about it and the mismatch is silent.
 *
 * Starkeep carries content hashes as **lowercase hex** — it is what
 * `contentHash` holds, what the content-addressed object key is built from, and
 * what every API accepts. S3's `x-amz-checksum-sha256` header instead wants
 * **base64 of the raw 32-byte digest**. Handing S3 the hex string produces a
 * well-formed request that fails checksum validation, i.e. exactly the "upload
 * mysteriously rejected" class of bug, so neither form is ever built inline.
 */

const HEX_SHA256 = /^[a-f0-9]{64}$/;

/**
 * Lowercase-hex SHA-256 → base64, the form S3 checksum headers take.
 * Throws on anything that is not a 64-character lowercase hex digest: this
 * feeds a signature that pins which bytes a presigned URL may write, so a
 * silently-wrong value would defeat the verification it exists to provide.
 */
export function sha256HexToBase64(hex: string): string {
  if (!HEX_SHA256.test(hex)) {
    throw new Error(
      `sha256HexToBase64: expected a 64-character lowercase hex sha256, got ${JSON.stringify(hex)}`,
    );
  }
  return Buffer.from(hex, "hex").toString("base64");
}

/**
 * Inverse of {@link sha256HexToBase64}, for comparing what a store reports back
 * against a `contentHash`. Returns `null` for anything that doesn't decode to
 * exactly 32 bytes — stores may report a *composite* checksum for multipart
 * uploads (a digest of part digests, suffixed `-N`), which is not a SHA-256 of
 * the object and must never be compared against one as though it were.
 */
export function sha256Base64ToHex(base64: string): string | null {
  if (base64.includes("-")) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (buf.length !== 32) return null;
  return buf.toString("hex");
}
