import { describe, it, expect } from "vitest";
import { createHLCClock } from "../src/hlc/clock.js";
import { createDataRecord, createMetadataRecord } from "../src/records/builders.js";
import { SyncStatus } from "../src/records/types.js";
import { createStarkeepId } from "../src/identifiers/types.js";

describe("record builders", () => {
  const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });

  describe("createDataRecord", () => {
    it("should create a data record with required fields", () => {
      const record = createDataRecord(
        { type: "@test/photo", ownerId: "user-1", originAppId: "test" },
        clock,
      );

      expect(record.kind).toBe("data");
      expect(record.type).toBe("@test/photo");
      expect(record.ownerId).toBe("user-1");
      expect(record.id).toHaveLength(26);
      expect(record.version).toBe(1);
      expect(record.syncStatus).toBe(SyncStatus.Local);
      expect(record.deletedAt).toBeNull();
      expect(record.content).toEqual({});
      expect(record.contentHash).toBeNull();
      expect(record.objectStorageKey).toBeNull();
      expect(record.mimeType).toBeNull();
      expect(record.sizeBytes).toBeNull();
    });

    it("should accept optional file-backed fields", () => {
      const record = createDataRecord(
        {
          type: "@test/photo",
          ownerId: "user-1",
          originAppId: "test",
          contentHash: "sha256:abc123",
          objectStorageKey: "notes/abc123",
          mimeType: "image/jpeg",
          sizeBytes: 1024,
          content: { name: "sunset.jpg" },
        },
        clock,
      );

      expect(record.contentHash).toBe("sha256:abc123");
      expect(record.objectStorageKey).toBe("notes/abc123");
      expect(record.mimeType).toBe("image/jpeg");
      expect(record.sizeBytes).toBe(1024);
      expect(record.content).toEqual({ name: "sunset.jpg" });
    });

    it("should have matching createdAt and updatedAt", () => {
      const record = createDataRecord(
        { type: "@test/photo", ownerId: "user-1", originAppId: "test" },
        clock,
      );

      expect(record.createdAt).toEqual(record.updatedAt);
    });

    it("should generate unique IDs for each record", () => {
      const record1 = createDataRecord({ type: "@test/a", ownerId: "u", originAppId: "test" }, clock);
      const record2 = createDataRecord({ type: "@test/b", ownerId: "u", originAppId: "test" }, clock);
      expect(record1.id).not.toBe(record2.id);
    });
  });

  describe("createMetadataRecord", () => {
    it("should create a metadata record with required fields", () => {
      const targetId = createStarkeepId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      const record = createMetadataRecord({
        targetId,
        generatorId: "@starkeep/metadata-core:image-dimensions",
        generatorVersion: 1,
        inputHash: "hash-abc",
        value: { width: 1920, height: 1080 },
      });

      expect(record.targetId).toBe(targetId);
      expect(record.generatorId).toBe("@starkeep/metadata-core:image-dimensions");
      expect(record.generatorVersion).toBe(1);
      expect(record.inputHash).toBe("hash-abc");
      expect(record.value).toEqual({ width: 1920, height: 1080 });
    });
  });
});
