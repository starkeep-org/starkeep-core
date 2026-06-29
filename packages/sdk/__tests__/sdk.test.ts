import { describe, it, expect } from "vitest";
import { createHLCClock } from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createStarkeepSdk } from "../src/sdk.js";

describe("createStarkeepSdk", () => {
  async function createTestSdk() {
    const localDatabase = new MockDatabaseAdapter();
    const localObjectStorage = new MockObjectStorageAdapter();

    const clock = createHLCClock({
      nodeId: "test-node",
      wallClockFunction: () => 1000,
    });

    const sdk = await createStarkeepSdk({
      databaseAdapter: localDatabase,
      objectStorageAdapter: localObjectStorage,
      nodeId: "test-node",
      clock,
    });
    return { sdk, localDatabase, localObjectStorage };
  }

  describe("data operations", () => {
    it("should put with file and compute content hash", async () => {
      const { sdk, localObjectStorage } = await createTestSdk();

      const fileData = Buffer.from("fake image data");
      const record = await sdk.data.putWithFile(
        { type: "image/jpeg", originAppId: "test" },
        fileData,
        "image/jpeg",
      );

      expect(record.contentHash).toBeTruthy();
      expect(record.objectStorageKey).toBeTruthy();
      expect(record.mimeType).toBe("image/jpeg");
      expect(record.sizeBytes).toBe(fileData.length);

      // Key must live under shared/<category>/... (jpg → image) so that any app
      // with read access to the category can resolve it under its own IAM
      // grants — the key MUST NOT carry the writing app's identifier.
      expect(record.objectStorageKey).toMatch(/^shared\/image\/[0-9a-f]{2}\/[0-9a-f]{64}$/);

      const stored = await localObjectStorage.get(record.objectStorageKey);
      expect(stored).not.toBeNull();
    });

    it("writes the same shared/<category> key regardless of which client wrote the file", async () => {
      const localDatabase = new MockDatabaseAdapter();
      const localObjectStorage = new MockObjectStorageAdapter();
      const clock = createHLCClock({
        nodeId: "shared",
        wallClockFunction: () => 1000,
      });
      const sdkA = await createStarkeepSdk({
        databaseAdapter: localDatabase,
        objectStorageAdapter: localObjectStorage,
        nodeId: "app-a",
        clock,
      });
      const sdkB = await createStarkeepSdk({
        databaseAdapter: localDatabase,
        objectStorageAdapter: localObjectStorage,
        nodeId: "app-b",
        clock,
      });

      const fileData = Buffer.from("shared bytes");
      const written = await sdkA.data.putWithFile(
        { type: "image/jpeg", originAppId: "test" },
        fileData,
        "image/jpeg",
      );

      const readBack = await sdkB.data.get(written.id);
      expect(readBack).not.toBeNull();
      expect(readBack!.objectStorageKey).toBe(written.objectStorageKey);
      expect(written.objectStorageKey).toMatch(/^shared\/image\//);

      const fileFromB = await localObjectStorage.get(readBack!.objectStorageKey);
      expect(fileFromB).not.toBeNull();
      expect(Buffer.from(fileFromB!.data).toString()).toBe("shared bytes");
    });

    it("should delete a record", async () => {
      const { sdk } = await createTestSdk();

      const record = await sdk.data.putWithFile(
        { type: "@test/photo", originAppId: "test" },
        Buffer.from("x"),
        "image/jpeg",
      );

      await sdk.data.delete(record.id);
      const retrieved = await sdk.data.get(record.id);
      expect(retrieved).toBeNull();
    });

    it("writes and reads a per-category metadata row", async () => {
      const { sdk } = await createTestSdk();
      const record = await sdk.data.putWithFile(
        { type: "image/jpeg", originAppId: "test" },
        Buffer.from("x"),
        "image/jpeg",
      );

      // Metadata is keyed by category (jpg → image).
      await sdk.data.putMetadata("image", {
        recordId: record.id,
        width: 800,
        height: 600,
      });

      const meta = await sdk.data.getMetadata("image", record.id);
      expect(meta).not.toBeNull();
      expect(meta!["width"]).toBe(800);
      expect(meta!["height"]).toBe(600);
    });
  });

  describe("index operations", () => {
    it("should search records", async () => {
      const { sdk } = await createTestSdk();

      await sdk.data.putWithFile(
        { type: "@test/photo", originAppId: "test" },
        Buffer.from("a"),
        "image/jpeg",
      );
      await sdk.data.putWithFile(
        { type: "@test/document", originAppId: "test" },
        Buffer.from("b"),
        "text/plain",
      );

      const result = await sdk.index.search({ types: ["@test/photo"] });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("lifecycle", () => {
    it("should close without errors", async () => {
      const { sdk } = await createTestSdk();
      await expect(sdk.close()).resolves.toBeUndefined();
    });
  });
});
