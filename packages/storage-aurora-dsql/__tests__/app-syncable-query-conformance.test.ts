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
  METADATA_SHAPED_COLUMNS,
  QUERY_COLUMNS,
  type QueryConformanceHarness,
} from "@starkeep/storage-adapter/conformance/query";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
} from "@starkeep/sync-engine";
import { pgColumnType } from "@starkeep/protocol-primitives";
import { PG_RAW_PARSERS } from "../src/pg-timestamps.js";
import { DsqlAppSyncableApplier } from "../src/app-syncable/apply.js";
import type { DatabaseClient } from "../src/types.js";

const APP = "query-conformance-app";
const TABLE = "rows_under_test";
const METADATA_TABLE = "metadata_shaped";
const SCHEMA = `app_${APP.replace(/-/g, "_")}`;

const open: PGlite[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

function clientFor(pg: PGlite): DatabaseClient {
  return {
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
  };
}

async function makeHarness(): Promise<QueryConformanceHarness> {
  const pg = new PGlite();
  await pg.waitReady;
  open.push(pg);

  const columns = QUERY_COLUMNS.map(
    (c) => `${c.name} ${pgColumnType(c.type)}${c.primaryKey ? " PRIMARY KEY" : ""}`,
  ).join(", ");
  // The metadata-shaped table: a primary key, two ordinary columns, and no
  // `deleted_at`. Created from the same declared list the case reads, so the
  // suite cannot be checking a table shape the schema never describes.
  const metadataColumns = METADATA_SHAPED_COLUMNS.map(
    (c) => `${c.name} ${pgColumnType(c.type)}${c.primaryKey ? " PRIMARY KEY" : ""}`,
  ).join(", ");
  await pg.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.${TABLE} (${columns});
    CREATE INDEX idx_${TABLE}_node_watermark ON ${SCHEMA}.${TABLE} (node_id, updated_at);
    CREATE TABLE ${SCHEMA}.${METADATA_TABLE} (${metadataColumns});
  `);

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
    applier: new DsqlAppSyncableApplier(client, namespaces) as never,
    appId: APP,
    table: TABLE,
    metadataShapedTable: METADATA_TABLE,
    async seedMetadataShaped(rows) {
      // Written directly rather than through the applier: the applier's LWW
      // upsert needs `updated_at`, and this table deliberately has none.
      for (const row of rows) {
        const names = Object.keys(row);
        await client.query(
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
