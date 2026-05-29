import { compareHLC, serializeHLC } from "@starkeep/core";
import type {
  AppSyncableApplier,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableRowEntry,
  ScanCapableApplier,
} from "../../src/types.js";

// Mirror of `FILE_RECORDS_TABLE` from `@starkeep/shared-space-api` and
// `sync-engine.ts` — kept in sync by hand because importing across the cycle
// isn't possible.
export const FILE_RECORDS_TABLE = "_starkeep_sync_records";

export interface MockAppRowStore {
  readonly applier: AppSyncableApplier & ScanCapableApplier;
  readonly namespaces: AppSyncableNamespaceStore;
  /** Direct row access for assertions; keyed by `${appId}::${table}::${pk}`. */
  readonly rows: Map<string, AppSyncableRowEntry>;
}

export interface TableSpec {
  readonly name: string;
  readonly pkColumns: readonly string[];
}

/**
 * In-memory `AppSyncableApplier` + namespace store for tests. LWW-on-timestamp
 * apply, scan returns all rows newer than a given HLC string. Matches the
 * semantics of the storage-sqlite/storage-aurora-dsql appliers closely enough
 * for sync-engine tests; details of SQL UPSERT generation are out of scope.
 */
export function makeMockAppSource(
  appId: string,
  tables: readonly TableSpec[],
): MockAppRowStore {
  const rows = new Map<string, AppSyncableRowEntry>();
  const ns: AppSyncableNamespace = {
    appId,
    tables: tables.map((t) => ({ name: t.name, pkColumns: [...t.pkColumns] })),
    filesEnabled: tables.some((t) => t.name === FILE_RECORDS_TABLE),
    tableNames: tables.map((t) => t.name),
  };
  const namespaces: AppSyncableNamespaceStore = {
    get: (id) => (id === appId ? ns : null),
    list: () => [ns],
  };

  function pkOf(entry: AppSyncableRowEntry): string {
    const tableInfo = tables.find((t) => t.name === entry.table);
    if (!tableInfo || tableInfo.pkColumns.length === 0) {
      return JSON.stringify(entry.row ?? entry.where ?? {});
    }
    const src = entry.row ?? entry.where ?? {};
    return tableInfo.pkColumns.map((c) => String(src[c])).join("/");
  }

  const applier: AppSyncableApplier & ScanCapableApplier = {
    async apply(entry) {
      const key = `${entry.appId}::${entry.table}::${pkOf(entry)}`;
      const existing = rows.get(key);
      if (existing && compareHLC(existing.timestamp, entry.timestamp) >= 0) {
        return;
      }
      rows.set(key, entry);
    },
    async scanSince(scanAppId, table, sinceHlcStr, options) {
      const floor =
        options?.cursor !== undefined && options.cursor > sinceHlcStr
          ? options.cursor
          : sinceHlcStr;
      const matches: AppSyncableRowEntry[] = [];
      for (const e of rows.values()) {
        if (e.appId !== scanAppId || e.table !== table) continue;
        if (serializeHLC(e.timestamp) > floor) matches.push(e);
      }
      matches.sort((a, b) =>
        serializeHLC(a.timestamp).localeCompare(serializeHLC(b.timestamp)),
      );
      const limit = options?.limit;
      const hasMore = limit !== undefined && matches.length > limit;
      const pageRows = hasMore ? matches.slice(0, limit) : matches;
      const nextCursor =
        hasMore && pageRows.length > 0
          ? serializeHLC(pageRows[pageRows.length - 1]!.timestamp)
          : null;
      return { rows: pageRows, nextCursor, hasMore };
    },
  };

  return { applier, namespaces, rows };
}
