import type { DatabaseSync } from "node:sqlite";
import { generateId } from "@starkeep/core";
import type { HLCTimestamp } from "@starkeep/core";
import type {
  ChangeLog,
  ChangeLogEntry,
  RecordChangeLogEntry,
  AppSyncableRowLogEntry,
} from "./types.js";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sync_change_log (
    change_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'record',
    record_id TEXT,
    operation TEXT CHECK(operation IN ('create', 'update', 'delete')),
    timestamp_wall INTEGER NOT NULL,
    timestamp_counter INTEGER NOT NULL,
    timestamp_node TEXT NOT NULL,
    record_snapshot_json TEXT,
    base_version INTEGER,
    app_id TEXT,
    table_name TEXT,
    app_op TEXT CHECK(app_op IN ('insert', 'update', 'delete')),
    row_json TEXT,
    where_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )
`;

const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_sync_change_log_ts ON sync_change_log(timestamp_wall, timestamp_counter, timestamp_node)",
  "CREATE INDEX IF NOT EXISTS idx_sync_change_log_record ON sync_change_log(record_id)",
];

export interface SqliteChangeLogOptions {
  readonly db: DatabaseSync;
}

/**
 * Durable SQLite-backed implementation of `ChangeLog`. Intended to share a
 * database file with the records table so changes can (eventually) be
 * persisted atomically alongside application mutations.
 */
export function createSqliteChangeLog(
  options: SqliteChangeLogOptions,
): ChangeLog {
  const { db } = options;
  db.exec(CREATE_TABLE_SQL);
  for (const sql of CREATE_INDEXES_SQL) db.exec(sql);

  const insertRecordStmt = db.prepare(
    `INSERT INTO sync_change_log (
      change_id, kind, record_id, operation,
      timestamp_wall, timestamp_counter, timestamp_node,
      record_snapshot_json, base_version
    ) VALUES (?, 'record', ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertAppRowStmt = db.prepare(
    `INSERT INTO sync_change_log (
      change_id, kind, timestamp_wall, timestamp_counter, timestamp_node,
      app_id, table_name, app_op, row_json, where_json
    ) VALUES (?, 'appSyncableRow', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const selectSinceStmt = db.prepare(
    `SELECT change_id, kind,
            record_id, operation,
            timestamp_wall, timestamp_counter, timestamp_node,
            record_snapshot_json, base_version,
            app_id, table_name, app_op, row_json, where_json
     FROM sync_change_log
     WHERE (timestamp_wall > ?)
        OR (timestamp_wall = ? AND timestamp_counter > ?)
        OR (timestamp_wall = ? AND timestamp_counter = ? AND timestamp_node > ?)
     ORDER BY timestamp_wall, timestamp_counter, timestamp_node`,
  );

  const selectLatestStmt = db.prepare(
    `SELECT timestamp_wall, timestamp_counter, timestamp_node
     FROM sync_change_log
     ORDER BY timestamp_wall DESC, timestamp_counter DESC, timestamp_node DESC
     LIMIT 1`,
  );

  return {
    async append(
      entry: Omit<RecordChangeLogEntry, "changeId"> | Omit<AppSyncableRowLogEntry, "changeId">,
    ): Promise<ChangeLogEntry> {
      const changeId = generateId();
      if (entry.kind === "record") {
        insertRecordStmt.run(
          changeId,
          entry.recordId,
          entry.operation,
          entry.timestamp.wallTime,
          entry.timestamp.counter,
          entry.timestamp.nodeId,
          JSON.stringify(entry.recordSnapshot),
          entry.baseVersion,
        );
        return { ...entry, changeId } as RecordChangeLogEntry;
      } else {
        insertAppRowStmt.run(
          changeId,
          entry.timestamp.wallTime,
          entry.timestamp.counter,
          entry.timestamp.nodeId,
          entry.appId,
          entry.table,
          entry.op,
          entry.row ? JSON.stringify(entry.row) : null,
          entry.where ? JSON.stringify(entry.where) : null,
        );
        return { ...entry, changeId } as AppSyncableRowLogEntry;
      }
    },

    async getChangesSince(
      timestamp: HLCTimestamp,
    ): Promise<ChangeLogEntry[]> {
      const rows = selectSinceStmt.all(
        timestamp.wallTime,
        timestamp.wallTime,
        timestamp.counter,
        timestamp.wallTime,
        timestamp.counter,
        timestamp.nodeId,
      ) as unknown as RawRow[];
      return rows.map(rowToEntry);
    },

    async getLatestTimestamp(): Promise<HLCTimestamp | null> {
      const row = selectLatestStmt.get() as
        | { timestamp_wall: number; timestamp_counter: number; timestamp_node: string }
        | undefined;
      if (!row) return null;
      return {
        wallTime: row.timestamp_wall,
        counter: row.timestamp_counter,
        nodeId: row.timestamp_node,
      };
    },

    async prune(olderThan: HLCTimestamp): Promise<number> {
      const before = (db
        .prepare("SELECT COUNT(*) as n FROM sync_change_log")
        .get() as { n: number }).n;
      db.prepare(
        `DELETE FROM sync_change_log WHERE
            (timestamp_wall < ?)
         OR (timestamp_wall = ? AND timestamp_counter < ?)
         OR (timestamp_wall = ? AND timestamp_counter = ? AND timestamp_node < ?)`,
      ).run(
        olderThan.wallTime,
        olderThan.wallTime,
        olderThan.counter,
        olderThan.wallTime,
        olderThan.counter,
        olderThan.nodeId,
      );
      const after = (db
        .prepare("SELECT COUNT(*) as n FROM sync_change_log")
        .get() as { n: number }).n;
      return before - after;
    },
  };
}

interface RawRow {
  change_id: string;
  kind: string;
  record_id: string | null;
  operation: "create" | "update" | "delete" | null;
  timestamp_wall: number;
  timestamp_counter: number;
  timestamp_node: string;
  record_snapshot_json: string | null;
  base_version: number | null;
  app_id: string | null;
  table_name: string | null;
  app_op: "insert" | "update" | "delete" | null;
  row_json: string | null;
  where_json: string | null;
}

function rowToEntry(row: RawRow): ChangeLogEntry {
  const ts = {
    wallTime: row.timestamp_wall,
    counter: row.timestamp_counter,
    nodeId: row.timestamp_node,
  };
  if (row.kind === "appSyncableRow") {
    return {
      kind: "appSyncableRow",
      changeId: row.change_id as AppSyncableRowLogEntry["changeId"],
      timestamp: ts,
      appId: row.app_id!,
      table: row.table_name!,
      op: row.app_op!,
      row: row.row_json ? JSON.parse(row.row_json) : undefined,
      where: row.where_json ? JSON.parse(row.where_json) : undefined,
    };
  }
  return {
    kind: "record",
    changeId: row.change_id as RecordChangeLogEntry["changeId"],
    recordId: row.record_id as RecordChangeLogEntry["recordId"],
    operation: row.operation!,
    timestamp: ts,
    recordSnapshot: JSON.parse(row.record_snapshot_json!),
    baseVersion: row.base_version,
  };
}
