import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { FileSyncEngine, FileSyncManifest } from "./types.js";

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
      keys: string[],
    ): Promise<FileSyncManifest[]> {
      const manifests: FileSyncManifest[] = [];

      for (const key of keys) {
        const existsRemotely = await keyExists(remoteStorage, key);
        if (!existsRemotely) {
          const localFile = await localStorage.get(key);
          if (localFile) {
            manifests.push({
              fileHash: key,
              objectStorageKey: key,
              sizeBytes: localFile.size,
            });
          }
        }
      }

      return manifests;
    },

    async getFilesToPull(
      localStorage: ObjectStorageAdapter,
      remoteStorage: ObjectStorageAdapter,
      keys: string[],
    ): Promise<FileSyncManifest[]> {
      const manifests: FileSyncManifest[] = [];

      for (const key of keys) {
        const existsLocally = await keyExists(localStorage, key);
        if (!existsLocally) {
          const remoteFile = await remoteStorage.get(key);
          if (remoteFile) {
            manifests.push({
              fileHash: key,
              objectStorageKey: key,
              sizeBytes: remoteFile.size,
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
        contentType: file.contentType,
        metadata: file.metadata,
      });
    },
  };
}
