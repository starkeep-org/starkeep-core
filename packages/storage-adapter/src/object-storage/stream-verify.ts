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

/**
 * An incremental SHA-256, in the shape both platforms can supply.
 *
 * Incremental rather than one-shot, because the whole point of verifying here
 * is that the bytes are never all in memory at once — a one-shot digest would
 * mean buffering a multi-gigabyte video to check it.
 *
 * That rules out Web Crypto's `subtle.digest`, which takes a whole buffer and
 * is async besides. React Native therefore supplies its own implementation;
 * Node uses the built-in one below.
 */
import { sha256 } from "js-sha256";

export interface IncrementalHash {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

export type HashFactory = () => IncrementalHash;

/**
 * The default: a pure-JS SHA-256 that works on every platform.
 *
 * This package used to import `node:crypto` at module scope, which does not
 * merely fail on React Native — it makes the *whole package* unbundleable
 * there, and Metro reports it as an error in whatever file imported the
 * package, several layers from the cause. Typechecking is perfectly happy with
 * an import that cannot exist at runtime, so only bundling found it.
 *
 * The first attempt at a fix was a lazy `require("node:crypto")` inside this
 * factory. That is worse, and worse in a quiet way: these are ESM packages, so
 * `require` is simply undefined, and every hash threw — which surfaced as
 * records failing to sync rather than as anything mentioning crypto.
 *
 * So the default is portable and correct everywhere, and Node callers that care
 * about throughput install the native implementation at their edge with
 * {@link setHashFactory}. Correct by default, fast where it is worth
 * configuring — rather than fast by default and broken on a phone.
 */
let defaultHashFactory: HashFactory = () => {
  const hash = sha256.create();
  return {
    update: (chunk) => void hash.update(chunk),
    digestHex: () => hash.hex(),
  };
};

/**
 * Install the platform's hash implementation.
 *
 * Called once, at the app's edge, beside the other platform wiring. Global
 * rather than threaded through every call site because the alternative is an
 * options bag on `putStream`, `verifyingStream` and every adapter that touches
 * them — for a value that is a property of the runtime, not of the call.
 */
export function setHashFactory(factory: HashFactory): void {
  defaultHashFactory = factory;
}

/** The installed factory, for the few places that hash outside a stream. */
export function hashFactory(): HashFactory {
  return defaultHashFactory;
}

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
  const hash = defaultHashFactory();
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        const actual = hash.digestHex();
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
