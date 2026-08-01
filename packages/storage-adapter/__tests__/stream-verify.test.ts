import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  verifyingStream,
  collectStream,
  streamFromBytes,
  ChecksumMismatchError,
} from "../src/object-storage/stream-verify.js";

const bytes = Buffer.from("a few bytes worth verifying");
const hex = createHash("sha256").update(bytes as unknown as Uint8Array).digest("hex");

/** A stream that yields its input in several chunks, like a real network read. */
function chunked(data: Buffer, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(data.subarray(offset, offset + chunkSize)));
      offset += chunkSize;
    },
  });
}

describe("verifyingStream", () => {
  it("passes the bytes through unchanged", async () => {
    const out = await collectStream(verifyingStream(chunked(bytes, 7), { key: "k" }));
    expect(out.equals(bytes)).toBe(true);
  });

  it("accepts a stream that hashes to the expectation", async () => {
    const out = await collectStream(
      verifyingStream(chunked(bytes, 7), { key: "k", expectedSha256Hex: hex }),
    );
    expect(out.equals(bytes)).toBe(true);
  });

  // The mismatch must surface as a *stream error*, not as a value returned
  // after the fact. A consumer that finalizes on close — completing a multipart
  // upload, renaming a temp file into place — would otherwise have already
  // stored the bad object by the time anyone could check.
  it("errors the stream rather than closing it when the digest disagrees", async () => {
    const stream = verifyingStream(chunked(bytes, 7), {
      key: "shared/image/aa/whatever",
      expectedSha256Hex: "f".repeat(64),
    });
    await expect(collectStream(stream)).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it("names the key and both digests, so a corrupt copy can be found", async () => {
    const stream = verifyingStream(chunked(bytes, 7), {
      key: "shared/image/aa/thekey",
      expectedSha256Hex: "f".repeat(64),
    });
    await expect(collectStream(stream)).rejects.toThrow(
      new RegExp(`shared/image/aa/thekey.*${hex}.*aborted`, "s"),
    );
  });

  // Truncation is the failure mode a length check alone would miss when the
  // length is unknown, and it is what a dropped connection looks like.
  it("catches a truncated stream", async () => {
    const truncated = chunked(bytes.subarray(0, 5), 7);
    await expect(
      collectStream(verifyingStream(truncated, { key: "k", expectedSha256Hex: hex })),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  it("reports the digest when no expectation was supplied", async () => {
    let seen: string | null = null;
    await collectStream(
      verifyingStream(chunked(bytes, 7), { key: "k", onDigest: (h) => (seen = h) }),
    );
    expect(seen).toBe(hex);
  });

  it("propagates cancellation to the source", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const wrapped = verifyingStream(source, { key: "k" });
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel("done");
    expect(cancelled).toBe(true);
  });
});

describe("streamFromBytes / collectStream", () => {
  it("round-trips", async () => {
    expect((await collectStream(streamFromBytes(bytes))).equals(bytes)).toBe(true);
  });

  it("handles an empty payload", async () => {
    expect((await collectStream(streamFromBytes(new Uint8Array()))).length).toBe(0);
  });
});
