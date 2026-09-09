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
import { parseQuery } from "../query/parse.js";
import type {
  ParsedQuery,
  ParsedQueryResult,
  QueryTableSchema,
} from "../query/types.js";
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
     * The table description the parser validates against.
     *
     * Built from the namespace registry rather than from a manifest, because
     * the data servers never see a manifest. A registry row written before
     * column types existed reports `columns: null`, and the parser narrows what
     * it will answer accordingly — see `QueryTableSchema.columns`.
     */
    function schemaFor(table: string): QueryTableSchema {
      const info = ns!.tables.find((t) => t.name === table)!;
      return {
        name: table,
        pkColumns: info.pkColumns,
        columns: info.columns ?? null,
        // App tables carry no platform edges, so there is nothing to hydrate.
        includable: [],
      };
    }

    function requireQueryCapable(): QueryCapableApplier {
      const capable = applier as QueryCapableApplier;
      if (typeof capable.runQuery !== "function") {
        throw new Error("The configured applier does not support queries");
      }
      return capable;
    }

    /**
     * Read the reserved `_starkeep_sync_records` index row for `key`, bypassing
     * the `resolveTable` guard that (correctly) blocks apps from addressing the
     * reserved table through the normal query path. Returns null when no live
     * (non-tombstoned) row exists; the query path always excludes tombstones.
     *
     * The query is built here rather than parsed from parameters because this
     * is the framework reading its own bookkeeping, not an app asking a
     * question — there is no caller input to validate.
     */
    async function readFileRecord(
      key: string,
    ): Promise<Record<string, unknown> | null> {
      const result = await requireQueryCapable().runQuery(appId, FILE_RECORDS_TABLE, {
        mode: "rows",
        table: FILE_RECORDS_TABLE,
        select: null,
        where: [{ column: "id", predicate: { op: "eq", value: key } }],
        order: [{ column: "id", direction: "asc", nulls: "last" }],
        limit: 1,
        pageToken: null,
        include: [],
      });
      return result.mode === "rows" ? (result.rows[0] ?? null) : null;
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

      async query(table, params) {
        resolveTable(table);
        // Parse, then run. Reads go directly to the applier's store — no
        // change-log roundtrip, since a read produces no entry.
        const parsed = parseQuery(schemaFor(table), params);
        return requireQueryCapable().runQuery(appId, table, parsed);
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
  runQuery(
    appId: string,
    table: string,
    query: ParsedQuery,
  ): Promise<ParsedQueryResult>;
}
