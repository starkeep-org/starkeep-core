import type { DatabaseSync } from "node:sqlite";
import type { SyncStateStore, Watermarks } from "./types.js";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )
`;

const WATERMARKS = "watermarks";
const PEER_WATERMARKS = "peer_watermarks";
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
    async getWatermarks(): Promise<Watermarks> {
      return getJson<Watermarks>(WATERMARKS) ?? {};
    },
    async setWatermarks(watermarks: Watermarks): Promise<void> {
      setJson(WATERMARKS, watermarks);
    },
    async getPeerWatermarks(): Promise<Watermarks> {
      return getJson<Watermarks>(PEER_WATERMARKS) ?? {};
    },
    async setPeerWatermarks(watermarks: Watermarks): Promise<void> {
      setJson(PEER_WATERMARKS, watermarks);
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
