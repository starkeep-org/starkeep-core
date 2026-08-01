/**
 * Whole-object SHA-256 verification for streamed writes.
 *
 * The problem this solves is specific to large objects. Below the multipart
 * threshold a store can verify a whole-object SHA-256 for us and reject a
 * mismatched body. Above it, it cannot: S3 supports full-object checksums for
 * multipart only with the CRC algorithms, because only those linearize from
 * part checksums — SHA-256 is composite-only, and its stored value is a digest
 * *over the part digests*, which is not the object's hash and cannot be
 * compared against a content hash. Per-part checksums protect each part in
 * transit; nothing protects the assembled object unless the writer checks it.
 *
 * So the writer checks it, as the bytes go past.
 *
 * ## Why the mismatch has to surface at flush
 *
 * The digest is only final when the stream ends — which is also when the
 * upload wants to complete. Checking *after* the pipe resolves is too late:
 * the multipart upload has already been completed and the bad object is
 * stored. Failing the stream from inside `flush`, before the last chunk is
 * acknowledged, makes the upload reject and abort instead. That ordering is
 * the whole point of doing it here rather than at the call site.
 */

import { createHash } from "node:crypto";

export class ChecksumMismatchError extends Error {
  constructor(
    readonly key: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Streamed bytes for ${key} hash to ${actual}, expected ${expected}. The write was aborted.`,
    );
    this.name = "ChecksumMismatchError";
  }
}

/**
 * Pass a stream through unchanged while hashing it, erroring the stream at
 * end-of-input if the digest doesn't match `expectedSha256Hex`.
 *
 * `onDigest` is called with the hex digest on success, for callers that want to
 * record what actually arrived when no expectation was supplied.
 */
export function verifyingStream(
  source: ReadableStream<Uint8Array>,
  options: {
    key: string;
    expectedSha256Hex?: string;
    onDigest?: (hex: string) => void;
  },
): ReadableStream<Uint8Array> {
  const hash = createHash("sha256");
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        const actual = hash.digest("hex");
        if (options.expectedSha256Hex && actual !== options.expectedSha256Hex) {
          // Errors the stream rather than closing it, so a consumer that would
          // otherwise finalize (complete a multipart upload, close a file)
          // fails instead. Closing here and throwing afterwards would store the
          // bad object first.
          const err = new ChecksumMismatchError(options.key, options.expectedSha256Hex, actual);
          controller.error(err);
          return;
        }
        options.onDigest?.(actual);
        controller.close();
        return;
      }
      hash.update(value);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Collect a stream into one buffer. Only for callers that genuinely need the bytes in hand. */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** A one-shot stream over bytes already in memory. */
export function streamFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}
