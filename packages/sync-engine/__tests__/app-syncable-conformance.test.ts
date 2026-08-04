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

function makeHarness(): ConformanceHarness {
  const store = makeMockAppSource(APP, [{ name: TABLE, pkColumns: ["id"] }]);
  return {
    applier: store.applier as never,
    appId: APP,
    table: TABLE,
    async liveIds() {
      const prefix = `${APP}::${TABLE}::`;
      return [...store.rows.entries()]
        .filter(([key, row]) => key.startsWith(prefix) && !row["deleted_at"])
        .map(([, row]) => String(row["id"]))
        .sort();
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
