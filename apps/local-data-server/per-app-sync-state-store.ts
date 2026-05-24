import type { DatabaseSync } from "node:sqlite";
import type { HLCTimestamp } from "@starkeep/core";
import type { SyncStateStore } from "@starkeep/sync-engine";

/**
 * Wraps an underlying SyncStateStore so cursors are scoped per app. Cursor
 * lookups are keyed as `${appId}:pull_cursor` / `${appId}:push_cursor` and
 * read/written directly against the same `sync_state` table that
 * `createSqliteSyncStateStore` manages. HLC clock state is shared across
 * apps (one wall clock per node) — those methods pass through to the
 * underlying store unmodified.
 */
export function createPerAppSyncStateStore(
  db: DatabaseSync,
  underlying: SyncStateStore,
  appId: string,
): SyncStateStore {
  const pullKey = `${appId}:pull_cursor`;
  const pushKey = `${appId}:push_cursor`;

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
      return getJson<HLCTimestamp>(pullKey);
    },
    async setPullCursor(ts: HLCTimestamp): Promise<void> {
      setJson(pullKey, ts);
    },
    async getPushCursor(): Promise<HLCTimestamp | null> {
      return getJson<HLCTimestamp>(pushKey);
    },
    async setPushCursor(ts: HLCTimestamp): Promise<void> {
      setJson(pushKey, ts);
    },
    // HLC clock state is shared across apps — pass through unmodified.
    getHlcClockState() {
      return underlying.getHlcClockState();
    },
    setHlcClockState(state) {
      return underlying.setHlcClockState(state);
    },
  };
}
