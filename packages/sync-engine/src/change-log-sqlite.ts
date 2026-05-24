import type { DatabaseSync } from "node:sqlite";
import { generateId } from "@starkeep/core";
import type { HLCTimestamp } from "@starkeep/core";
import type { ChangeLog, ChangeLogEntry } from "./types.js";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sync_change_log (
    change_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
    timestamp_wall INTEGER NOT NULL,
    timestamp_counter INTEGER NOT NULL,
    timestamp_node TEXT NOT NULL,
    record_snapshot_json TEXT NOT NULL,
    base_version INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )
`;

const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_sync_change_log_ts ON sync_change_log(timestamp_wall, timestamp_counter, timestamp_node)",
  "CREATE INDEX IF NOT EXISTS idx_sync_change_log_record ON sync_change_log(record_id)",
];

export interface SqliteChangeLogOptions {
  readonly db: DatabaseSync;
  /**
   * If set, `getChangesSince` returns only entries whose
   * `recordSnapshot.originAppId` matches. Used by the local sync supervisor to
   * give each per-app sync engine a view of only that app's pending writes.
   * `append` and `prune` ignore this filter — the log is a single shared
   * outbox; filtering happens at read time.
   */
  readonly originAppIdFilter?: string;
}

/**
 * Durable SQLite-backed implementation of `ChangeLog`. Intended to share a
 * database file with the records table so changes can (eventually) be
 * persisted atomically alongside application mutations.
 */
export function createSqliteChangeLog(
  options: SqliteChangeLogOptions,
): ChangeLog {
  const { db, originAppIdFilter } = options;
  db.exec(CREATE_TABLE_SQL);
  for (const sql of CREATE_INDEXES_SQL) db.exec(sql);

  const insertStmt = db.prepare(
    `INSERT INTO sync_change_log (
      change_id, record_id, operation,
      timestamp_wall, timestamp_counter, timestamp_node,
      record_snapshot_json, base_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const selectSinceStmt = db.prepare(
    `SELECT change_id, record_id, operation,
            timestamp_wall, timestamp_counter, timestamp_node,
            record_snapshot_json, base_version
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
      entry: Omit<ChangeLogEntry, "changeId">,
    ): Promise<ChangeLogEntry> {
      const changeId = generateId();
      insertStmt.run(
        changeId,
        entry.recordId,
        entry.operation,
        entry.timestamp.wallTime,
        entry.timestamp.counter,
        entry.timestamp.nodeId,
        JSON.stringify(entry.recordSnapshot),
        entry.baseVersion,
      );
      return { ...entry, changeId } as ChangeLogEntry;
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
      const entries = rows.map(rowToEntry);
      if (originAppIdFilter === undefined) return entries;
      return entries.filter(
        (e) => e.recordSnapshot.originAppId === originAppIdFilter,
      );
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
  record_id: string;
  operation: "create" | "update" | "delete";
  timestamp_wall: number;
  timestamp_counter: number;
  timestamp_node: string;
  record_snapshot_json: string;
  base_version: number | null;
}

function rowToEntry(row: RawRow): ChangeLogEntry {
  return {
    changeId: row.change_id as ChangeLogEntry["changeId"],
    recordId: row.record_id as ChangeLogEntry["recordId"],
    operation: row.operation,
    timestamp: {
      wallTime: row.timestamp_wall,
      counter: row.timestamp_counter,
      nodeId: row.timestamp_node,
    },
    recordSnapshot: JSON.parse(row.record_snapshot_json),
    baseVersion: row.base_version,
  };
}
