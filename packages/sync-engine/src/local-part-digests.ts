/**
 * Recompute a local file's multipart digests, for the eviction proof.
 *
 * S3 stores a multipart object's checksum as a composite over fixed-size part
 * digests (see storage-adapter's `multipart.ts`). A node about to drop its copy
 * proves the cloud holds the same bytes by hashing its own copy the same way,
 * whole and in parts, and comparing (see `durability.ts`). This produces those
 * digests from whatever the local store can offer.
 */

import type { FilePartDigests, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { MULTIPART_PART_BYTES, hashFactory } from "@starkeep/storage-adapter";
import type { HashFileParts } from "./transports/http-object-storage.js";

/** The digests of the local copy at a key, or `null` when there is no local copy. */
export type LocalPartDigests = (objectStorageKey: string) => Promise<FilePartDigests | null>;

/**
 * Digests from the platform's file hasher when the store can name a file, and
 * from a JS stream otherwise.
 *
 * A phone must supply `hashFileParts`: its store names a `content://` URI for
 * a camera-roll asset, and streaming one into JS reads the whole asset into
 * memory. A desktop store streams from disk, so the JS path serves it.
 */
export function localPartDigestsFor(
  storage: ObjectStorageAdapter,
  hashFileParts?: HashFileParts,
): LocalPartDigests {
  return async (key) => {
    const fileUri = hashFileParts ? (storage.localFileUriFor?.(key) ?? null) : null;
    if (hashFileParts && fileUri !== null) return hashFileParts(fileUri, MULTIPART_PART_BYTES);
    const stream = await storage.getStream(key);
    return stream ? digestStream(stream) : null;
  };
}

async function digestStream(stream: ReadableStream<Uint8Array>): Promise<FilePartDigests> {
  const makeHash = hashFactory();
  const whole = makeHash();
  const partSha256Hex: string[] = [];
  let part = makeHash();
  let inPart = 0;
  let sizeBytes = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      whole.update(value);
      sizeBytes += value.byteLength;
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(MULTIPART_PART_BYTES - inPart, value.byteLength - offset);
        part.update(value.subarray(offset, offset + take));
        inPart += take;
        offset += take;
        if (inPart === MULTIPART_PART_BYTES) {
          partSha256Hex.push(part.digestHex());
          part = makeHash();
          inPart = 0;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  // A trailing short part, or the single empty part of an empty file.
  if (inPart > 0 || partSha256Hex.length === 0) partSha256Hex.push(part.digestHex());
  return { sha256Hex: whole.digestHex(), partSha256Hex, sizeBytes };
}
