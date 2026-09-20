import { mkdir, readFile, writeFile, unlink, readdir, stat, symlink, readlink, access, rename } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { verifyingStream, sha256HexToBase64 } from "@starkeep/storage-adapter";
import type { ByteRange, PutOptions, PutStreamOptions, GetResult, ListOptions, ListResult, ObjectFacts } from "@starkeep/storage-adapter";

export interface FsObjectStorageAdapterOptions {
  basePath: string;
}

/**
 * What the `.meta.json` beside an object carries.
 *
 * `checksumSha256` is the one field that is a claim about *provenance* rather
 * than a copy of what the caller said. It is written only where this adapter
 * verified the bytes as it stored them — a `put` whose supplied digest was
 * recomputed here, or a `putStream` whose verifying stream would have failed
 * the write — so `stat` reporting it means the same thing S3 reporting it
 * means. Anything written without a digest leaves it absent, and `stat` then
 * answers null, which callers read as "unknown".
 */
interface ObjectSidecar {
  contentType?: string;
  metadata?: Record<string, string>;
  tags?: Record<string, string>;
  checksumSha256?: string;
}

export class FsObjectStorageAdapter implements ObjectStorageAdapter {
  private readonly basePath: string;

  constructor(options: FsObjectStorageAdapterOptions) {
    this.basePath = options.basePath;
  }

  async init(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  async close(): Promise<void> {
    // No-op for filesystem
  }

  async healthCheck(): Promise<boolean> {
    try {
      await stat(this.basePath);
      return true;
    } catch {
      return false;
    }
  }

  private keyToPath(key: string): string {
    if (key.includes("/")) {
      return join(this.basePath, key);
    }
    return join(this.basePath, key.slice(0, 2), key);
  }

  async put(key: string, data: Buffer | Uint8Array, options?: PutOptions): Promise<void> {
    const filePath = this.keyToPath(key);
    // Verified before a byte is written, the way a store that was handed a
    // checksum verifies it: a mismatched body is rejected rather than stored.
    // The digest is recomputed here rather than trusted, which is what makes
    // recording it in the sidecar a statement this adapter is entitled to make.
    if (options?.checksumSha256) {
      const actual = createHash("sha256").update(data as unknown as Uint8Array).digest("base64");
      if (actual !== options.checksumSha256) {
        throw new Error(
          `BadDigest: body hashes to ${actual}, caller declared ${options.checksumSha256} for key ${key}`,
        );
      }
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    await this.writeSidecar(filePath, {
      ...(options?.contentType ? { contentType: options.contentType } : {}),
      ...(options?.metadata ? { metadata: options.metadata } : {}),
      ...(options?.checksumSha256 ? { checksumSha256: options.checksumSha256 } : {}),
    });
  }

  /** Write the sidecar when there is anything to say, and not otherwise. */
  private async writeSidecar(filePath: string, sidecar: ObjectSidecar): Promise<void> {
    if (Object.keys(sidecar).length === 0) return;
    await writeFile(`${filePath}.meta.json`, JSON.stringify(sidecar));
  }

  /** The sidecar beside an object, or an empty one where there is none. */
  private async readSidecar(filePath: string): Promise<ObjectSidecar> {
    try {
      return JSON.parse(await readFile(`${filePath}.meta.json`, "utf8")) as ObjectSidecar;
    } catch {
      // No sidecar — a symlinked file, or one written before sidecars existed.
      return {};
    }
  }

  async putSymlink(key: string, targetPath: string, _options?: PutOptions): Promise<void> {
    const linkPath = this.keyToPath(key);
    await mkdir(dirname(linkPath), { recursive: true });
    try {
      await symlink(targetPath, linkPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Symlink already exists — content-addressed key guarantees same content, skip.
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const filePath = this.keyToPath(key);
    try {
      await access(filePath);
    } catch {
      return null;
    }
    // Node's own conversion — the file is read in chunks, never held whole.
    // `start`/`end` are both inclusive in createReadStream, which is why
    // ByteRange is inclusive too: no translation, so no off-by-one to get wrong.
    return Readable.toWeb(
      createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined),
    ) as ReadableStream<Uint8Array>;
  }

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: PutStreamOptions,
  ): Promise<void> {
    const filePath = this.keyToPath(key);
    await mkdir(dirname(filePath), { recursive: true });

    // Write to a temporary name and rename into place. A stream can fail
    // partway — including deliberately, when the checksum doesn't match — and
    // a half-written file at the real key would look exactly like a complete
    // one to `has()`, which is how a corrupt object becomes a "replica".
    // rename() within a directory is atomic.
    const tempPath = `${filePath}.partial-${randomUUID()}`;
    const verified = options?.expectedSha256Hex
      ? verifyingStream(body, { key, expectedSha256Hex: options.expectedSha256Hex })
      : body;

    try {
      await pipeline(
        Readable.fromWeb(verified as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(tempPath),
      );
      await rename(tempPath, filePath);
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }

    await this.writeSidecar(filePath, {
      ...(options?.contentType ? { contentType: options.contentType } : {}),
      ...(options?.metadata ? { metadata: options.metadata } : {}),
      // The verifying stream above fails the write on a mismatch, so a stored
      // object that was given an expected hash is an object whose bytes this
      // adapter checked. Recorded in S3's encoding, because that is what
      // `ObjectFacts.checksumSha256` is defined to carry.
      ...(options?.expectedSha256Hex
        ? { checksumSha256: sha256HexToBase64(options.expectedSha256Hex) }
        : {}),
    });
  }

  async get(key: string): Promise<GetResult | null> {
    const filePath = this.keyToPath(key);
    try {
      const data = await readFile(filePath);
      const { contentType, metadata } = await this.readSidecar(filePath);
      return { data, contentType, metadata, size: data.length };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await access(this.keyToPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<ObjectFacts | null> {
    const filePath = this.keyToPath(key);
    let fileStat;
    try {
      // stat(), not lstat(): a key may be a symlink into a watched folder, and
      // the size that matters is the target's.
      fileStat = await stat(filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    const { contentType, metadata, checksumSha256 } = await this.readSidecar(filePath);

    return {
      sizeBytes: fileStat.size,
      // Reported only where this adapter verified the bytes on the way in —
      // see {@link ObjectSidecar}. A write that carried no digest leaves this
      // null, and callers must read null as "unknown": hashing the file here
      // to synthesize a value would be a lie about *provenance*, saying the
      // store confirmed these bytes when nothing did.
      checksumSha256: checksumSha256 ?? null,
      storageClass: null,
      // Bytes on a local disk are readable or absent; there is no third state.
      availability: { state: "instant" },
      ...(contentType ? { contentType } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  async setTags(key: string, tags: Record<string, string>): Promise<void> {
    // A local filesystem has no lifecycle rules, so tags here are inert — but
    // they are stored rather than ignored so a local node can answer the same
    // questions a cloud node can, and so a test can assert what was written
    // without a cloud.
    const filePath = this.keyToPath(key);
    const existing = await this.readSidecar(filePath);
    await writeFile(`${filePath}.meta.json`, JSON.stringify({ ...existing, tags }));
  }

  async restoreObject(
    key: string,
    _options: { tier: string; days: number },
  ): Promise<"started" | "already-in-progress"> {
    // A local filesystem has no archive tier, so nothing is ever unreadable and
    // there is nothing to restore. Reporting "started" rather than throwing is
    // the honest answer to "make this readable": it already is.
    void key;
    return "started";
  }

  async delete(key: string): Promise<void> {
    const filePath = this.keyToPath(key);
    try {
      await unlink(filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await unlink(`${filePath}.meta.json`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async resolvePath(key: string): Promise<string | null> {
    const linkPath = this.keyToPath(key);
    try {
      return await readlink(linkPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EINVAL") return linkPath; // regular file, not a symlink
      if (code === "ENOENT") return null;
      throw err;
    }
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const allKeys: string[] = [];

    const walk = async (directory: string, relativePath: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.endsWith(".meta.json")) continue;
        const relativeKey = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), relativeKey);
          continue;
        }
        // Legacy flat keys use a two-character shard directory. Hierarchical
        // app and shared keys retain their whole path.
        const key = /^[^/]{2}$/.test(relativePath) && entry.name.startsWith(relativePath)
          ? entry.name : relativeKey;
        if (key.startsWith(prefix)) allKeys.push(key);
      }
    };
    const start = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/") + 1) : "";
    if (start.split("/").includes("..") || start.startsWith("/")) throw new Error("Invalid object prefix");
    await walk(join(this.basePath, start), start.replace(/\/$/, ""));

    allKeys.sort();

    const limit = options?.limit ?? allKeys.length;
    const cursorIndex = options?.cursor ? allKeys.findIndex(key => key > options.cursor!) : 0;
    if (cursorIndex === -1) return { keys: [], nextCursor: null, hasMore: false };
    const keys = allKeys.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < allKeys.length;

    return {
      keys,
      nextCursor: hasMore ? keys[keys.length - 1] : null,
      hasMore,
    };
  }
}
