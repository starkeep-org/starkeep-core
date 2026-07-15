import type { DatabaseSync } from "node:sqlite";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import type { SyncStateStore, Watermarks } from "./types.js";

// Compile-only Kysely instance (DummyDriver never executes); statements run
// synchronously through node:sqlite's prepare().
type DB = Record<string, Record<string, unknown>>;
const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

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
  db.exec(
    qb.schema
      .createTable("sync_state")
      .ifNotExists()
      .addColumn("key", "text", (c) => c.primaryKey())
      .addColumn("value_json", "text", (c) => c.notNull())
      .addColumn("updated_at", "integer", (c) =>
        c.notNull().defaultTo(sql`(strftime('%s','now'))`),
      )
      .compile().sql,
  );

  // sql.raw("?") leaves positional placeholders in the compiled SQL so the
  // statements can be prepared once here and bound per call below.
  const getQuery = qb
    .selectFrom("sync_state")
    .select("value_json")
    .where("key", "=", sql.raw("?"))
    .compile();
  const getStmt = db.prepare(getQuery.sql);
  const setQuery = qb
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
    .compile();
  const setStmt = db.prepare(setQuery.sql);

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
