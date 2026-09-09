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

import { describe, it, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  appSyncableQueryConformance,
  QUERY_COLUMNS,
  type QueryConformanceHarness,
} from "@starkeep/storage-adapter/conformance/query";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
} from "@starkeep/sync-engine";
import { DsqlAppSyncableApplier } from "../src/app-syncable/apply.js";
import type { DatabaseClient } from "../src/types.js";

const APP = "query-conformance-app";
const TABLE = "rows_under_test";
const SCHEMA = `app_${APP.replace(/-/g, "_")}`;

/** What `dsql-ddl.ts` emits for each declared column type. */
const PG_TYPES: Record<string, string> = {
  text: "TEXT",
  integer: "INTEGER",
  bigint: "BIGINT",
  real: "DOUBLE PRECISION",
  blob: "BYTEA",
  boolean: "BOOLEAN",
  // A logical type over a physical text column — see LogicalColumnType.
  timestamp: "TEXT",
};

const open: PGlite[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

function clientFor(pg: PGlite): DatabaseClient {
  return {
    async query(text: string, values?: unknown[]) {
      const result = await pg.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async end() {},
  };
}

async function makeHarness(): Promise<QueryConformanceHarness> {
  const pg = new PGlite();
  await pg.waitReady;
  open.push(pg);

  const columns = QUERY_COLUMNS.map(
    (c) => `${c.name} ${PG_TYPES[c.type]}${c.primaryKey ? " PRIMARY KEY" : ""}`,
  ).join(", ");
  await pg.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.${TABLE} (${columns});
    CREATE INDEX idx_${TABLE}_node_watermark ON ${SCHEMA}.${TABLE} (node_id, updated_at);
  `);

  const ns: AppSyncableNamespace = {
    appId: APP,
    tables: [{ name: TABLE, pkColumns: ["id"], columns: QUERY_COLUMNS }],
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
  };
}

describe("app-syncable query conformance — Postgres", () => {
  for (const testCase of appSyncableQueryConformance) {
    it(testCase.name, async () => {
      await testCase.run(await makeHarness());
    });
  }
});
