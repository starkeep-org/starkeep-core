import type { HLCClock } from "@starkeep/protocol-primitives";
import { serializeHLC } from "@starkeep/protocol-primitives";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { appSyncableObjectKey } from "@starkeep/protocol-primitives";
import type {
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  AppSyncableRowEntry,
  ChangeNotifier,
} from "@starkeep/sync-engine";
import type { AppSpecificOperations, ApiSubject } from "../types.js";
import { validateTableName } from "./validation.js";
import { FILE_RECORDS_TABLE, RESERVED_TABLE_NAMES } from "./reserved.js";

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
  /**
   * Optional notifier. When provided, every successful app-specific write
   * (row insert/update/delete, file put/delete) emits a `local-change-recorded`
   * event tagged with the calling app's id so the sync supervisor can nudge
   * the owning per-app engine. Omit if you don't want app-specific writes to
   * wake the sync loop (e.g. cloud-server use where there is no supervisor).
   */
  changeNotifier?: ChangeNotifier;
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
  const { namespace, applier, fileStorage, buildFileUrl, clock, changeNotifier } = options;

  return (subject) => {
    if (subject.subjectType !== "app") return null;
    const appId = subject.subjectId;
    const ns = namespace.get(appId);
    if (!ns) return null;

    function emitLocalChange(): void {
      changeNotifier?.emit({
        eventType: "local-change-recorded",
        recordIds: [],
        timestamp: clock.now(),
        originAppId: appId,
      });
    }
    // Framework-reserved tables (e.g. `_starkeep_sync_records`) live in
    // ns.tables so the applier and pull scanner see them, but apps must not
    // be able to address them through insertRow/updateRow/etc.
    const declaredTables = new Set(
      ns.tableNames.filter((t) => !RESERVED_TABLE_NAMES.has(t)),
    );

    function resolveTable(table: string): void {
      validateTableName(table);
      if (RESERVED_TABLE_NAMES.has(table)) {
        throw new Error(
          `Table "${table}" is reserved by the sync runtime and not writable by apps`,
        );
      }
      if (!declaredTables.has(table)) {
        throw new Error(`App "${appId}" did not declare app-syncable table "${table}"`);
      }
    }

    async function upsertFileRecord(
      key: string,
      meta: {
        contentHash: string;
        mimeType: string;
        sizeBytes: number;
        originalFilename?: string | null;
      },
    ): Promise<void> {
      const ts = clock.now();
      const tsStr = serializeHLC(ts);
      const row: Record<string, unknown> = {
        id: key,
        object_storage_key: key,
        content_hash: meta.contentHash,
        mime_type: meta.mimeType,
        size_bytes: meta.sizeBytes,
        original_filename: meta.originalFilename ?? null,
        origin_app_id: appId,
        created_at: tsStr,
        updated_at: tsStr,
        deleted_at: null,
      };
      const entry: AppSyncableRowEntry = {
        timestamp: ts,
        appId,
        table: FILE_RECORDS_TABLE,
        op: "insert",
        row,
      };
      await applier.apply(entry);
    }

    /**
     * Read the reserved `_starkeep_sync_records` index row for `key`, bypassing
     * the `resolveTable` guard that (correctly) blocks apps from addressing the
     * reserved table through the normal query path. Returns null when no live
     * (non-tombstoned) row exists. `queryRows` already filters `deleted_at`.
     */
    async function readFileRecord(
      key: string,
    ): Promise<Record<string, unknown> | null> {
      const capable = applier as QueryCapableApplier;
      if (typeof capable.queryRows !== "function") {
        throw new Error("The configured applier does not support queryRows");
      }
      const rows = await capable.queryRows(appId, FILE_RECORDS_TABLE, { id: key });
      return rows[0] ?? null;
    }

    async function tombstoneFileRecord(key: string): Promise<void> {
      const ts = clock.now();
      const tsStr = serializeHLC(ts);
      // Soft-delete via the standard LWW applier delete path. The applier
      // also bumps updated_at on the row so the tombstone propagates.
      const entry: AppSyncableRowEntry = {
        timestamp: ts,
        appId,
        table: FILE_RECORDS_TABLE,
        op: "delete",
        row: { updated_at: tsStr },
        where: { id: key },
      };
      await applier.apply(entry);
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
        emitLocalChange();
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
        emitLocalChange();
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
        emitLocalChange();
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

      async registerFile(
        subKey: string,
        meta: {
          contentHash: string;
          mimeType: string;
          sizeBytes: number;
          originalFilename?: string | null;
        },
      ) {
        // Records the index row for bytes already uploaded out-of-band (the
        // direct-to-S3 presign flow), so the file becomes visible to statFile
        // and cross-channel sync without the server ever holding the bytes.
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        await upsertFileRecord(key, meta);
        emitLocalChange();
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

      async statFile(subKey: string) {
        // Existence + metadata from the index row — no S3 round-trip and no
        // byte download. The index is the authoritative existence signal.
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        const row = await readFileRecord(key);
        if (!row) return null;
        return {
          mimeType: (row["mime_type"] as string) ?? "application/octet-stream",
          sizeBytes: Number(row["size_bytes"] ?? 0),
          contentHash: (row["content_hash"] as string) ?? "",
        };
      },

      async deleteFile(subKey) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        await fileStorage.delete(key);
        await tombstoneFileRecord(key);
        emitLocalChange();
      },

      async fileUrl(subKey, opts) {
        ensureFilesEnabled();
        const key = appSyncableObjectKey(appId, subKey);
        // Existence via the index (no byte download); presign only if present.
        const row = await readFileRecord(key);
        if (!row) return null;
        const mimeType = (row["mime_type"] as string) ?? "application/octet-stream";
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
