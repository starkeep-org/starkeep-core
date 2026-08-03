/**
 * A source that can name a file and a destination that can send one move the
 * object without its bytes entering the JS heap.
 *
 * The property under test is not "the bytes arrive" — the stream path already
 * did that. It is that **nothing read them**: on React Native `fetch` buffers a
 * stream request body into a `Uint8Array`, so a transfer that touches
 * `getStream` at all costs several times the object size in JS heap, which is
 * what took the app down on a 24 MB video.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { FileUriTransferRefused, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { ObjectStorageAdapter, PutStreamOptions } from "@starkeep/storage-adapter";
import { createFileSyncEngine } from "../src/file-sync-engine.js";
import type { FileSyncManifest } from "../src/types.js";

const payload = Buffer.from("bytes that must never enter the JS heap");
const hex = createHash("sha256").update(payload as unknown as Uint8Array).digest("hex");
const key = `shared/video/${hex.slice(0, 2)}/${hex}`;

const manifest: FileSyncManifest = {
  fileHash: hex,
  objectStorageKey: key,
  sizeBytes: payload.length,
  mimeType: "video/mp4",
};

/** What a phone's local storage does: name the file, and count who reads it. */
function fileBackedSource(inner: MockObjectStorageAdapter, uri: string) {
  const reads = { streams: 0, buffered: 0 };
  const source = {
    ...inner,
    localFileUriFor: () => uri,
    has: (k: string) => inner.has(k),
    getStream: (k: string) => {
      reads.streams += 1;
      return inner.getStream(k);
    },
    get: (k: string) => {
      reads.buffered += 1;
      return inner.get(k);
    },
  } as unknown as ObjectStorageAdapter;
  return { source, reads };
}

/** What the HTTP adapter does with an uploader: take a URI instead of bytes. */
function fileAcceptingDestination(
  inner: MockObjectStorageAdapter,
  files: Map<string, Uint8Array>,
  behaviour: { refuse?: boolean } = {},
) {
  const sent: Array<{ key: string; fileUri: string }> = [];
  const destination = {
    ...inner,
    has: (k: string) => inner.has(k),
    putStream: (k: string, b: ReadableStream<Uint8Array>, o?: PutStreamOptions) =>
      inner.putStream(k, b, o),
    putFromFileUri: async (k: string, fileUri: string) => {
      if (behaviour.refuse) {
        // Contractually before any bytes move, which is what makes the
        // fallback below free rather than a second full-size transfer.
        throw new FileUriTransferRefused(k, "nothing would verify these bytes");
      }
      const bytes = files.get(fileUri);
      if (!bytes) throw new Error(`no such file: ${fileUri}`);
      sent.push({ key: k, fileUri });
      await inner.put(k, bytes);
    },
  } as unknown as ObjectStorageAdapter;
  return { destination, sent };
}

describe("file-URI transfer", () => {
  let local: MockObjectStorageAdapter;
  let remote: MockObjectStorageAdapter;
  let engine: ReturnType<typeof createFileSyncEngine>;
  let files: Map<string, Uint8Array>;

  beforeEach(async () => {
    local = new MockObjectStorageAdapter();
    remote = new MockObjectStorageAdapter();
    await local.init();
    await remote.init();
    await local.put(key, payload);
    engine = createFileSyncEngine();
    files = new Map([["content://media/external/video/media/42", new Uint8Array(payload)]]);
  });

  it("sends the file and never reads the bytes", async () => {
    const { source, reads } = fileBackedSource(local, "content://media/external/video/media/42");
    const { destination, sent } = fileAcceptingDestination(remote, files);

    expect(await engine.transferFile(manifest, source, destination)).toBe(true);
    expect(sent).toEqual([{ key, fileUri: "content://media/external/video/media/42" }]);
    expect((await remote.get(key))!.data.toString()).toBe(payload.toString());
    // The whole point.
    expect(reads).toEqual({ streams: 0, buffered: 0 });
  });

  it("streams when the destination cannot take a file", async () => {
    const { source, reads } = fileBackedSource(local, "content://media/external/video/media/42");

    expect(await engine.transferFile(manifest, source, remote)).toBe(true);
    expect((await remote.get(key))!.data.toString()).toBe(payload.toString());
    expect(reads.streams).toBe(1);
  });

  it("streams when the source cannot name a file", async () => {
    const { destination, sent } = fileAcceptingDestination(remote, files);

    expect(await engine.transferFile(manifest, local, destination)).toBe(true);
    expect(sent).toEqual([]);
    expect((await remote.get(key))!.data.toString()).toBe(payload.toString());
  });

  // A refusal means nothing was sent, so the stream path is a retry rather than
  // a second transfer of the same object.
  it("falls back to the stream path when the destination refuses", async () => {
    const { source, reads } = fileBackedSource(local, "content://media/external/video/media/42");
    const { destination } = fileAcceptingDestination(remote, files, { refuse: true });

    expect(await engine.transferFile(manifest, source, destination)).toBe(true);
    expect((await remote.get(key))!.data.toString()).toBe(payload.toString());
    expect(reads.streams).toBe(1);
  });

  // Anything that is not a refusal happened *during* the upload, and retrying
  // it through the stream path would push the object across the network twice
  // on every genuine failure — on a phone, through the heap that just OOMed.
  it("does not retry a failed native upload through the stream path", async () => {
    const { source, reads } = fileBackedSource(local, "content://media/external/video/media/42");
    const destination = {
      ...remote,
      has: (k: string) => remote.has(k),
      putStream: (k: string, b: ReadableStream<Uint8Array>, o?: PutStreamOptions) =>
        remote.putStream(k, b, o),
      putFromFileUri: async () => {
        throw new Error("S3 PUT failed: 500");
      },
    } as unknown as ObjectStorageAdapter;

    await expect(engine.transferFile(manifest, source, destination)).rejects.toThrow("500");
    expect(reads.streams).toBe(0);
    expect(await remote.has(key)).toBe(false);
  });

  it("releases the in-flight key after a native transfer", async () => {
    const { source } = fileBackedSource(local, "content://media/external/video/media/42");
    const { destination } = fileAcceptingDestination(remote, files);

    await engine.transferFile(manifest, source, destination);
    expect(engine.isTransferInFlight(key)).toBe(false);
  });
});
