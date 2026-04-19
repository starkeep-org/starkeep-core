import type { DatabaseSync } from "node:sqlite";
import type { HLCTimestamp } from "@starkeep/core";
import type { SyncStateStore } from "./types.js";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )
`;

const PULL_CURSOR = "pull_cursor";
const PUSH_CURSOR = "push_cursor";
const HLC_CLOCK = "hlc_clock";

export interface SqliteSyncStateStoreOptions {
  readonly db: DatabaseSync;
}

export function createSqliteSyncStateStore(
  options: SqliteSyncStateStoreOptions,
): SyncStateStore {
  const { db } = options;
  db.exec(CREATE_TABLE_SQL);

  const getStmt = db.prepare(
    "SELECT value_json FROM sync_state WHERE key = ?",
  );
  const setStmt = db.prepare(
    `INSERT INTO sync_state (key, value_json, updated_at)
     VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  );

  function getJson<T>(key: string): T | null {
    const row = getStmt.get(key) as { value_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value_json) as T;
  }

  function setJson<T>(key: string, value: T): void {
    setStmt.run(key, JSON.stringify(value));
  }

  return {
    async getPullCursor(): Promise<HLCTimestamp | null> {
      return getJson<HLCTimestamp>(PULL_CURSOR);
    },
    async setPullCursor(ts: HLCTimestamp): Promise<void> {
      setJson(PULL_CURSOR, ts);
    },
    async getPushCursor(): Promise<HLCTimestamp | null> {
      return getJson<HLCTimestamp>(PUSH_CURSOR);
    },
    async setPushCursor(ts: HLCTimestamp): Promise<void> {
      setJson(PUSH_CURSOR, ts);
    },
    async getHlcClockState(): Promise<
      { wallTime: number; counter: number } | null
    > {
      return getJson<{ wallTime: number; counter: number }>(HLC_CLOCK);
    },
    async setHlcClockState(state: {
      wallTime: number;
      counter: number;
    }): Promise<void> {
      setJson(HLC_CLOCK, state);
    },
  };
}
