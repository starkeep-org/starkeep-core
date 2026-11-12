/**
 * The query grammar against a real Postgres planner.
 *
 * `app-syncable-conformance.test.ts` explains why PGlite stands in for DSQL and
 * what that does and does not establish. The same reading applies here, with
 * one addition: three of these cases exist *because* Postgres and SQLite
 * disagree — null ordering, `avg`'s return type, and `LIKE`'s case sensitivity
 * — and they are worth nothing unless both suites run them. The SQLite half is
 * in `storage-sqlite/__tests__/app-syncable-query-conformance.test.ts`.
 */

import { describe, it, afterAll, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  appSyncableQueryConformance,
  METADATA_SHAPED_COLUMNS,
  QUERY_COLUMNS,
  type QueryConformanceHarness,
} from "@starkeep/storage-adapter/conformance/query";
import type { AppSyncableNamespace, AppSyncableNamespaceStore } from "@starkeep/sync-engine";
import { pgColumnType } from "@starkeep/protocol-primitives";
import { PG_RAW_PARSERS } from "../../src/pg-timestamps.js";
import { DsqlAppSyncableApplier } from "../../src/app-syncable/apply.js";
import type { DatabaseClient } from "../../src/types.js";
import { guardNodeWatermarks } from "../../src/node-watermarks.js";
import { guardSingleFlight } from "../../src/single-flight.js";
import { createAppNodeWatermarks } from "../pg-shared-schema.js";

const APP = "query-conformance-app";
const TABLE = "rows_under_test";
const METADATA_TABLE = "metadata_shaped";
const SCHEMA = `app_${APP.replace(/-/g, "_")}`;

/**
 * A file-level pool of databases, so a case does not pay a PGlite cold boot
 * (about a second) for each database it needs. `takeDatabase` hands out the
 * next unused one, booting another only when none is free, and resets it with
 * `DROP SCHEMA ${SCHEMA} CASCADE` before the harness re-runs its DDL. That
 * schema is the only one these harnesses create, and dropping it also undoes
 * `breakReads`. Every database goes back to the pool after each case.
 *
 * The query cases build one harness each, so the pool holds one database; the
 * limit matches the applier suite's, where a case and its `peer()` need two. Past
 * it, `takeDatabase` throws rather than handing out a database another harness
 * in the same case is still using.
 */
const POOL_LIMIT = 2;
const pool: { ready: Promise<PGlite>; inUse: boolean }[] = [];

async function takeDatabase(): Promise<PGlite> {
  let slot = pool.find((s) => !s.inUse);
  if (!slot) {
    if (pool.length >= POOL_LIMIT) {
      throw new Error(
        `a conformance case asked for more than ${POOL_LIMIT} live databases; ` +
          "raise POOL_LIMIT if a nested peer() is now intended",
      );
    }
    const pg = new PGlite();
    slot = { ready: pg.waitReady.then(() => pg), inUse: false };
    pool.push(slot);
  }
  // Claimed before the first await, so concurrent callers never share a slot.
  slot.inUse = true;
  const pg = await slot.ready;
  await pg.exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  return pg;
}

afterEach(() => {
  for (const slot of pool) slot.inUse = false;
});

afterAll(async () => {
  await Promise.all(pool.splice(0).map(async (slot) => (await slot.ready).close()));
});

function clientFor(pg: PGlite): DatabaseClient {
  return guardSingleFlight(
    guardNodeWatermarks({
      async query(text: string, values?: unknown[]) {
        // The parsers are part of the connection contract, not test scaffolding:
        // without them the driver turns a `timestamp` into a `Date` using the
        // *process* zone, and a suite that skipped them could not catch the
        // divergence it exists to catch. The SQLite side says the same thing
        // about `applyConnectionPragmas`.
        const result = await pg.query(text, values as unknown[] | undefined, {
          parsers: PG_RAW_PARSERS,
        });
        return { rows: result.rows as Record<string, unknown>[] };
      },
      async end() {},
    }),
    { onOverlap: "throw" },
  );
}

async function makeHarness(): Promise<QueryConformanceHarness> {
  const pg = await takeDatabase();

  // The owner leads every primary key, as `dsql-ddl.ts` emits it.
  const withOwner = (cols: typeof QUERY_COLUMNS) =>
    [
      "user_id TEXT NOT NULL",
      ...cols.map((c) => `${c.name} ${pgColumnType(c.type)}${c.primaryKey ? " NOT NULL" : ""}`),
      `PRIMARY KEY (user_id, ${cols
        .filter((c) => c.primaryKey)
        .map((c) => c.name)
        .join(", ")})`,
    ].join(", ");
  const columns = withOwner(QUERY_COLUMNS);
  // The metadata-shaped table: a primary key, two ordinary columns, and no
  // `deleted_at`. Created from the same declared list the case reads, so the
  // suite cannot be checking a table shape the schema never describes.
  const metadataColumns = withOwner(METADATA_SHAPED_COLUMNS);
  await pg.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.${TABLE} (${columns});
    CREATE INDEX idx_${TABLE}_node_watermark ON ${SCHEMA}.${TABLE} (user_id, node_id, updated_at);
    CREATE TABLE ${SCHEMA}.${METADATA_TABLE} (${metadataColumns});
  `);
  await createAppNodeWatermarks(pg, SCHEMA);

  const ns: AppSyncableNamespace = {
    appId: APP,
    tables: [
      { name: TABLE, pkColumns: ["id"], columns: QUERY_COLUMNS },
      { name: METADATA_TABLE, pkColumns: ["record_id"], columns: METADATA_SHAPED_COLUMNS },
    ],
    filesEnabled: false,
    tableNames: [TABLE, METADATA_TABLE],
  };
  const namespaces: AppSyncableNamespaceStore = {
    get: (id) => (id === APP ? ns : null),
    list: () => [ns],
  };

  const client = clientFor(pg);
  return {
    applier: new DsqlAppSyncableApplier(client, namespaces, "user-a") as never,
    appId: APP,
    table: TABLE,
    metadataShapedTable: METADATA_TABLE,
    async seedMetadataShaped(seeded) {
      // Written directly rather than through the applier: the applier's LWW
      // upsert needs `updated_at`, and this table deliberately has none. Past
      // the guarded client too, which would want a node watermark raised.
      // The owner is the one the applier is scoped to, as the scoped compiler
      // would have written it.
      for (const seed of seeded) {
        const row: Record<string, unknown> = { ...seed, user_id: "user-a" };
        const names = Object.keys(row);
        await pg.query(
          `INSERT INTO ${SCHEMA}.${METADATA_TABLE} (${names.join(", ")}) ` +
            `VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
          names.map((n) => row[n]),
        );
      }
    },
  };
}

describe("app-syncable query conformance — Postgres", () => {
  for (const testCase of appSyncableQueryConformance) {
    it(testCase.name, async () => {
      await testCase.run(await makeHarness());
    });
  }
});
