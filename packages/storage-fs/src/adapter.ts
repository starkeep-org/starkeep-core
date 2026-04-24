import { mkdir, readFile, writeFile, unlink, readdir, stat, symlink, readlink, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { PutOptions, GetResult, ListOptions, ListResult } from "@starkeep/storage-adapter";

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

  async put(key: string, data: Buffer | Uint8Array, _options?: PutOptions): Promise<void> {
    const filePath = this.keyToPath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
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

  async get(key: string): Promise<GetResult | null> {
    const filePath = this.keyToPath(key);
    try {
      const data = await readFile(filePath);
      return { data, size: data.length };
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

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.keyToPath(key));
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
