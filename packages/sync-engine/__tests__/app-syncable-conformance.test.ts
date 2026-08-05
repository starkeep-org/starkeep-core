/**
 * The mock applier, held to the same contract as the real ones.
 *
 * The identical suite runs in `storage-sqlite/__tests__/app-syncable-conformance.test.ts`
 * against `SqliteAppSyncableApplier`. That pairing is the point: this package's
 * entire app-syncable story is told through a mock, and a mock that answers a
 * question differently from the thing it stands in for is worse than no test at
 * all — it is a green suite over a broken system, which is what it was.
 */

import { describe, it } from "vitest";
import {
  appSyncableApplierConformance,
  type ConformanceHarness,
} from "@starkeep/storage-adapter/conformance";
import { makeMockAppSource } from "./sync-test-harness/mock-app-source.js";

const APP = "conformance-app";
const TABLE = "test_rows";
const COMPOSITE_TABLE = "tenant_rows";

function makeHarness(): ConformanceHarness {
  const store = makeMockAppSource(APP, [
    { name: TABLE, pkColumns: ["id"] },
    { name: COMPOSITE_TABLE, pkColumns: ["tenant", "id"] },
  ]);
  const applier = store.applier;
  const broken = new Set<string>();

  /**
   * The mock's stand-in for a table that exists and will not read.
   *
   * The SQL harnesses drop a column the applier's own queries name, which is a
   * fault in the storage. There is no storage here to fault, so the two read
   * methods are wrapped instead. What matters for the contract is the same
   * either way: a present table whose read fails must throw rather than answer
   * with the empty value, which is the wire value for "this table holds
   * nothing".
   */
  const guarded = {
    ...applier,
    apply: applier.apply.bind(applier),
    scanSince: applier.scanSince.bind(applier),
    async bucketDigest(appId: string, table: string, prefixLength?: number) {
      if (broken.has(table)) throw new Error(`[harness] ${table} will not read`);
      return applier.bucketDigest(appId, table, prefixLength);
    },
    async getNodeWatermarks(appId: string, table: string) {
      if (broken.has(table)) throw new Error(`[harness] ${table} will not read`);
      return applier.getNodeWatermarks(appId, table);
    },
  };

  return {
    applier: guarded as never,
    appId: APP,
    table: TABLE,
    compositeTable: COMPOSITE_TABLE,
    async liveIds() {
      const prefix = `${APP}::${TABLE}::`;
      return [...store.rows.entries()]
        .filter(([key, row]) => key.startsWith(prefix) && !row["deleted_at"])
        .map(([, row]) => String(row["id"]))
        .sort();
    },
    async breakReads() {
      broken.add(TABLE);
    },
    async peer() {
      return makeHarness();
    },
  };
}

describe("app-syncable applier conformance — in-memory mock", () => {
  for (const testCase of appSyncableApplierConformance) {
    it(testCase.name, async () => {
      await testCase.run(makeHarness());
    });
  }
});
