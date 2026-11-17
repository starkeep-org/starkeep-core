import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql } from "kysely";
import { sqliteCompiler as qb } from "@starkeep/storage-sqlite";
import type { SyncStateStore, Watermarks } from "@starkeep/sync-engine";

/**
 * Every `sync_state` key one app's channel writes. One list, so that deleting
 * an app's sync state cannot miss a key a later change adds to the store.
 */
export function perAppSyncStateKeys(appId: string) {
  return {
    watermarks: `${appId}:watermarks`,
    peerWatermarks: `${appId}:peer_watermarks`,
    repairFloors: `${appId}:repair_floors`,
    inboundFloors: `${appId}:inbound_floors`,
    byteWatermarks: `${appId}:byte_watermarks`,
    peerByteWatermarks: `${appId}:peer_byte_watermarks`,
  } as const;
}

/**
 * Delete one app's channel state: every per-app `sync_state` key. The shared
 * HLC clock state stays, because every channel on this node uses it.
 *
 * Deleting an app's data on this node makes its watermarks false: they claim
 * the node holds rows it no longer has, so a reinstall would never pull them
 * back. The caller stops the app's engine and waits for its drain first,
 * because a drain that finishes afterwards writes the watermarks again.
 */
export function deletePerAppSyncState(db: RawDatabase, appId: string): void {
  // A node that never signed in never created the table.
  const exists = qb
    .selectFrom("sqlite_master")
    .select("name")
    .where("type", "=", "table")
    .where("name", "=", "sync_state")
    .compile();
  if (!db.prepare(exists.sql).get(...(exists.parameters as string[]))) return;
  const keys = Object.values(perAppSyncStateKeys(appId));
  const compiled = qb.deleteFrom("sync_state").where("key", "in", keys).compile();
  db.prepare(compiled.sql).run(...(compiled.parameters as string[]));
}

/**
 * Wraps an underlying SyncStateStore so per-channel state is scoped by appId.
 * Watermark lookups are keyed as `${appId}:watermarks` / `${appId}:peer_watermarks`
 * and read/written directly against the same `sync_state` table that
 * `createSqliteSyncStateStore` manages. HLC clock state is shared across apps
 * (one wall clock per node) — those methods pass through unmodified.
 */
export function createPerAppSyncStateStore(
  db: RawDatabase,
  underlying: SyncStateStore,
  appId: string,
): SyncStateStore {
  const {
    watermarks: watermarksKey,
    peerWatermarks: peerWatermarksKey,
    repairFloors: repairFloorsKey,
    inboundFloors: inboundFloorsKey,
    byteWatermarks: byteWatermarksKey,
    peerByteWatermarks: peerByteWatermarksKey,
  } = perAppSyncStateKeys(appId);

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
    async getByteWatermarks(): Promise<Watermarks | null> {
      return getJson<Watermarks>(byteWatermarksKey);
    },
    async setByteWatermarks(watermarks: Watermarks): Promise<void> {
      setJson(byteWatermarksKey, watermarks);
    },
    async getPeerByteWatermarks(): Promise<Watermarks | null> {
      return getJson<Watermarks>(peerByteWatermarksKey);
    },
    async setPeerByteWatermarks(watermarks: Watermarks): Promise<void> {
      setJson(peerByteWatermarksKey, watermarks);
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
