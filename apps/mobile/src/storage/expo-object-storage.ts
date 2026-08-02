/**
 * `ObjectStorageAdapter` over expo-file-system (item 11b).
 *
 * ## The interface already fits
 *
 * Item 2 typed the adapter's streams as **web** `ReadableStream`/`WritableStream`
 * rather than Node streams, on the argument that "the same adapter interface has
 * to be implementable on React Native, where Node streams do not exist".
 * expo-file-system 57 returns exactly those types, so this is a mapping and not
 * a shim:
 *
 * | Adapter | expo-file-system |
 * |---|---|
 * | `getStream(key)`        | `File.readableStream()` |
 * | `getStream(key, range)` | `File.open()` → `FileHandle.offset` + `readBytes()` |
 * | `putStream(key, body)`  | `File.writableStream()` |
 * | `stat(key)`             | `File.size`, `File.exists` |
 *
 * ## What a phone cannot answer
 *
 * `checksumSha256` is `null` and `availability` is always instant. A local
 * filesystem verifies nothing at write time, so reporting a checksum here would
 * be a lie about *provenance* — it would claim the store confirmed these bytes
 * when nothing did. The fs adapter says the same thing for the same reason, and
 * callers are required to read `null` as "unknown" rather than "mismatch".
 *
 * Tags are stored in a sidecar and are inert: a phone has no lifecycle rules.
 * They are kept rather than dropped so a phone can answer the same questions a
 * cloud node can, and so a test can assert what was written without a cloud.
 */

import type {
  ByteRange,
  GetResult,
  ListOptions,
  ListResult,
  ObjectFacts,
  ObjectStorageAdapter,
  PutOptions,
  PutStreamOptions,
} from "@starkeep/storage-adapter";
import { verifyingStream } from "@starkeep/storage-adapter";

/**
 * The slice of expo-file-system this needs, declared structurally.
 *
 * Not imported, so this module and its tests run in Node against a fake. The
 * real module is supplied at the app's edge — which is the only place that
 * genuinely has to be a phone.
 */
export interface ExpoFileHandle {
  offset: number;
  readBytes(length: number): Uint8Array;
  close(): void;
}

export interface ExpoFile {
  readonly exists: boolean;
  readonly size: number | null;
  readableStream(): ReadableStream<Uint8Array>;
  writableStream(): WritableStream<Uint8Array>;
  open(): ExpoFileHandle;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  delete(): void;
  text(): Promise<string>;
  write(contents: string | Uint8Array): void;
  readonly uri: string;
}

export interface ExpoDirectory {
  create(options?: { intermediates?: boolean; idempotent?: boolean }): void;
  list(): Array<ExpoFile | ExpoDirectory>;
  readonly exists: boolean;
  readonly uri: string;
}

export interface ExpoFileSystem {
  file(path: string): ExpoFile;
  directory(path: string): ExpoDirectory;
}

export interface ExpoObjectStorageOptions {
  readonly fs: ExpoFileSystem;
  /** Root directory for object storage, e.g. `documentDirectory + "objects"`. */
  readonly basePath: string;
}

export class ExpoObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly fs: ExpoFileSystem;
  private readonly basePath: string;

  constructor(options: ExpoObjectStorageOptions) {
    this.fs = options.fs;
    this.basePath = options.basePath.replace(/\/$/, "");
  }

  async init(): Promise<void> {
    this.fs.directory(this.basePath).create({ intermediates: true, idempotent: true });
  }

  async close(): Promise<void> {
    // Nothing to release: a filesystem is not a connection.
  }

  async healthCheck(): Promise<boolean> {
    return this.fs.directory(this.basePath).exists;
  }

  /**
   * Sharded the same way the fs adapter shards, so a key means the same thing
   * on every node.
   *
   * Not cosmetic: content-addressed keys are uniformly distributed hex, and a
   * flat directory of 60k entries is a directory listing nothing wants to do.
   */
  private pathFor(key: string): string {
    return key.includes("/")
      ? `${this.basePath}/${key}`
      : `${this.basePath}/${key.slice(0, 2)}/${key}`;
  }

  private metaPathFor(key: string): string {
    return `${this.pathFor(key)}.meta.json`;
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    const file = this.fs.file(this.pathFor(key));
    file.create({ intermediates: true, overwrite: true });
    file.write(data);
    if (options?.contentType || options?.metadata) {
      this.writeSidecar(key, { contentType: options.contentType, metadata: options.metadata });
    }
  }

  async get(key: string): Promise<GetResult | null> {
    const stream = await this.getStream(key);
    if (!stream) return null;
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const size = chunks.reduce((n, c) => n + c.byteLength, 0);
    const data = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.byteLength;
    }
    const sidecar = await this.readSidecar(key);
    return {
      data,
      size,
      ...(sidecar?.contentType ? { contentType: sidecar.contentType } : {}),
      ...(sidecar?.metadata ? { metadata: sidecar.metadata } : {}),
    };
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const file = this.fs.file(this.pathFor(key));
    if (!file.exists) return null;
    if (!range) return file.readableStream();

    // Ranged reads go through a handle rather than the stream, because a stream
    // has no way to start anywhere but the beginning — reading from zero and
    // discarding the prefix would satisfy every assertion about content while
    // turning a seek to the ten-minute mark of a video into a ten-minute read.
    const size = file.size ?? 0;
    const end = Math.min(range.end ?? size - 1, size - 1);
    const length = end - range.start + 1;
    if (length <= 0) return emptyStream();

    const handle = file.open();
    handle.offset = range.start;
    // Chunked rather than one `readBytes(length)`: a range can legitimately be
    // most of a large file, and materialising it whole is the thing streaming
    // exists to avoid.
    const CHUNK = 256 * 1024;
    let remaining = length;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          handle.close();
          controller.close();
          return;
        }
        const chunk = handle.readBytes(Math.min(CHUNK, remaining));
        if (chunk.byteLength === 0) {
          handle.close();
          controller.close();
          return;
        }
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        // A reader that stops early must not leak the handle — on a phone the
        // open-file limit is low enough that this matters within one session.
        handle.close();
      },
    });
  }

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: PutStreamOptions,
  ): Promise<void> {
    // Written to a temporary name and moved into place, matching the fs
    // adapter: a stream can fail partway — deliberately, when a checksum does
    // not match — and a half-written file at the real key would look exactly
    // like a complete one to `has()`, which is how a corrupt object becomes
    // something the durability predicate counts as a replica.
    const finalPath = this.pathFor(key);
    const tempPath = `${finalPath}.partial`;
    const temp = this.fs.file(tempPath);
    temp.create({ intermediates: true, overwrite: true });

    const verified = options?.expectedSha256Hex
      ? verifyingStream(body, { key, expectedSha256Hex: options.expectedSha256Hex })
      : body;

    try {
      await verified.pipeTo(temp.writableStream());
    } catch (err) {
      try {
        temp.delete();
      } catch {
        // Already gone, or never created. Not worth masking the real error.
      }
      throw err;
    }

    const final = this.fs.file(finalPath);
    if (final.exists) final.delete();
    // expo-file-system has no rename on the File class in this shape, so the
    // bytes are read back and written across. That is a real cost this driver
    // pays and the Node one does not — worth revisiting against the module's
    // move API before this handles multi-GB video.
    const bytes = await this.readAll(temp);
    final.create({ intermediates: true, overwrite: true });
    final.write(bytes);
    temp.delete();

    if (options?.contentType || options?.metadata) {
      this.writeSidecar(key, { contentType: options.contentType, metadata: options.metadata });
    }
  }

  async has(key: string): Promise<boolean> {
    return this.fs.file(this.pathFor(key)).exists;
  }

  async stat(key: string): Promise<ObjectFacts | null> {
    const file = this.fs.file(this.pathFor(key));
    if (!file.exists) return null;
    const sidecar = await this.readSidecar(key);
    return {
      sizeBytes: file.size ?? 0,
      // A phone's filesystem verifies nothing at write time. Synthesising a
      // hash here would claim the store confirmed these bytes when nothing did.
      checksumSha256: null,
      storageClass: null,
      // Bytes on local storage are readable or absent; there is no third state.
      availability: { state: "instant" },
      ...(sidecar?.contentType ? { contentType: sidecar.contentType } : {}),
      ...(sidecar?.metadata ? { metadata: sidecar.metadata } : {}),
    };
  }

  async setTags(key: string, tags: Record<string, string>): Promise<void> {
    const existing = (await this.readSidecar(key)) ?? {};
    this.writeSidecar(key, { ...existing, tags });
  }

  async restoreObject(
    _key: string,
    _options: { tier: string; days: number },
  ): Promise<"started" | "already-in-progress"> {
    // Nothing here is ever archived, so a restore is already complete the
    // moment it is asked for. "already-in-progress" is the honest answer of the
    // two available: it means "do not wait on me", which is exactly right, where
    // "started" would invite a caller to poll for a transition that never comes.
    return "already-in-progress";
  }

  async delete(key: string): Promise<void> {
    const file = this.fs.file(this.pathFor(key));
    if (file.exists) file.delete();
    const meta = this.fs.file(this.metaPathFor(key));
    if (meta.exists) meta.delete();
  }

  async list(_prefix: string, _options?: ListOptions): Promise<ListResult> {
    // Deliberately unimplemented rather than half-implemented. Nothing on the
    // phone path lists object storage — residency works from the database, not
    // from a directory walk — and a listing that silently returned one shard
    // would be worse than one that says it does not exist.
    throw new Error("list() is not implemented on the phone; residency reads the database instead");
  }

  private async readAll(file: ExpoFile): Promise<Uint8Array> {
    const reader = file.readableStream().getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }

  private writeSidecar(key: string, value: unknown): void {
    const meta = this.fs.file(this.metaPathFor(key));
    meta.create({ intermediates: true, overwrite: true });
    meta.write(JSON.stringify(value));
  }

  private async readSidecar(key: string): Promise<{
    contentType?: string;
    metadata?: Record<string, string>;
    tags?: Record<string, string>;
  } | null> {
    const meta = this.fs.file(this.metaPathFor(key));
    if (!meta.exists) return null;
    try {
      return JSON.parse(await meta.text()) as Record<string, never>;
    } catch {
      // A corrupt sidecar costs a content type, not the object. Throwing here
      // would make an unreadable scrap of JSON hide a perfectly good file.
      return null;
    }
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}
