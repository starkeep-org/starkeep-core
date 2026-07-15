import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { sqliteCompiler as qb } from "@starkeep/storage-sqlite";
import type { SyncStateStore, Watermarks } from "@starkeep/sync-engine";

/**
 * Wraps an underlying SyncStateStore so per-channel state is scoped by appId.
 * Watermark lookups are keyed as `${appId}:watermarks` / `${appId}:peer_watermarks`
 * and read/written directly against the same `sync_state` table that
 * `createSqliteSyncStateStore` manages. HLC clock state is shared across apps
 * (one wall clock per node) — those methods pass through unmodified.
 */
export function createPerAppSyncStateStore(
  db: DatabaseSync,
  underlying: SyncStateStore,
  appId: string,
): SyncStateStore {
  const watermarksKey = `${appId}:watermarks`;
  const peerWatermarksKey = `${appId}:peer_watermarks`;

  // sql.raw("?") leaves positional placeholders in the compiled SQL so the
  // statements can be prepared once here and bound per call below.
  const getStmt = db.prepare(
    qb.selectFrom("sync_state").select("value_json").where("key", "=", sql.raw("?")).compile().sql,
  );
  const setStmt = db.prepare(
    qb
      .insertInto("sync_state")
      .values({
        key: sql.raw("?"),
        value_json: sql.raw("?"),
        updated_at: sql`strftime('%s','now')`,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet((eb) => ({
          value_json: eb.ref("excluded.value_json"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .compile().sql,
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
      return getJson<Watermarks>(watermarksKey) ?? {};
    },
    async setWatermarks(watermarks: Watermarks): Promise<void> {
      setJson(watermarksKey, watermarks);
    },
    async getPeerWatermarks(): Promise<Watermarks> {
      return getJson<Watermarks>(peerWatermarksKey) ?? {};
    },
    async setPeerWatermarks(watermarks: Watermarks): Promise<void> {
      setJson(peerWatermarksKey, watermarks);
    },
    // HLC clock state is shared across apps — pass through unmodified.
    getHlcClockState() {
      return underlying.getHlcClockState();
    },
    setHlcClockState(state: { wallTime: number; counter: number }) {
      return underlying.setHlcClockState(state);
    },
  };
}
