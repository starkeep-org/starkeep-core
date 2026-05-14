import { describe, it, expect, beforeEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  createStarkeepId,
  SyncStatus,
} from "@starkeep/core";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import { createUnifiedIndex } from "../src/unified-index.js";
import type { UnifiedIndex } from "../src/types.js";

describe("UnifiedIndex", () => {
  let databaseAdapter: MockDatabaseAdapter;
  let index: UnifiedIndex;
  const clock = createHLCClock({ nodeId: "test-node", wallClockFn: () => 1000 });

  beforeEach(async () => {
    databaseAdapter = new MockDatabaseAdapter();
    await databaseAdapter.init();
    index = createUnifiedIndex({ databaseAdapter });
  });

  describe("search", () => {
    it("should return data records", async () => {
      const dataRecord = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test", content: { title: "sunset" } },
        clock,
      );
      await databaseAdapter.put(dataRecord);

      const result = await index.search({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].dataRecord.id).toBe(dataRecord.id);
    });

    it("should filter by type", async () => {
      const photoRecord = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test" },
        clock,
      );
      const videoRecord = createDataRecord(
        { type: "@test/video", ownerId: "user1", originAppId: "test" },
        clock,
      );
      await databaseAdapter.put(photoRecord);
      await databaseAdapter.put(videoRecord);

      const result = await index.search({ types: ["@test/photo"] });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].dataRecord.type).toBe("@test/photo");
    });

    it("should filter by syncBoundary", async () => {
      const localRecord = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test" },
        clock,
      );
      const syncedRecord = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test" },
        clock,
      );
      syncedRecord.syncStatus = SyncStatus.PendingPush;

      await databaseAdapter.put(localRecord);
      await databaseAdapter.put(syncedRecord);

      const syncEligibleResult = await index.search({ syncBoundary: "sync-eligible" });
      expect(syncEligibleResult.items).toHaveLength(1);
      expect(syncEligibleResult.items[0].dataRecord.id).toBe(syncedRecord.id);

      const localOnlyResult = await index.search({ syncBoundary: "local-only" });
      expect(localOnlyResult.items).toHaveLength(1);
      expect(localOnlyResult.items[0].dataRecord.id).toBe(localRecord.id);

      const allResult = await index.search({ syncBoundary: "all" });
      expect(allResult.items).toHaveLength(2);
    });

    it("should support pagination with limit and cursor", async () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        createDataRecord({ type: `@test/item-${i}`, ownerId: "user1", originAppId: "test" }, clock),
      );
      for (const record of records) {
        await databaseAdapter.put(record);
      }

      const firstPage = await index.search({ limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextCursor).toBeTruthy();

      const secondPage = await index.search({ limit: 2, cursor: firstPage.nextCursor! });
      expect(secondPage.items).toHaveLength(2);
      expect(secondPage.hasMore).toBe(true);

      const thirdPage = await index.search({ limit: 2, cursor: secondPage.nextCursor! });
      expect(thirdPage.items).toHaveLength(1);
      expect(thirdPage.hasMore).toBe(false);
    });
  });

  describe("getWithMetadata", () => {
    it("should return data record by id", async () => {
      const dataRecord = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test", content: { title: "beach" } },
        clock,
      );
      await databaseAdapter.put(dataRecord);

      const result = await index.getWithMetadata(dataRecord.id);

      expect(result).not.toBeNull();
      expect(result!.dataRecord.id).toBe(dataRecord.id);
    });

    it("should return null for nonexistent record", async () => {
      const nonexistentId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      const result = await index.getWithMetadata(nonexistentId);
      expect(result).toBeNull();
    });
  });

  describe("syncBoundary", () => {
    it("should mark a record as sync eligible", async () => {
      const record = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test" },
        clock,
      );
      await databaseAdapter.put(record);

      expect(record.syncStatus).toBe(SyncStatus.Local);

      await index.syncBoundary.markSyncEligible(record.id);

      const updatedRecord = await databaseAdapter.get(record.id);
      expect(updatedRecord!.syncStatus).toBe(SyncStatus.PendingPush);
    });

    it("should mark a record as local only", async () => {
      const record = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test" },
        clock,
      );
      record.syncStatus = SyncStatus.PendingPush;
      await databaseAdapter.put(record);

      await index.syncBoundary.markLocalOnly(record.id);

      const updatedRecord = await databaseAdapter.get(record.id);
      expect(updatedRecord!.syncStatus).toBe(SyncStatus.Local);
    });

    it("should check if a record is sync eligible", async () => {
      const localRecord = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test" },
        clock,
      );
      await databaseAdapter.put(localRecord);

      const syncedRecord = createDataRecord(
        { type: "@test/photo", ownerId: "user1", originAppId: "test" },
        clock,
      );
      syncedRecord.syncStatus = SyncStatus.PendingPush;
      await databaseAdapter.put(syncedRecord);

      expect(await index.syncBoundary.isSyncEligible(localRecord.id)).toBe(false);
      expect(await index.syncBoundary.isSyncEligible(syncedRecord.id)).toBe(true);

      const nonexistentId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(await index.syncBoundary.isSyncEligible(nonexistentId)).toBe(false);
    });
  });
});
