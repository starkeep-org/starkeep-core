import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  createStarkeepId,
  SyncStatus,
  type CreateDataRecordInput,
} from "@starkeep/core";
import { SqliteDatabaseAdapter } from "../src/adapter.js";

// Every DataRecord is now file-backed; tests must supply the file fields.
function baseInput(over: Partial<CreateDataRecordInput> = {}): CreateDataRecordInput {
  return {
    type: "@test/photo",
    ownerId: "u1",
    originAppId: "test",
    contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
    objectStorageKey: `shared/@test/photo/ab/${Math.random().toString(36).slice(2)}`,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    ...over,
  };
}

describe("SqliteDatabaseAdapter", () => {
  let adapter: SqliteDatabaseAdapter;
  const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 1000 });

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
        baseInput({ contentHash: "sha256:abc", originalFilename: "sunset.jpg" }),
        clock,
      );
      await adapter.put(record);

      const retrieved = await adapter.get(record.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(record.id);
      expect(retrieved!.kind).toBe("data");
      expect(retrieved!.type).toBe("@test/photo");
      expect(retrieved!.originalFilename).toBe("sunset.jpg");
      expect(retrieved!.contentHash).toBe("sha256:abc");
      expect(retrieved!.mimeType).toBe("image/jpeg");
      expect(retrieved!.sizeBytes).toBe(1024);
    });

    it("should return null for non-existent ID", async () => {
      const id = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(await adapter.get(id)).toBeNull();
    });

    it("should upsert on put with same ID", async () => {
      const record = createDataRecord(baseInput(), clock);
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
      const record = createDataRecord(baseInput(), clock);
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
      await adapter.put(createDataRecord(baseInput({ type: "@test/photo" }), clock));
      await adapter.put(createDataRecord(baseInput({ type: "@test/video" }), clock));

      const result = await adapter.query({ type: "@test/photo" });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].type).toBe("@test/photo");
    });

    it("should support eq filter", async () => {
      await adapter.put(createDataRecord(baseInput({ ownerId: "u1" }), clock));
      await adapter.put(createDataRecord(baseInput({ ownerId: "u2" }), clock));

      const result = await adapter.query({
        filters: [{ field: "ownerId", operator: "eq", value: "u2" }],
      });
      expect(result.records).toHaveLength(1);
      expect(result.records[0].ownerId).toBe("u2");
    });

    it("should support like filter", async () => {
      await adapter.put(createDataRecord(baseInput({ type: "@test/photo-jpeg" }), clock));
      await adapter.put(createDataRecord(baseInput({ type: "@test/video-mp4" }), clock));

      const result = await adapter.query({
        filters: [{ field: "type", operator: "like", value: "photo" }],
      });
      expect(result.records).toHaveLength(1);
    });

    it("should support sorting", async () => {
      await adapter.put(createDataRecord(baseInput({ type: "@test/b" }), clock));
      await adapter.put(createDataRecord(baseInput({ type: "@test/a" }), clock));

      const result = await adapter.query({
        sort: [{ field: "type", direction: "asc" }],
      });
      expect(result.records[0].type).toBe("@test/a");
      expect(result.records[1].type).toBe("@test/b");
    });

    it("should support descending sort", async () => {
      await adapter.put(createDataRecord(baseInput({ type: "@test/a" }), clock));
      await adapter.put(createDataRecord(baseInput({ type: "@test/b" }), clock));

      const result = await adapter.query({
        sort: [{ field: "type", direction: "desc" }],
      });
      expect(result.records[0].type).toBe("@test/b");
    });

    it("should support limit and cursor pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.put(createDataRecord(baseInput({ type: "@test/item" }), clock));
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

  describe("batch", () => {
    it("should apply multiple operations atomically", async () => {
      const record1 = createDataRecord(baseInput({ type: "@test/a" }), clock);
      const record2 = createDataRecord(baseInput({ type: "@test/b" }), clock);
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
      const record = createDataRecord(baseInput({ type: "@test/a" }), clock);
      await adapter.transaction(async (transaction) => {
        await transaction.put(record);
      });
      expect(await adapter.get(record.id)).not.toBeNull();
    });

    it("should rollback on error", async () => {
      const record = createDataRecord(baseInput({ type: "@test/a" }), clock);
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

  describe("metadata", () => {
    it("stores and retrieves a per-type metadata row", async () => {
      const record = createDataRecord(baseInput({ type: "image" }), clock);
      await adapter.put(record);
      await adapter.putMetadata("image", {
        recordId: record.id,
        width: 1920,
        height: 1080,
        captured_at: "2024-01-01T10:00:00",
      });

      const row = await adapter.getMetadata("image", record.id);
      expect(row).not.toBeNull();
      expect(row!["width"]).toBe(1920);
      expect(row!["height"]).toBe(1080);
      expect(row!["captured_at"]).toBe("2024-01-01T10:00:00");
    });

    it("deleteMetadata removes the row", async () => {
      const record = createDataRecord(baseInput({ type: "image" }), clock);
      await adapter.put(record);
      await adapter.putMetadata("image", { recordId: record.id, width: 1, height: 1 });
      await adapter.deleteMetadata("image", record.id);
      expect(await adapter.getMetadata("image", record.id)).toBeNull();
    });
  });
});
