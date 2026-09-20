import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql } from "kysely";
import { syncStateCompiler as qb } from "./sync-state-sqlite.js";
import type { SyncStateStore, Watermarks } from "./types.js";

/**
 * Wraps an underlying SyncStateStore so per-channel state is scoped by appId.
 * Watermark lookups are keyed as `${appId}:watermarks` / `${appId}:peer_watermarks`
 * and read/written directly against the same `sync_state` table that
 * `createSqliteSyncStateStore` manages. HLC clock state is shared across apps
 * (one wall clock per node) — those methods pass through unmodified.
 */
/**
 * Every `sync_state` key this store owns for one app.
 *
 * One list, read by both the store that writes the keys and the removal that
 * deletes them, so a fifth watermark cannot be added to the first and
 * forgotten by the second. Enumerated rather than matched with a `LIKE`
 * pattern: a prefix match is one wildcard character in an app id away from
 * taking another app's rows with it.
 */
export function perAppSyncStateKeys(appId: string): string[] {
  return [
    `${appId}:watermarks`,
    `${appId}:peer_watermarks`,
    `${appId}:repair_floors`,
    `${appId}:inbound_floors`,
  ];
}

/**
 * Drop one app's sync position on this node, so a later install of the same
 * app id starts reading the cloud from the beginning instead of from wherever
 * the removed copy had reached.
 *
 * The caller has to have stopped that app's sync engine first. An engine
 * draining a round writes its watermark back at the end of it, and a watermark
 * written after this deletion is exactly the stale one the deletion exists to
 * remove.
 */
export function deletePerAppSyncState(db: RawDatabase, appId: string): void {
  // `createSqliteSyncStateStore` creates the table, and it runs only on a node
  // configured with a cloud. A node that has never synced therefore has no
  // watermark to clear, and asking is cheaper than letting the removal fail on
  // a table whose absence already means the answer is "nothing to do".
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .all("sync_state");
  if (exists.length === 0) return;

  const keys = perAppSyncStateKeys(appId);
  const stmt = db.prepare(
    qb
      .deleteFrom("sync_state")
      .where(
        "key",
        "in",
        keys.map(() => sql.raw("?")),
      )
      .compile().sql,
  );
  stmt.run(...keys);
}

export function createPerAppSyncStateStore(
  db: RawDatabase,
  underlying: SyncStateStore,
  appId: string,
): SyncStateStore {
  const [watermarksKey, peerWatermarksKey, repairFloorsKey, inboundFloorsKey] = perAppSyncStateKeys(
    appId,
  ) as [string, string, string, string];

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
    async getRepairFloors(): Promise<Watermarks> {
      return getJson<Watermarks>(repairFloorsKey) ?? {};
    },
    async setRepairFloors(floors: Watermarks): Promise<void> {
      setJson(repairFloorsKey, floors);
    },
    async getInboundFloors(): Promise<Watermarks> {
      return getJson<Watermarks>(inboundFloorsKey) ?? {};
    },
    async setInboundFloors(floors: Watermarks): Promise<void> {
      setJson(inboundFloorsKey, floors);
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
