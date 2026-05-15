import type { HLCClock } from "@starkeep/core";
import { serializeHLC } from "@starkeep/core";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { appSyncableObjectKey } from "@starkeep/core";
import type {
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  AppSyncableRowEntry,
} from "@starkeep/sync-engine";
import type { AppSpecificOperations, ApiSubject } from "../types.js";
import { validateTableName } from "./validation.js";

export interface AppSpecificFactoryOptions {
  namespace: AppSyncableNamespaceStore;
  applier: AppSyncableApplier;
  fileStorage: ObjectStorageAdapter;
  /**
   * Builds a URL the caller can hand back to a browser to fetch the file.
   * Optional — when omitted, `fileUrl()` returns null.
   */
  buildFileUrl?: (key: string, mimeType: string, expiresIn: number) => string;
  clock: HLCClock;
}

/**
 * Builds the per-request `appSpecific` view. Returns a factory shaped to
 * plug directly into `createSharedSpaceApi({ getAppSpecific })`.
 *
 * All row mutations are applied directly via the applier, which uses LWW on
 * `updated_at`. The same applier the pull path uses is called here, making
 * the code path identical regardless of whether a change originated locally
 * or arrived from a remote.
 */
export function createAppSpecificFactory(
  options: AppSpecificFactoryOptions,
): (subject: ApiSubject) => AppSpecificOperations | null {
  const { namespace, applier, fileStorage, buildFileUrl, clock } = options;

  return (subject) => {
    if (subject.subjectType !== "app") return null;
    const appId = subject.subjectId;
    const ns = namespace.get(appId);
    if (!ns) return null;
    const declaredTables = new Set(ns.tableNames);

    function resolveTable(table: string): void {
      validateTableName(table);
      if (!declaredTables.has(table)) {
        throw new Error(`App "${appId}" did not declare app-syncable table "${table}"`);
      }
    }

    function ensureFilesEnabled(): void {
      if (!ns!.filesEnabled) {
        throw new Error(`App "${appId}" did not opt in to syncable files`);
      }
    }

    return {
      async insertRow(table, row) {
        resolveTable(table);
        const ts = clock.now();
        const entry: AppSyncableRowEntry = {
          timestamp: ts,
          appId,
          table,
          op: "insert",
          row: { ...row, updated_at: serializeHLC(ts), deleted_at: null },
        };
        await applier.apply(entry);
      },

      async updateRow(table, where, patch) {
        resolveTable(table);
        const ts = clock.now();
        const entry: AppSyncableRowEntry = {
          timestamp: ts,
          appId,
          table,
          op: "update",
          row: { ...patch, updated_at: serializeHLC(ts) },
          where,
        };
        await applier.apply(entry);
        // Return 1 as best-effort signal that the operation was dispatched.
        return 1;
      },

      async deleteRow(table, where) {
        resolveTable(table);
        const ts = clock.now();
        const entry: AppSyncableRowEntry = {
          timestamp: ts,
          appId,
          table,
          op: "delete",
          where,
        };
        await applier.apply(entry);
        return 1;
      },

      async queryRows(table, where) {
        resolveTable(table);
        // Reads go directly to the applier's store (no change-log roundtrip
        // needed — reads don't produce entries).
        if (typeof (applier as QueryCapableApplier).queryRows === "function") {
          return (applier as QueryCapableApplier).queryRows(appId, table, where);
        }
        throw new Error("The configured applier does not support queryRows");
      },

      async putFile(subKey, bytes, mimeType) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        await fileStorage.put(key, bytes, { contentType: mimeType });
        return { key };
      },

      async getFile(subKey) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        const result = await fileStorage.get(key);
        if (!result) return null;
        const data =
          result.data instanceof Uint8Array
            ? result.data
            : new Uint8Array(result.data as ArrayBuffer);
        return { bytes: data, mimeType: result.contentType ?? "application/octet-stream" };
      },

      async deleteFile(subKey) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        await fileStorage.delete(key);
      },

      async fileUrl(subKey, opts) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        const result = await fileStorage.get(key);
        if (!result) return null;
        const mimeType = result.contentType ?? "application/octet-stream";
        const expiresIn = opts?.expiresIn ?? 3600;
        return buildFileUrl ? buildFileUrl(key, mimeType, expiresIn) : null;
      },
    };
  };
}

/** Optional capability for appliers that can execute read queries. */
interface QueryCapableApplier extends AppSyncableApplier {
  queryRows(
    appId: string,
    table: string,
    where?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
}
