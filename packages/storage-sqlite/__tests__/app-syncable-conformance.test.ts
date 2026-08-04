/**
 * `SqliteAppSyncableApplier` against the shared applier contract.
 *
 * The same suite runs against the sync-engine mock. Everything the sync tests
 * believe about app-syncable rows is believed on the mock's word, so the two
 * have to answer identically or those tests are asserting about a system that
 * does not exist. They did not: this file's tombstone cases fail outright
 * against the applier as it was, because a scanned tombstone carried no primary
 * key and the receiving `UPDATE` therefore matched every row in the table.
 */

import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  appSyncableApplierConformance,
  type ConformanceHarness,
} from "@starkeep/storage-adapter/conformance";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
} from "@starkeep/shared-space-api";
import { SqliteAppSyncableApplier } from "../src/app-syncable/apply.js";
import { appSyncableTableName } from "../src/app-syncable/namespace.js";

const APP = "conformance-app";
const TABLE = "test_rows";

function makeHarness(): ConformanceHarness {
  const db = new DatabaseSync(":memory:");
  const fullName = appSyncableTableName(APP, TABLE);
  // The same column set the installer creates for a syncable table: the caller's
  // columns plus the three the protocol owns.
  db.exec(
    `CREATE TABLE ${fullName} (
       id TEXT PRIMARY KEY,
       payload TEXT,
       updated_at TEXT,
       deleted_at TEXT,
       node_id TEXT
     )`,
  );
  db.exec(
    `CREATE INDEX idx_${fullName}_node_watermark ON ${fullName} (node_id, updated_at)`,
  );

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
    applier: new SqliteAppSyncableApplier(db as never, namespaces) as never,
    appId: APP,
    table: TABLE,
    async liveIds() {
      return db
        .prepare(`SELECT id FROM ${fullName} WHERE deleted_at IS NULL ORDER BY id`)
        .all()
        .map((row) => String((row as { id: string }).id));
    },
    async peer() {
      return makeHarness();
    },
  };
}

describe("app-syncable applier conformance — SQLite", () => {
  for (const testCase of appSyncableApplierConformance) {
    it(testCase.name, async () => {
      await testCase.run(makeHarness());
    });
  }
});
