/**
 * The stand-in slot index, against a real SQLite store and the mock adapter
 * that stands in for it elsewhere. The DSQL index has the same shape and is
 * pinned by `dsql-schema-init`'s own tests; both engines treat NULL as
 * distinct in a unique index, which is the whole of the rule.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type CreateDataRecordInput,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  isStandInSlotConflict,
  type DatabaseAdapter,
} from "@starkeep/storage-adapter";
import { SqliteDatabaseAdapter } from "../src/adapter.js";
import { nodeSqliteDriver } from "../src/node-driver.js";

const clock = createHLCClock({ nodeId: "test" });

function record(over: Partial<CreateDataRecordInput> & { hash: string }): DataRecord {
  const { hash, ...rest } = over;
  return createDataRecord(
    {
      type: "image/avif",
      originAppId: "test",
      contentHash: hash,
      objectStorageKey: `shared/image/ab/${hash}`,
      sizeBytes: 100,
      ...rest,
    },
    clock,
  );
}

const PARENT = "01ORIGINAL0000000000000000" as StarkeepId;
const OTHER_PARENT = "01ORIGINAL0000000000000001" as StarkeepId;

const engines: Array<[string, () => Promise<{ db: DatabaseAdapter; close: () => Promise<void> }>]> = [
  [
    "sqlite",
    async () => {
      const db = new SqliteDatabaseAdapter({ path: ":memory:", driver: nodeSqliteDriver });
      await db.init();
      return { db, close: () => db.close() };
    },
  ],
  [
    "mock",
    async () => {
      const db = new MockDatabaseAdapter();
      await db.init();
      return { db, close: () => db.close() };
    },
  ],
];

for (const [engine, open] of engines) {
  describe(`stand-in slot index (${engine})`, () => {
    let db: DatabaseAdapter;
    let close: () => Promise<void>;
    beforeEach(async () => {
      ({ db, close } = await open());
    });
    afterEach(async () => {
      await close();
    });

    async function rejects(r: DataRecord): Promise<void> {
      let caught: unknown = null;
      try {
        await db.put(r);
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect(isStandInSlotConflict(caught)).toBe(true);
    }

    it("refuses a second live canonical stand-in for one original", async () => {
      await db.put(record({ hash: "a", parentId: PARENT, standInRole: "canonical", fidelity: 4272 }));
      await rejects(record({ hash: "b", parentId: PARENT, standInRole: "canonical", fidelity: 4272 }));
    });

    it("refuses a second live stand-in at one size", async () => {
      await db.put(record({ hash: "a", parentId: PARENT, standInRole: "smaller", fidelity: 640 }));
      await rejects(record({ hash: "b", parentId: PARENT, standInRole: "smaller", fidelity: 640 }));
    });

    it("keeps different sizes and different originals apart", async () => {
      await db.put(record({ hash: "a", parentId: PARENT, standInRole: "smaller", fidelity: 640 }));
      await db.put(record({ hash: "b", parentId: PARENT, standInRole: "smaller", fidelity: 320 }));
      await db.put(record({ hash: "c", parentId: OTHER_PARENT, standInRole: "smaller", fidelity: 640 }));
      await db.put(record({ hash: "d", parentId: PARENT, standInRole: "canonical", fidelity: 4272 }));
      await db.put(record({ hash: "e", parentId: OTHER_PARENT, standInRole: "canonical", fidelity: 4272 }));
    });

    it("lets a tombstone free its slot, through delete and through a tombstoned put", async () => {
      const first = record({ hash: "a", parentId: PARENT, standInRole: "canonical", fidelity: 4272 });
      await db.put(first);
      await db.delete(first.id, clock.now());
      await db.put(record({ hash: "b", parentId: PARENT, standInRole: "canonical", fidelity: 4272 }));

      const small = record({ hash: "c", parentId: PARENT, standInRole: "smaller", fidelity: 640 });
      await db.put(small);
      await db.put({ ...small, deletedAt: clock.now(), updatedAt: clock.now() });
      await db.put(record({ hash: "d", parentId: PARENT, standInRole: "smaller", fidelity: 640 }));
    });

    it("never constrains ordinary or derived records", async () => {
      await db.put(record({ hash: "a", type: "image/jpeg", fidelity: 6000 }));
      await db.put(record({ hash: "b", type: "image/jpeg", fidelity: 6000 }));
      await db.put(record({ hash: "c", parentId: PARENT, originalFilename: "poster-1" }));
      await db.put(record({ hash: "d", parentId: PARENT, originalFilename: "poster-2" }));
    });

    it("lets a stand-in be rewritten in place", async () => {
      const r = record({ hash: "a", parentId: PARENT, standInRole: "smaller", fidelity: 640 });
      await db.put(r);
      await db.put({ ...r, updatedAt: clock.now() });
      const back = await db.get(r.id);
      expect(back).toMatchObject({ standInRole: "smaller", fidelity: 640 });
    });

    it("round-trips the role and the fidelity", async () => {
      const original = record({ hash: "o", type: "image/jpeg", fidelity: 6000 });
      await db.put(original);
      expect(await db.get(original.id)).toMatchObject({ standInRole: null, fidelity: 6000 });
    });

    it("filters on the role and the fidelity", async () => {
      await db.put(record({ hash: "o", type: "image/jpeg", fidelity: 6000 }));
      await db.put(record({ hash: "a", parentId: PARENT, standInRole: "smaller", fidelity: 640 }));
      await db.put(record({ hash: "b", parentId: PARENT, standInRole: "canonical", fidelity: 4272 }));
      const standIns = await db.query({ filters: [{ field: "standInRole", operator: "isNotNull" }] });
      expect(standIns.records.map((r) => r.fidelity).sort()).toEqual([4272, 640]);
      const originals = await db.query({ filters: [{ field: "standInRole", operator: "isNull" }] });
      expect(originals.records.map((r) => r.fidelity)).toEqual([6000]);
    });
  });
}
