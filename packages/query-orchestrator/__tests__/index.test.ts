import { describe, it, expect, beforeEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  createStarkeepId,
  type CreateDataRecordInput,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import { createUnifiedIndex } from "../src/unified-index.js";
import type { UnifiedIndex } from "../src/types.js";

function baseInput(over: Partial<CreateDataRecordInput> = {}): CreateDataRecordInput {
  return {
    type: "@test/photo",
    ownerId: "user1",
    originAppId: "test",
    contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
    objectStorageKey: `shared/@test/photo/ab/${Math.random().toString(36).slice(2)}`,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    ...over,
  };
}

describe("UnifiedIndex", () => {
  let databaseAdapter: MockDatabaseAdapter;
  let index: UnifiedIndex;
  const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });

  beforeEach(async () => {
    databaseAdapter = new MockDatabaseAdapter();
    await databaseAdapter.init();
    index = createUnifiedIndex({ databaseAdapter });
  });

  describe("search", () => {
    it("should return data records", async () => {
      const dataRecord = createDataRecord(baseInput({ originalFilename: "sunset" }), clock);
      await databaseAdapter.put(dataRecord);

      const result = await index.search({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].dataRecord.id).toBe(dataRecord.id);
    });

    it("should filter by type", async () => {
      const photoRecord = createDataRecord(baseInput({ type: "@test/photo" }), clock);
      const videoRecord = createDataRecord(baseInput({ type: "@test/video" }), clock);
      await databaseAdapter.put(photoRecord);
      await databaseAdapter.put(videoRecord);

      const result = await index.search({ types: ["@test/photo"] });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].dataRecord.type).toBe("@test/photo");
    });

    it("should support pagination with limit and cursor", async () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        createDataRecord(baseInput({ type: `@test/item-${i}` }), clock),
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
      const dataRecord = createDataRecord(baseInput({ originalFilename: "beach" }), clock);
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
});
