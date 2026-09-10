/**
 * The query grammar against SQLite.
 *
 * Half of a pair: the Postgres half is in
 * `storage-aurora-dsql/__tests__/app-syncable-query-conformance.test.ts`, and
 * several of these cases are worth nothing unless both halves run them. Null
 * ordering, `avg`'s return type and `LIKE`'s case sensitivity are the three
 * places the engines disagree by default, and a grammar that promised one
 * answer while only one engine was ever asked would be a promise nothing kept.
 */

import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyConnectionPragmas } from "../src/schema/bootstrap.js";
import {
  appSyncableQueryConformance,
  QUERY_COLUMNS,
  type QueryConformanceHarness,
} from "@starkeep/storage-adapter/conformance/query";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
} from "@starkeep/shared-space-api";
import { SqliteAppSyncableApplier } from "../src/app-syncable/apply.js";
import { appSyncableTableName } from "../src/app-syncable/namespace.js";

const APP = "query-conformance-app";
const TABLE = "rows_under_test";

/** What the local installer emits for each declared column type. */
const SQLITE_TYPES: Record<string, string> = {
  text: "TEXT",
  // SQLite's INTEGER is already 64-bit, so bigint needs no separate affinity.
  integer: "INTEGER",
  bigint: "INTEGER",
  real: "REAL",
  blob: "BLOB",
  boolean: "INTEGER",
  // A logical type over a physical text column — see LogicalColumnType.
  timestamp: "TEXT",
};

function makeHarness(): QueryConformanceHarness {
  const db = new DatabaseSync(":memory:");
  // The same connection settings the real local server applies. `like` means
  // one thing on both backends only because of these.
  applyConnectionPragmas(db as never);
  const fullName = appSyncableTableName(APP, TABLE);
  const columns = QUERY_COLUMNS.map((c) => {
    // The installer's domain constraint for a declared boolean, since SQLite's
    // INTEGER affinity is not one. Present here so the suite runs against the
    // table shape the installer actually creates.
    const check = c.type === "boolean" ? ` CHECK (${c.name} IN (0, 1))` : "";
    return `${c.name} ${SQLITE_TYPES[c.type]}${check}${c.primaryKey ? " PRIMARY KEY" : ""}`;
  }).join(", ");
  db.exec(`CREATE TABLE ${fullName} (${columns})`);
  db.exec(`CREATE INDEX idx_${fullName}_node_watermark ON ${fullName} (node_id, updated_at)`);

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
    applier: new SqliteAppSyncableApplier(db as never, namespaces) as never,
    appId: APP,
    table: TABLE,
  };
}

describe("app-syncable query conformance — SQLite", () => {
  for (const testCase of appSyncableQueryConformance) {
    it(testCase.name, async () => {
      await testCase.run(makeHarness());
    });
  }
});
