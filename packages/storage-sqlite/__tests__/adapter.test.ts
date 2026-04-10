import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  createStarkeepId,
  SyncStatus,
} from "@starkeep/core";
import { SqliteDatabaseAdapter } from "../src/adapter.js";

describe("SqliteDatabaseAdapter", () => {
  let adapter: SqliteDatabaseAdapter;
  const clock = createHLCClock({ nodeId: "test", wallClockFn: () => 1000 });

  beforeEach(async () => {
    adapter = new SqliteDatabaseAdapter({ path: ":memory:" });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
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
      const record = createDataRecord(
        {
          type: "@test/photo",
          ownerId: "u1",
          content: { name: "sunset.jpg" },
          contentHash: "sha256:abc",
          mimeType: "image/jpeg",
          sizeBytes: 1024,
        },
        clock,
      );
      await adapter.put(record);

      const retrieved = await adapter.get(record.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(record.id);
      expect(retrieved!.kind).toBe("data");
      expect(retrieved!.type).toBe("@test/photo");
      expect(retrieved!.content).toEqual({ name: "sunset.jpg" });
      expect(retrieved!.contentHash).toBe("sha256:abc");
      expect(retrieved!.mimeType).toBe("image/jpeg");
      expect(retrieved!.sizeBytes).toBe(1024);
    });

    it("should return null for non-existent ID", async () => {
      const id = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(await adapter.get(id)).toBeNull();
    });

    it("should upsert on put with same ID", async () => {
      const record = createDataRecord({ type: "@test/photo", ownerId: "u1" }, clock);
      await adapter.put(record);

      const updated = { ...record, version: 2, syncStatus: SyncStatus.Synced };
      await adapter.put(updated);

      const retrieved = await adapter.get(record.id);
      expect(retrieved!.version).toBe(2);
      expect(retrieved!.syncStatus).toBe(SyncStatus.Synced);
    });
  });

  describe("delete", () => {
    it("should remove a record", async () => {
      const record = createDataRecord({ type: "@test/photo", ownerId: "u1" }, clock);
      await adapter.put(record);
      await adapter.delete(record.id);
      expect(await adapter.get(record.id)).toBeNull();
    });

    it("should not throw when deleting non-existent record", async () => {
      const id = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      await expect(adapter.delete(id)).resolves.not.toThrow();
    });
  });

  describe("query", () => {
    it("should filter by type", async () => {
      await adapter.put(createDataRecord({ type: "@test/photo", ownerId: "u1" }, clock));
      await adapter.put(createDataRecord({ type: "@test/video", ownerId: "u1" }, clock));

      const result = await adapter.query({ type: "@test/photo" });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].type).toBe("@test/photo");
    });

    it("should support eq filter", async () => {
      await adapter.put(createDataRecord({ type: "@test/photo", ownerId: "u1" }, clock));
      await adapter.put(createDataRecord({ type: "@test/photo", ownerId: "u2" }, clock));

      const result = await adapter.query({
        filters: [{ field: "ownerId", operator: "eq", value: "u2" }],
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].ownerId).toBe("u2");
    });

    it("should support like filter", async () => {
      await adapter.put(createDataRecord({ type: "@test/photo-jpeg", ownerId: "u1" }, clock));
      await adapter.put(createDataRecord({ type: "@test/video-mp4", ownerId: "u1" }, clock));

      const result = await adapter.query({
        filters: [{ field: "type", operator: "like", value: "photo" }],
      });
      expect(result.records).toHaveLength(1);
    });

    it("should support sorting", async () => {
      await adapter.put(createDataRecord({ type: "@test/b", ownerId: "u1" }, clock));
      await adapter.put(createDataRecord({ type: "@test/a", ownerId: "u1" }, clock));

      const result = await adapter.query({
        sort: [{ field: "type", direction: "asc" }],
      });
      expect(result.records[0].type).toBe("@test/a");
      expect(result.records[1].type).toBe("@test/b");
    });

    it("should support descending sort", async () => {
      await adapter.put(createDataRecord({ type: "@test/a", ownerId: "u1" }, clock));
      await adapter.put(createDataRecord({ type: "@test/b", ownerId: "u1" }, clock));

      const result = await adapter.query({
        sort: [{ field: "type", direction: "desc" }],
      });
      expect(result.records[0].type).toBe("@test/b");
    });

    it("should support limit and cursor pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.put(createDataRecord({ type: `@test/item`, ownerId: "u1" }, clock));
      }

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
  });

  describe("ensureMetadataTable / putMetadata / queryMetadata", () => {
    it("should store and retrieve metadata", async () => {
      const targetType = "todo:task";
      const generatorId = "tasks:properties";
      const targetId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

      await adapter.ensureMetadataTable(targetType, generatorId, [
        { name: "status", columnType: "text" },
        { name: "comment_count", columnType: "integer" },
      ]);

      await adapter.putMetadata(targetType, {
        targetId,
        generatorId,
        generatorVersion: 1,
        inputHash: "hash-abc",
        value: { status: "todo", commentCount: 3 },
      });

      const result = await adapter.queryMetadata(targetType, { targetId });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].generatorId).toBe(generatorId);
      expect(result.entries[0].value).toMatchObject({ status: "todo", commentCount: 3 });
    });

    it("should filter by generatorId", async () => {
      const targetType = "todo:task";
      const targetId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");

      await adapter.ensureMetadataTable(targetType, "gen-a", [{ name: "x", columnType: "integer" }]);
      await adapter.ensureMetadataTable(targetType, "gen-b", [{ name: "y", columnType: "text" }]);

      await adapter.putMetadata(targetType, { targetId, generatorId: "gen-a", generatorVersion: 1, inputHash: "h1", value: { x: 1 } });
      await adapter.putMetadata(targetType, { targetId, generatorId: "gen-b", generatorVersion: 1, inputHash: "h2", value: { y: "hello" } });

      const result = await adapter.queryMetadata(targetType, { targetId, generatorId: "gen-a" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].generatorId).toBe("gen-a");
    });
  });

  describe("batch", () => {
    it("should apply multiple operations atomically", async () => {
      const record1 = createDataRecord({ type: "@test/a", ownerId: "u1" }, clock);
      const record2 = createDataRecord({ type: "@test/b", ownerId: "u1" }, clock);
      await adapter.put(record1);

      await adapter.batch([
        { type: "put", record: record2 },
        { type: "delete", id: record1.id },
      ]);

      expect(await adapter.get(record1.id)).toBeNull();
      expect(await adapter.get(record2.id)).not.toBeNull();
    });
  });

  describe("transaction", () => {
    it("should commit on success", async () => {
      const record = createDataRecord({ type: "@test/a", ownerId: "u1" }, clock);
      await adapter.transaction(async (transaction) => {
        await transaction.put(record);
      });
      expect(await adapter.get(record.id)).not.toBeNull();
    });

    it("should rollback on error", async () => {
      const record = createDataRecord({ type: "@test/a", ownerId: "u1" }, clock);
      await adapter.put(record);

      await expect(
        adapter.transaction(async (transaction) => {
          await transaction.delete(record.id);
          throw new Error("boom");
        }),
      ).rejects.toThrow();

      expect(await adapter.get(record.id)).not.toBeNull();
    });
  });

  describe("migrations", () => {
    it("should run pending migrations", async () => {
      let migrationRan = false;
      await adapter.runMigrations([
        {
          version: 1,
          name: "test-migration",
          up: async () => {
            migrationRan = true;
          },
        },
      ]);
      expect(migrationRan).toBe(true);
    });

    it("should skip already applied migrations", async () => {
      let runCount = 0;
      const migration = {
        version: 1,
        name: "test-migration",
        up: async () => { runCount++; },
      };

      await adapter.runMigrations([migration]);
      await adapter.runMigrations([migration]);
      expect(runCount).toBe(1);
    });

    it("should run migrations in order", async () => {
      const order: number[] = [];
      await adapter.runMigrations([
        { version: 2, name: "second", up: async () => { order.push(2); } },
        { version: 1, name: "first", up: async () => { order.push(1); } },
      ]);
      expect(order).toEqual([1, 2]);
    });
  });
});
