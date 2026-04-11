import {
  mkdir,
  readFile,
  writeFile,
  remove,
  readDir,
  stat,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { join, dirname } from "@tauri-apps/api/path";
import type {
  ObjectStorageAdapter,
  PutOptions,
  GetResult,
  ListOptions,
  ListResult,
} from "@starkeep/storage-adapter";

const BASE_DIR = BaseDirectory.AppLocalData;
const OBJECTS_DIR = "objects";

export class TauriFsObjectStorageAdapter implements ObjectStorageAdapter {
  async init(): Promise<void> {
    await mkdir(OBJECTS_DIR, { baseDir: BASE_DIR, recursive: true });
  }

  async close(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<boolean> {
    try {
      await stat(OBJECTS_DIR, { baseDir: BASE_DIR });
      return true;
    } catch {
      return false;
    }
  }

  private async keyToPath(key: string): Promise<string> {
    // Content-addressed layout: objects/<first-2-chars>/<full-key>
    return join(OBJECTS_DIR, key.slice(0, 2), key);
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<void> {
    const filePath = await this.keyToPath(key);
    const dirPath = await dirname(filePath);
    await mkdir(dirPath, { baseDir: BASE_DIR, recursive: true });
    await writeFile(filePath, data, { baseDir: BASE_DIR });
    if (options?.contentType || options?.metadata) {
      const meta = JSON.stringify({
        contentType: options.contentType,
        metadata: options.metadata,
      });
      await writeFile(
        filePath + ".meta.json",
        new TextEncoder().encode(meta),
        { baseDir: BASE_DIR },
      );
    }
  }

  async get(key: string): Promise<GetResult | null> {
    const filePath = await this.keyToPath(key);
    try {
      const data = await readFile(filePath, { baseDir: BASE_DIR });
      let contentType: string | undefined;
      let metadata: Record<string, string> | undefined;
      try {
        const metaBytes = await readFile(filePath + ".meta.json", {
          baseDir: BASE_DIR,
        });
        const meta = JSON.parse(new TextDecoder().decode(metaBytes));
        contentType = meta.contentType;
        metadata = meta.metadata;
      } catch {
        // no metadata sidecar — that's fine
      }
      return { data, contentType, metadata, size: data.length };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = await this.keyToPath(key);
    try {
      await remove(filePath, { baseDir: BASE_DIR });
    } catch {
      // ignore ENOENT
    }
    try {
      await remove(filePath + ".meta.json", { baseDir: BASE_DIR });
    } catch {
      // ignore missing metadata
    }
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const allKeys: string[] = [];
    try {
      const dirs = await readDir(OBJECTS_DIR, { baseDir: BASE_DIR });
      for (const dir of dirs) {
        if (!dir.isDirectory) continue;
        const entries = await readDir(
          await join(OBJECTS_DIR, dir.name),
          { baseDir: BASE_DIR },
        );
        for (const entry of entries) {
          if (entry.name.endsWith(".meta.json")) continue;
          if (prefix === "" || entry.name.startsWith(prefix)) {
            allKeys.push(entry.name);
          }
        }
      }
    } catch {
      return { keys: [], nextCursor: null, hasMore: false };
    }

    allKeys.sort();
    const limit = options?.limit ?? allKeys.length;
    const startIdx = options?.cursor
      ? allKeys.indexOf(options.cursor) + 1
      : 0;
    const keys = allKeys.slice(startIdx, startIdx + limit);
    return {
      keys,
      nextCursor: keys.length === limit ? keys[keys.length - 1] : null,
      hasMore: startIdx + limit < allKeys.length,
    };
  }
}
