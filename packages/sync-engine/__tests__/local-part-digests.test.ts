/**
 * The JS fallback that hashes a local copy whole and in multipart parts, for
 * the eviction proof on a node whose store streams from disk.
 *
 * The part boundaries must fall at exactly `MULTIPART_PART_BYTES` whatever
 * sizes the stream's chunks arrive in: a boundary off by one byte yields a
 * composite that never matches, and the file can never be freed.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MULTIPART_PART_BYTES,
  MockObjectStorageAdapter,
  type ObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { localPartDigestsFor } from "../src/local-part-digests.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function chunkedStore(bytes: Uint8Array, chunk: number): ObjectStorageAdapter {
  return {
    getStream: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += chunk)
            controller.enqueue(bytes.subarray(i, i + chunk));
          controller.close();
        },
      }),
  } as unknown as ObjectStorageAdapter;
}

describe("localPartDigestsFor", () => {
  it("cuts parts at the part size across uneven chunks", async () => {
    const bytes = new Uint8Array(2 * MULTIPART_PART_BYTES + 3);
    for (let i = 0; i < bytes.length; i += 4093) bytes[i] = i % 251;
    const digests = await localPartDigestsFor(chunkedStore(bytes, 1_000_003))("k");
    expect(digests).toEqual({
      sha256Hex: sha(bytes),
      partSha256Hex: [
        sha(bytes.subarray(0, MULTIPART_PART_BYTES)),
        sha(bytes.subarray(MULTIPART_PART_BYTES, 2 * MULTIPART_PART_BYTES)),
        sha(bytes.subarray(2 * MULTIPART_PART_BYTES)),
      ],
      sizeBytes: bytes.length,
    });
  });

  it("returns null when the store holds no copy", async () => {
    const empty = new MockObjectStorageAdapter();
    await empty.init();
    expect(await localPartDigestsFor(empty)("missing")).toBeNull();
  });

  // A phone's store names a content:// URI, and streaming that into JS reads
  // the whole asset into memory. The platform hasher must take the file.
  it("hands a file the store can name to the platform hasher", async () => {
    const store = {
      localFileUriFor: (key: string) => `content://media/${key}`,
      getStream: async () => {
        throw new Error("must not stream a file the platform can hash");
      },
    } as unknown as ObjectStorageAdapter;
    const seen: Array<[string, number]> = [];
    const digests = await localPartDigestsFor(store, async (uri, partBytes) => {
      seen.push([uri, partBytes]);
      return { sha256Hex: "a".repeat(64), partSha256Hex: ["a".repeat(64)], sizeBytes: 1 };
    })("k");
    expect(seen).toEqual([["content://media/k", MULTIPART_PART_BYTES]]);
    expect(digests?.sizeBytes).toBe(1);
  });
});
