/**
 * Blob transfer is streamed, and verified end to end.
 *
 * Two properties, both of which the previous buffered implementation could not
 * have: a transfer never materializes the object (so a multi-GB clip can move
 * at all), and a corrupted transfer fails rather than landing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { ObjectStorageAdapter, PutStreamOptions } from "@starkeep/storage-adapter";
import { createFileSyncEngine } from "../src/file-sync-engine.js";
import type { FileSyncManifest } from "../src/types.js";

const payload = Buffer.from("the bytes this key names");
const hex = createHash("sha256").update(payload as unknown as Uint8Array).digest("hex");
const key = `shared/image/${hex.slice(0, 2)}/${hex}`;

const manifest: FileSyncManifest = {
  fileHash: hex,
  objectStorageKey: key,
  sizeBytes: payload.length,
  mimeType: "image/jpeg",
};

describe("streamed transfer", () => {
  let source: MockObjectStorageAdapter;
  let destination: MockObjectStorageAdapter;
  let engine: ReturnType<typeof createFileSyncEngine>;

  beforeEach(async () => {
    source = new MockObjectStorageAdapter();
    destination = new MockObjectStorageAdapter();
    await source.init();
    await destination.init();
    engine = createFileSyncEngine();
  });

  it("moves the bytes", async () => {
    await source.put(key, payload);
    expect(await engine.transferFile(manifest, source, destination)).toBe(true);
    expect((await destination.get(key))!.data.toString()).toBe(payload.toString());
  });

  // The whole reason this path exists: `get()` then `put()` held the object in
  // memory, so a 2 GB clip could not sync at all. Asserting the buffered
  // methods are untouched is how we know the streaming path is the real one and
  // not a wrapper around the old behaviour.
  it("never calls the buffered get/put", async () => {
    await source.put(key, payload);
    let bufferedGets = 0;
    let bufferedPuts = 0;
    const watchedSource: ObjectStorageAdapter = {
      ...source,
      get: async (k: string) => {
        bufferedGets += 1;
        return source.get(k);
      },
      getStream: (k: string) => source.getStream(k),
      has: (k: string) => source.has(k),
    } as unknown as ObjectStorageAdapter;
    const watchedDestination: ObjectStorageAdapter = {
      ...destination,
      put: async (...args: Parameters<ObjectStorageAdapter["put"]>) => {
        bufferedPuts += 1;
        return destination.put(...args);
      },
      putStream: (k: string, b: ReadableStream<Uint8Array>, o?: PutStreamOptions) =>
        destination.putStream(k, b, o),
      has: (k: string) => destination.has(k),
    } as unknown as ObjectStorageAdapter;

    expect(await engine.transferFile(manifest, watchedSource, watchedDestination)).toBe(true);
    expect(bufferedGets).toBe(0);
    expect(bufferedPuts).toBe(0);
  });

  it("short-circuits when the destination already holds the key", async () => {
    await source.put(key, payload);
    await destination.put(key, payload);
    expect(await engine.transferFile(manifest, source, destination)).toBe(true);
  });

  it("reports failure when the source has nothing", async () => {
    expect(await engine.transferFile(manifest, source, destination)).toBe(false);
  });

  // Above the multipart threshold the store cannot verify a whole-object
  // SHA-256 for us at all, so this check is the only thing standing between a
  // corrupted transfer and an object that `has()` will happily call a replica.
  it("rejects a transfer whose bytes don't match the key, storing nothing", async () => {
    // Bytes that are not what the key names — a corrupted or substituted source.
    await source.put(key, Buffer.from("not the bytes this key names"));

    await expect(engine.transferFile(manifest, source, destination)).rejects.toThrow(/aborted/);
    expect(await destination.has(key)).toBe(false);
  });

  // `fileHash` falls back to the object key when a record has no contentHash,
  // so it is only a hash some of the time — and a key is not a hash. Records
  // that predate content hashing must still transfer rather than failing every
  // round.
  it("transfers unverified when no hash is derivable", async () => {
    const opaque: FileSyncManifest = {
      fileHash: "apps/someapp/syncable/cover",
      objectStorageKey: "apps/someapp/syncable/cover",
      sizeBytes: 4,
    };
    await source.put(opaque.objectStorageKey, Buffer.from("abcd"));
    expect(await engine.transferFile(opaque, source, destination)).toBe(true);
  });

  it("still recovers the hash from a content-addressed key alone", async () => {
    await source.put(key, Buffer.from("wrong bytes entirely"));
    const noHash: FileSyncManifest = { ...manifest, fileHash: key };
    await expect(engine.transferFile(noHash, source, destination)).rejects.toThrow(/aborted/);
  });

  it("does not leave the key marked in-flight after a failure", async () => {
    await source.put(key, Buffer.from("not the bytes this key names"));
    await expect(engine.transferFile(manifest, source, destination)).rejects.toThrow();
    // A leaked in-flight marker would make every subsequent retry return false
    // without attempting anything — the record would be stuck forever.
    expect(engine.isTransferInFlight(key)).toBe(false);
  });
});
