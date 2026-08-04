/**
 * `DsqlAppSyncableApplier` executed rather than merely spelled.
 *
 * `apply.test.ts` can only pin *statement shapes* — it runs against a fake
 * client that records SQL and returns nothing — and it says so. That is a real
 * limit, not a stylistic one: the two things this applier most depends on are
 * `ON CONFLICT … WHERE excluded.updated_at > table.updated_at` and the
 * `updated_at IS NULL OR updated_at < ?` guard, and both are *behaviours* of
 * whatever executes them rather than facts about the text. A shape assertion
 * cannot tell you that `ON CONFLICT DO UPDATE … WHERE` skips the row rather
 * than erroring, or that `<` is unknown against NULL, or that a `WHERE`-less
 * `UPDATE` matches the whole table — which is precisely the defect the tombstone
 * cases exist for.
 *
 * ## What this does and does not establish
 *
 * The engine in this repo is **Aurora DSQL**. Postgres is not part of the
 * system; DSQL is Postgres-*compatible*, and this applier only ever emits SQL
 * from the compatible subset — plain `INSERT … ON CONFLICT`, `UPDATE … WHERE`,
 * `GROUP BY`, string comparison on a `TEXT` column. PGlite is Postgres compiled
 * to WASM, so running these statements through it exercises that subset with a
 * real planner and executor, in process, with no server and no native
 * dependency.
 *
 * So what this file proves is: *the SQL this applier emits means what the
 * contract requires, under an engine that implements the dialect it is written
 * in.* It is not a DSQL conformance test and must not be read as one — DSQL's
 * OCC, its distributed commit and its own restrictions are not modelled here,
 * and `occ-retry.ts` and the live cloud e2e are where those are covered. What
 * was being taken purely on trust before this was the far more basic claim, and
 * that is the claim this closes.
 */

import { describe, it, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  appSyncableApplierConformance,
  type ConformanceHarness,
} from "@starkeep/storage-adapter/conformance";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
} from "@starkeep/sync-engine";
import { DsqlAppSyncableApplier } from "../src/app-syncable/apply.js";
import type { DatabaseClient } from "../src/types.js";

const APP = "conformance-app";
const TABLE = "test_rows";
/** What the applier derives from `APP`: dashes become underscores. */
const SCHEMA = `app_${APP.replace(/-/g, "_")}`;

/**
 * One database per harness.
 *
 * A schema per harness would be cheaper, but it cannot work: the schema name is
 * *derived from the appId*, and `peer()` exists so a scanned page can be applied
 * verbatim into a second node — which means the peer has to answer to the same
 * appId as the sender. Two databases is the honest way to get two stores with
 * one identity.
 */
const open: PGlite[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

/** The `DatabaseClient` shape the applier talks to, over PGlite. */
function clientFor(pg: PGlite): DatabaseClient {
  return {
    async query(text: string, values?: unknown[]) {
      const result = await pg.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async end() {},
  };
}

async function makeHarness(): Promise<ConformanceHarness> {
  const pg = new PGlite();
  await pg.waitReady;
  open.push(pg);

  // The same column set `dsql-ddl.ts` emits for a syncable table: the app's own
  // columns plus the three the protocol owns, and the index the delta scan and
  // the digest both seek.
  await pg.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.${TABLE} (
      id TEXT PRIMARY KEY,
      payload TEXT,
      updated_at TEXT,
      node_id TEXT,
      deleted_at TEXT
    );
    CREATE INDEX idx_${TABLE}_node_watermark
      ON ${SCHEMA}.${TABLE} (node_id, updated_at);
  `);

  const ns: AppSyncableNamespace = {
    appId: APP,
    tables: [{ name: TABLE, pkColumns: ["id"] }],
    filesEnabled: false,
    tableNames: [TABLE],
  };
  const namespaces: AppSyncableNamespaceStore = {
    get: (id) => (id === APP ? ns : null),
    list: () => [ns],
  };

  return {
    applier: new DsqlAppSyncableApplier(clientFor(pg), namespaces) as never,
    appId: APP,
    table: TABLE,
    async liveIds() {
      const result = await pg.query<{ id: string }>(
        `SELECT id FROM ${SCHEMA}.${TABLE} WHERE deleted_at IS NULL ORDER BY id`,
      );
      return result.rows.map((r) => String(r.id));
    },
    peer: makeHarness,
  };
}

describe("app-syncable applier conformance — the DSQL applier, executed", () => {
  for (const testCase of appSyncableApplierConformance) {
    it(testCase.name, async () => {
      await testCase.run(await makeHarness());
    }, 60_000);
  }
});
