import { FileUriTransferRefused } from "@starkeep/storage-adapter";
import type { ObjectStorageAdapter, PutStreamOptions } from "@starkeep/storage-adapter";
import type { FileSyncEngine, FileSyncManifest } from "./types.js";

const HEX_SHA256 = /^[a-f0-9]{64}$/;

/**
 * The SHA-256 a transferred object must hash to, or null when there isn't one.
 *
 * `fileHash` is the record's `contentHash` when it has one and falls back to
 * the object key otherwise, so it is only a hash some of the time — and a key
 * is not a hash. Returning null rather than guessing means an object with no
 * known hash transfers unverified instead of failing every time, which is the
 * correct direction: this check exists to catch corruption, not to block
 * records that predate content hashing.
 */
function expectedHashFor(manifest: FileSyncManifest): string | null {
  if (HEX_SHA256.test(manifest.fileHash)) return manifest.fileHash;
  // Content-addressed keys carry the hash in their last segment.
  const last = manifest.objectStorageKey.split("/").pop() ?? "";
  return HEX_SHA256.test(last) ? last : null;
}

export function createFileSyncEngine(): FileSyncEngine {
  /**
   * Transfers running right now, by object-storage key — **the outcome, not
   * just the fact**.
   *
   * A `Set` here meant a second caller for a key already moving got `false`,
   * which is indistinguishable from "the transfer failed". Inside one round the
   * engine works around that by grouping items by key before dispatch, but
   * nothing covers the cross-caller case: a user opening a photo whose bytes a
   * sync round happens to be pulling gets a failure for a fetch that is in fact
   * succeeding, and the placeholder stays on screen.
   *
   * Holding the promise instead lets the second caller *await the first's
   * result*, which is the honest answer to "did those bytes arrive?" — and it
   * makes the engine's key-grouping an optimization rather than a correctness
   * requirement.
   */
  interface InFlight {
    readonly destination: ObjectStorageAdapter;
    readonly promise: Promise<boolean>;
  }
  const inFlight = new Map<string, InFlight>();

  function transfer(
    manifest: FileSyncManifest,
    source: ObjectStorageAdapter,
    destination: ObjectStorageAdapter,
  ): Promise<boolean> {
    const key = manifest.objectStorageKey;
    const running = inFlight.get(key);
    if (!running) return start(manifest, source, destination);

    // Same destination is the same work, so the second caller simply awaits it.
    // This is the common case — one round grouping two records that share
    // content-addressed bytes.
    if (running.destination === destination) return running.promise;

    // A *different* destination is the opposite direction, and the two answers
    // are not interchangeable in both outcomes.
    //
    // On success they are: an upload that has put these bytes in the cloud means
    // the local copy it read them from is still here, so a concurrent download
    // to that same local store is already satisfied. Sharing `true` is right and
    // saves the transfer.
    //
    // On **failure** they are not, and this is the case the map was introduced
    // to end, surviving in one direction. An upload fails when the local source
    // cannot produce the bytes — and that is precisely the situation in which a
    // download would have worked, because the remote is where the bytes are.
    // Handing that `false` to someone who asked to fetch a photo reports a
    // failure for a transfer that was never attempted, and the placeholder stays
    // on screen. So the other direction runs on its own.
    return running.promise.then((ok) =>
      ok ? true : transfer(manifest, source, destination),
    );
  }

  function start(
    manifest: FileSyncManifest,
    source: ObjectStorageAdapter,
    destination: ObjectStorageAdapter,
  ): Promise<boolean> {
    const key = manifest.objectStorageKey;
    const entry: InFlight = {
      destination,
      promise: runTransfer(manifest, source, destination).finally(() => {
        // Only if it is still ours: the opposite direction may have started its
        // own after this one failed, and clearing that one's registration would
        // let a third caller start a duplicate transfer.
        if (inFlight.get(key) === entry) inFlight.delete(key);
      }),
    };
    inFlight.set(key, entry);
    return entry.promise;
  }

  async function runTransfer(
    manifest: FileSyncManifest,
    source: ObjectStorageAdapter,
    destination: ObjectStorageAdapter,
  ): Promise<boolean> {
    const key = manifest.objectStorageKey;
    // Destination already has it — no-op success. Lets callers fire-and-
    // forget transferFile without needing to HEAD first.
    if (await destination.has(key)) {
      return true;
    }
    const expectedSha256Hex = expectedHashFor(manifest);
    const options: PutStreamOptions = {
      ...(manifest.mimeType ? { contentType: manifest.mimeType } : {}),
      ...(manifest.sizeBytes ? { sizeBytes: manifest.sizeBytes } : {}),
      // Verify the whole object as it passes. Above the multipart threshold
      // the store cannot check a SHA-256 for us at all (it is composite-only
      // for multipart), and this transfer is exactly where a large,
      // least-replaceable object crosses a network.
      ...(expectedSha256Hex ? { expectedSha256Hex } : {}),
    };

    // When the source can name a file and the destination can send one, the
    // bytes go platform-to-platform and never enter the JS heap. That is not
    // an optimization on React Native: `fetch` there buffers a stream request
    // body into a `Uint8Array` before sending it, so the streamed path below
    // costs several times the object size in JS heap and a 24 MB video is
    // enough to take a memory-pressured handset down.
    //
    // Neither capability is load-bearing — either side absent, or a
    // destination that declines, and this falls through to the stream path
    // that every node has always used.
    const fileUri = source.localFileUriFor?.(key) ?? null;
    if (fileUri !== null && destination.putFromFileUri) {
      try {
        await destination.putFromFileUri(key, fileUri, options);
        return true;
      } catch (err) {
        // A refusal is contractually raised before anything was sent, so
        // retrying costs nothing but the presign round trip. Any other error
        // is an ordinary failed transfer and must not be retried a second way
        // — that would send a large object twice on every genuine failure.
        if (!(err instanceof FileUriTransferRefused)) throw err;
      }
    }

    // Streamed, never buffered. The old `source.get()` → `destination.put()`
    // held the whole object in memory, so a 2 GB clip could not sync at all —
    // it wasn't slow, it was impossible. Nothing here materializes the body.
    const body = await source.getStream(key);
    if (!body) {
      return false;
    }
    try {
      await destination.putStream(key, body, options);
    } catch (err) {
      // Cancel the source explicitly. A stream abandoned mid-transfer keeps
      // the underlying HTTP response open, and since a failed transfer is
      // retried every round, leaked responses accumulate until the connection
      // pool starves — which surfaces much later, as unrelated requests
      // hanging, rather than as this transfer failing.
      await body.cancel().catch(() => {});
      throw err;
    }
    return true;
  }

  return {
    isTransferInFlight(key: string): boolean {
      return inFlight.has(key);
    },

    transferFile: transfer,

    // Same mechanics as transferFile; a distinct entry point because the two
    // have different *authority*. transferFile runs inside a sync round and is
    // subject to the node's residency decision; this one is the answer to a
    // direct request and is not. Keeping them separate means a call site
    // cannot accidentally acquire the ability to ignore policy — it has to
    // name the intent.
    fetchBlobOnDemand: transfer,
  };
}
