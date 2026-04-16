import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { FileSyncEngine, FileSyncManifest, FileEntry } from "./types.js";

export function createFileSyncEngine(): FileSyncEngine {
  async function keyExists(
    storage: ObjectStorageAdapter,
    key: string,
  ): Promise<boolean> {
    const result = await storage.get(key);
    return result !== null;
  }

  return {
    async getFilesToPush(
      localStorage: ObjectStorageAdapter,
      remoteStorage: ObjectStorageAdapter,
      entries: FileEntry[],
    ): Promise<FileSyncManifest[]> {
      const manifests: FileSyncManifest[] = [];

      for (const entry of entries) {
        const existsRemotely = await keyExists(remoteStorage, entry.key);
        if (!existsRemotely) {
          const localFile = await localStorage.get(entry.key);
          if (localFile) {
            manifests.push({
              fileHash: entry.key,
              objectStorageKey: entry.key,
              sizeBytes: localFile.size,
              mimeType: entry.mimeType,
            });
          }
        }
      }

      return manifests;
    },

    async getFilesToPull(
      localStorage: ObjectStorageAdapter,
      remoteStorage: ObjectStorageAdapter,
      entries: FileEntry[],
    ): Promise<FileSyncManifest[]> {
      const manifests: FileSyncManifest[] = [];

      for (const entry of entries) {
        const existsLocally = await keyExists(localStorage, entry.key);
        if (!existsLocally) {
          const remoteFile = await remoteStorage.get(entry.key);
          if (remoteFile) {
            manifests.push({
              fileHash: entry.key,
              objectStorageKey: entry.key,
              sizeBytes: remoteFile.size,
              mimeType: entry.mimeType,
            });
          }
        }
      }

      return manifests;
    },

    async transferFile(
      manifest: FileSyncManifest,
      source: ObjectStorageAdapter,
      destination: ObjectStorageAdapter,
    ): Promise<void> {
      const file = await source.get(manifest.objectStorageKey);
      if (!file) {
        return;
      }
      await destination.put(manifest.objectStorageKey, file.data, {
        contentType: manifest.mimeType,
      });
    },
  };
}
