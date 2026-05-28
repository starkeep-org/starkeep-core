import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { FileSyncEngine, FileSyncManifest, FileEntry } from "./types.js";

export function createFileSyncEngine(): FileSyncEngine {
  // Object-storage keys currently being transferred in this process. Each
  // transferFile call acquires the key on entry and releases on exit. Used by
  // the retry pass to skip records whose transfer is already in flight.
  const inFlightKeys = new Set<string>();

  return {
    isTransferInFlight(key: string): boolean {
      return inFlightKeys.has(key);
    },

    async getFilesToPush(
      localStorage: ObjectStorageAdapter,
      remoteStorage: ObjectStorageAdapter,
      entries: FileEntry[],
    ): Promise<FileSyncManifest[]> {
      const manifests: FileSyncManifest[] = [];

      for (const entry of entries) {
        const existsRemotely = await remoteStorage.has(entry.key);
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
        const existsLocally = await localStorage.has(entry.key);
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
    ): Promise<boolean> {
      const key = manifest.objectStorageKey;
      if (inFlightKeys.has(key)) {
        return false;
      }
      inFlightKeys.add(key);
      try {
        // Destination already has it — no-op success. Lets callers fire-and-
        // forget transferFile without needing to HEAD first.
        if (await destination.has(key)) {
          return true;
        }
        const file = await source.get(key);
        if (!file) {
          return false;
        }
        await destination.put(key, file.data, {
          contentType: manifest.mimeType,
        });
        return true;
      } finally {
        inFlightKeys.delete(key);
      }
    },
  };
}
