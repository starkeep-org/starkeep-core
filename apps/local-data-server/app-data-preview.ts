/**
 * What deleting an app's kept data on this machine would destroy, read before
 * the operator confirms.
 *
 * The dialog shows counts only. An earlier version also showed sample values,
 * which disclosed note bodies and filenames on a loopback route; counts make
 * the warning concrete without that.
 *
 * App-syncable tables are soft-deleted: a retracted row stays with
 * `deleted_at` set so its tombstone can ship. Counting those would overstate
 * the loss, so every count here excludes them.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql } from "kysely";
import { compareHLC, deserializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import { appSyncableTableName, sqliteCompiler as qb } from "@starkeep/storage-sqlite";
import { FILE_RECORDS_TABLE, type AppSyncableTableInfo } from "@starkeep/shared-space-api";
import { perAppSyncStateKeys } from "./per-app-sync-state-store.js";

export interface AppDataPreviewTable {
  /** Manifest-declared table name. */
  name: string;
  /** Rows not soft-deleted. */
  rowCount: number;
}

/**
 * Whether the cloud holds a copy of this app's data, as far as this machine
 * knows from its last exchange with the cloud.
 *
 * - `none`: this machine never exchanged the app's data with the cloud.
 * - `current`: the cloud had every row and file this machine holds.
 * - `behind`: this machine holds rows or files the cloud had not received.
 */
export type CloudCopy = "none" | "current" | "behind";

export interface AppDataPreview {
  appId: string;
  /** Declared tables. The reserved file-records table is counted as files. */
  tables: AppDataPreviewTable[];
  totalRows: number;
  /** Null when the app keeps no files. */
  files: { count: number; totalBytes: number } | null;
  cloudCopy: CloudCopy;
}

export function buildAppDataPreview(
  db: RawDatabase,
  appId: string,
  tables: readonly AppSyncableTableInfo[],
  filesEnabled: boolean,
): AppDataPreview {
  const declared = tables.filter((t) => t.name !== FILE_RECORDS_TABLE);
  const previewTables = declared.map((t) => ({
    name: t.name,
    rowCount: countLive(db, appSyncableTableName(appId, t.name)),
  }));
  const files = filesEnabled ? countFiles(db, appId) : null;
  return {
    appId,
    tables: previewTables,
    totalRows: previewTables.reduce((sum, t) => sum + t.rowCount, 0),
    files,
    cloudCopy: cloudCopyOf(
      db,
      appId,
      tables.map((t) => t.name),
    ),
  };
}

function cloudCopyOf(db: RawDatabase, appId: string, tableNames: string[]): CloudCopy {
  const peer = readJson<Record<string, HLCTimestamp>>(
    db,
    perAppSyncStateKeys(appId).peerWatermarks,
  );
  if (peer === null) return "none";
  // Every author's newest local row, tombstones included, against how far the
  // cloud said it held that author at the last exchange.
  for (const name of tableNames) {
    const physical = appSyncableTableName(appId, name);
    if (!tableExists(db, physical)) continue;
    const compiled = qb
      .selectFrom(physical)
      .select(["node_id", (eb) => eb.fn.max("updated_at").as("max_updated_at")])
      .groupBy("node_id")
      .compile();
    const rows = db.prepare(compiled.sql).all(...(compiled.parameters as string[])) as Array<{
      node_id: string;
      max_updated_at: string;
    }>;
    for (const row of rows) {
      const held = peer[row.node_id];
      if (!held || compareHLC(deserializeHLC(row.max_updated_at), held) > 0) return "behind";
    }
  }
  if (pendingUploads(db, appId) > 0) return "behind";
  return "current";
}

function pendingUploads(db: RawDatabase, appId: string): number {
  if (!tableExists(db, "upload_queue")) return 0;
  const compiled = qb
    .selectFrom("upload_queue")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("channel", "=", appId)
    .compile();
  const row = db.prepare(compiled.sql).get(...(compiled.parameters as string[])) as
    | { n: unknown }
    | undefined;
  return Number(row?.n ?? 0);
}

function countLive(db: RawDatabase, physical: string): number {
  if (!tableExists(db, physical)) return 0;
  const compiled = qb
    .selectFrom(physical)
    .select((eb) => eb.fn.countAll().as("n"))
    .where("deleted_at", "is", null)
    .compile();
  const row = db.prepare(compiled.sql).get(...(compiled.parameters as string[])) as
    | { n: unknown }
    | undefined;
  return Number(row?.n ?? 0);
}

function countFiles(db: RawDatabase, appId: string): { count: number; totalBytes: number } {
  const physical = appSyncableTableName(appId, FILE_RECORDS_TABLE);
  if (!tableExists(db, physical)) return { count: 0, totalBytes: 0 };
  const compiled = qb
    .selectFrom(physical)
    .select([
      (eb) => eb.fn.countAll().as("n"),
      () => sql<number>`coalesce(sum(size_bytes), 0)`.as("bytes"),
    ])
    .where("deleted_at", "is", null)
    .compile();
  const row = db.prepare(compiled.sql).get(...(compiled.parameters as string[])) as
    | { n: unknown; bytes: unknown }
    | undefined;
  return { count: Number(row?.n ?? 0), totalBytes: Number(row?.bytes ?? 0) };
}

function tableExists(db: RawDatabase, name: string): boolean {
  const compiled = qb
    .selectFrom("sqlite_master")
    .select("name")
    .where("type", "=", "table")
    .where("name", "=", name)
    .compile();
  return db.prepare(compiled.sql).get(...(compiled.parameters as string[])) !== undefined;
}

function readJson<T>(db: RawDatabase, key: string): T | null {
  if (!tableExists(db, "sync_state")) return null;
  const compiled = qb
    .selectFrom("sync_state")
    .select("value_json")
    .where("key", "=", key)
    .compile();
  const row = db.prepare(compiled.sql).get(...(compiled.parameters as string[])) as
    | { value_json: string }
    | undefined;
  return row ? (JSON.parse(row.value_json) as T) : null;
}
