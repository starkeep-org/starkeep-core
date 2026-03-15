import { mkdir, readFile, writeFile, unlink, readdir, stat } from "node:fs/promises";
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
    const prefix = key.slice(0, 2);
    return join(this.basePath, prefix, key);
  }

  private metaPath(key: string): string {
    return this.keyToPath(key) + ".meta.json";
  }

  async put(key: string, data: Buffer | Uint8Array, options?: PutOptions): Promise<void> {
    const filePath = this.keyToPath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);

    if (options?.contentType || options?.metadata) {
      const meta = {
        contentType: options.contentType,
        metadata: options.metadata,
      };
      await writeFile(this.metaPath(key), JSON.stringify(meta));
    }
  }

  async get(key: string): Promise<GetResult | null> {
    const filePath = this.keyToPath(key);
    try {
      const data = await readFile(filePath);
      let contentType: string | undefined;
      let metadata: Record<string, string> | undefined;

      try {
        const metaRaw = await readFile(this.metaPath(key), "utf-8");
        const meta = JSON.parse(metaRaw);
        contentType = meta.contentType;
        metadata = meta.metadata;
      } catch {
        // No metadata file
      }

      return { data, contentType, metadata, size: data.length };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.keyToPath(key));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await unlink(this.metaPath(key));
    } catch {
      // Metadata may not exist
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
