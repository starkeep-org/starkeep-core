import { describe, it, expect, beforeEach } from "vitest";
import { createHLCClock, createDataRecord, createStarkeepId } from "@starkeep/core";
import { MockDatabaseAdapter } from "../src/mock/mock-database-adapter.js";

describe("MockDatabaseAdapter", () => {
  let adapter: MockDatabaseAdapter;
  const clock = createHLCClock({ nodeId: "test", wallClockFn: () => 1000 });

  beforeEach(async () => {
    adapter = new MockDatabaseAdapter();
    await adapter.init();
  });

  describe("lifecycle", () => {
    it("should report healthy after init", async () => {
      expect(await adapter.healthCheck()).toBe(true);
    });

    it("should report unhealthy after close", async () => {
      await adapter.close();
      expect(await adapter.healthCheck()).toBe(false);
    });
  });

  describe("put / get", () => {
    it("should store and retrieve a data record", async () => {
      const record = createDataRecord({ type: "@test/photo", ownerId: "u1", originAppId: "test" }, clock);
      await adapter.put(record);
      const retrieved = await adapter.get(record.id);
      expect(retrieved).toEqual(record);
    });

    it("should return null for non-existent ID", async () => {
      const id = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(await adapter.get(id)).toBeNull();
    });

    it("should return clones (not same reference)", async () => {
      const record = createDataRecord({ type: "@test/photo", ownerId: "u1", originAppId: "test" }, clock);
      await adapter.put(record);
      const a = await adapter.get(record.id);
      const b = await adapter.get(record.id);
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("delete", () => {
    it("should remove a record", async () => {
      const record = createDataRecord({ type: "@test/photo", ownerId: "u1", originAppId: "test" }, clock);
      await adapter.put(record);
      await adapter.delete(record.id);
      expect(await adapter.get(record.id)).toBeNull();
    });
  });

  describe("query", () => {
    it("should filter by type", async () => {
      const record1 = createDataRecord({ type: "@test/photo", ownerId: "u1", originAppId: "test" }, clock);
      const record2 = createDataRecord({ type: "@test/video", ownerId: "u1", originAppId: "test" }, clock);
      await adapter.put(record1);
      await adapter.put(record2);

      const result = await adapter.query({ type: "@test/photo" });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].type).toBe("@test/photo");
    });

    it("should support limit and cursor pagination", async () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        createDataRecord({ type: `@test/item-${i}`, ownerId: "u1", originAppId: "test" }, clock),
      );
      for (const record of records) await adapter.put(record);

      const page1 = await adapter.query({ limit: 2 });
      expect(page1.records).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await adapter.query({ limit: 2, cursor: page1.nextCursor! });
      expect(page2.records).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      const page3 = await adapter.query({ limit: 2, cursor: page2.nextCursor! });
      expect(page3.records).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
    });

    it("should support eq filter", async () => {
      const record1 = createDataRecord({ type: "@test/photo", ownerId: "u1", originAppId: "test" }, clock);
      const record2 = createDataRecord({ type: "@test/photo", ownerId: "u2", originAppId: "test" }, clock);
      await adapter.put(record1);
      await adapter.put(record2);

      const result = await adapter.query({
        filters: [{ field: "ownerId", operator: "eq", value: "u1" }],
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].ownerId).toBe("u1");
    });

    it("should support sorting", async () => {
      const record1 = createDataRecord({ type: "@test/b", ownerId: "u1", originAppId: "test" }, clock);
      const record2 = createDataRecord({ type: "@test/a", ownerId: "u1", originAppId: "test" }, clock);
      await adapter.put(record1);
      await adapter.put(record2);

      const result = await adapter.query({
        sort: [{ field: "type", direction: "asc" }],
      });
      expect(result.records[0].type).toBe("@test/a");
      expect(result.records[1].type).toBe("@test/b");
    });
  });

  describe("batch", () => {
    it("should apply multiple operations", async () => {
      const record1 = createDataRecord({ type: "@test/a", ownerId: "u1", originAppId: "test" }, clock);
      const record2 = createDataRecord({ type: "@test/b", ownerId: "u1", originAppId: "test" }, clock);
      await adapter.put(record1);

      await adapter.batch([
        { type: "put", record: record2 },
        { type: "delete", id: record1.id },
      ]);

      expect(await adapter.get(record1.id)).toBeNull();
      expect(await adapter.get(record2.id)).toEqual(record2);
    });
  });

  describe("transaction", () => {
    it("should commit changes on success", async () => {
      const record = createDataRecord({ type: "@test/a", ownerId: "u1", originAppId: "test" }, clock);
      await adapter.transaction(async (transaction) => {
        await transaction.put(record);
      });
      expect(await adapter.get(record.id)).toEqual(record);
    });

    it("should rollback on error", async () => {
      const record = createDataRecord({ type: "@test/a", ownerId: "u1", originAppId: "test" }, clock);
      await adapter.put(record);

      await expect(
        adapter.transaction(async (transaction) => {
          await transaction.delete(record.id);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      expect(await adapter.get(record.id)).toEqual(record);
    });
  });
});
