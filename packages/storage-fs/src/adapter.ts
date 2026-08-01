import { mkdir, readFile, writeFile, unlink, readdir, stat, symlink, readlink, access, rename } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { verifyingStream } from "@starkeep/storage-adapter";
import type { ByteRange, PutOptions, PutStreamOptions, GetResult, ListOptions, ListResult, ObjectFacts } from "@starkeep/storage-adapter";

export interface FsObjectStorageAdapterOptions {
  basePath: string;
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
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    if (options?.contentType || options?.metadata) {
      await writeFile(
        `${filePath}.meta.json`,
        JSON.stringify({ contentType: options.contentType, metadata: options.metadata }),
      );
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

    if (options?.contentType || options?.metadata) {
      await writeFile(
        `${filePath}.meta.json`,
        JSON.stringify({ contentType: options.contentType, metadata: options.metadata }),
      );
    }
  }

  async get(key: string): Promise<GetResult | null> {
    const filePath = this.keyToPath(key);
    try {
      const data = await readFile(filePath);
      let contentType: string | undefined;
      let metadata: Record<string, string> | undefined;
      try {
        const metaRaw = await readFile(`${filePath}.meta.json`, "utf8");
        const meta = JSON.parse(metaRaw) as { contentType?: string; metadata?: Record<string, string> };
        contentType = meta.contentType;
        metadata = meta.metadata;
      } catch {
        // No sidecar — older put() call or symlinked file. Leave contentType undefined.
      }
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

    let contentType: string | undefined;
    let metadata: Record<string, string> | undefined;
    try {
      const meta = JSON.parse(await readFile(`${filePath}.meta.json`, "utf8")) as {
        contentType?: string;
        metadata?: Record<string, string>;
      };
      contentType = meta.contentType;
      metadata = meta.metadata;
    } catch {
      // No sidecar — symlinked or written before sidecars. Not an error.
    }

    return {
      sizeBytes: fileStat.size,
      // A local filesystem verifies nothing at write time. Reporting null here
      // is the honest answer and callers must read it as "unknown" — hashing
      // the file to synthesize a value would be a lie about *provenance*: it
      // would say the store confirmed these bytes when nothing did.
      checksumSha256: null,
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
    let existing: { contentType?: string; metadata?: Record<string, string> } = {};
    try {
      existing = JSON.parse(await readFile(`${filePath}.meta.json`, "utf8")) as typeof existing;
    } catch {
      // No sidecar yet.
    }
    await writeFile(
      `${filePath}.meta.json`,
      JSON.stringify({ ...existing, tags }),
    );
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

    try {
      const dirs = await readdir(this.basePath);
      for (const dir of dirs) {
        if (dir.startsWith(".")) continue;
        try {
          const dirPath = join(this.basePath, dir);
          const dirStat = await stat(dirPath);
          if (!dirStat.isDirectory()) continue;
          const files = await readdir(dirPath);
          for (const file of files) {
            if (file.endsWith(".meta.json")) continue;
            if (file.startsWith(prefix) || prefix === "") {
              allKeys.push(file);
            }
          }
        } catch {
          // Skip unreadable dirs
        }
      }
    } catch {
      return { keys: [], nextCursor: null, hasMore: false };
    }

    allKeys.sort();

    const limit = options?.limit ?? allKeys.length;
    const cursorIndex = options?.cursor ? allKeys.indexOf(options.cursor) + 1 : 0;
    const keys = allKeys.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < allKeys.length;

    return {
      keys,
      nextCursor: hasMore ? keys[keys.length - 1] : null,
      hasMore,
    };
  }
}
