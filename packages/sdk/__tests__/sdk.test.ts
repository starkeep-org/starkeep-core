import { describe, it, expect } from "vitest";
import { createHLCClock } from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import { createStarkeepSdk } from "../src/sdk.js";

describe("createStarkeepSdk", () => {
  async function createTestSdk(withSync = false) {
    const localDatabase = new MockDatabaseAdapter();
    const localObjectStorage = new MockObjectStorageAdapter();

    const clock = createHLCClock({
      nodeId: "test-node",
      wallClockFunction: () => 1000,
    });

    let syncTransport: Parameters<typeof createStarkeepSdk>[0]["syncTransport"];
    let remoteObjectStorageAdapter: Parameters<typeof createStarkeepSdk>[0]["remoteObjectStorageAdapter"];

    if (withSync) {
      const remoteDatabase = new MockDatabaseAdapter();
      const remoteObjectStorage = new MockObjectStorageAdapter();
      await remoteDatabase.init();
      await remoteObjectStorage.init();
      syncTransport = createInProcessSyncTransport({
        databaseAdapter: remoteDatabase,
        clock,
      });
      remoteObjectStorageAdapter = remoteObjectStorage;
    }

    const sdk = await createStarkeepSdk({
      databaseAdapter: localDatabase,
      objectStorageAdapter: localObjectStorage,
      ownerId: "test-owner",
      nodeId: "test-node",
      clock,
      syncTransport,
      remoteObjectStorageAdapter,
    });
    return { sdk, localDatabase, localObjectStorage };
  }

  describe("data operations", () => {
    it("should put and get a data record", async () => {
      const { sdk } = await createTestSdk();

      const record = await sdk.data.put({
        type: "@test/photo",
        ownerId: "test-owner",
        content: { title: "My Photo" },
      });

      expect(record.kind).toBe("data");
      expect(record.type).toBe("@test/photo");

      const retrieved = await sdk.data.get(record.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toEqual({ title: "My Photo" });
    });

    it("should put with file and compute content hash", async () => {
      const { sdk, localObjectStorage } = await createTestSdk();

      const fileData = Buffer.from("fake image data");
      const record = await sdk.data.putWithFile(
        { type: "@test/photo", ownerId: "test-owner" },
        fileData,
        "image/jpeg",
      );

      expect(record.contentHash).toBeTruthy();
      expect(record.objectStorageKey).toBeTruthy();
      expect(record.mimeType).toBe("image/jpeg");
      expect(record.sizeBytes).toBe(fileData.length);

      const stored = await localObjectStorage.get(record.objectStorageKey!);
      expect(stored).not.toBeNull();
    });

    it("should delete a record", async () => {
      const { sdk } = await createTestSdk();

      const record = await sdk.data.put({
        type: "@test/photo",
        ownerId: "test-owner",
      });

      await sdk.data.delete(record.id);
      const retrieved = await sdk.data.get(record.id);
      expect(retrieved).toBeNull();
    });
  });

  describe("index operations", () => {
    it("should search records", async () => {
      const { sdk } = await createTestSdk();

      await sdk.data.put({ type: "@test/photo", ownerId: "test-owner" });
      await sdk.data.put({ type: "@test/document", ownerId: "test-owner" });

      const result = await sdk.index.search({
        types: ["@test/photo"],
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("aggregation operations", () => {
    it("should compute aggregations", async () => {
      const { sdk } = await createTestSdk();

      await sdk.data.put({
        type: "@test/photo",
        ownerId: "test-owner",
        sizeBytes: 1000,
        mimeType: "image/jpeg",
      });
      await sdk.data.put({
        type: "@test/photo",
        ownerId: "test-owner",
        sizeBytes: 2000,
        mimeType: "image/png",
      });

      const result = await sdk.aggregations.compute();
      expect(result.totalCount).toBe(2);
      expect(result.totalSizeBytes).toBe(3000);
    });
  });

  describe("access control operations", () => {
    it("should create and list policies", async () => {
      const { sdk } = await createTestSdk();

      const policy = await sdk.accessControl.createPolicy({
        subjectType: "user",
        subjectId: "user-1",
        resourceType: "wildcard",
        resourceId: "*",
        permissions: ["read"],
      });

      expect(policy.policyId).toBeDefined();

      const policies = await sdk.accessControl.listPolicies({
        subjectId: "user-1",
      });
      expect(policies).toHaveLength(1);
    });
  });

  describe("sync operations", () => {
    it("should be null when no remote adapters configured", async () => {
      const { sdk } = await createTestSdk(false);
      expect(sdk.sync).toBeNull();
    });

    it("should be available when remote adapters configured", async () => {
      const { sdk } = await createTestSdk(true);
      expect(sdk.sync).not.toBeNull();
    });

    it("should sync data between local and remote", async () => {
      const { sdk } = await createTestSdk(true);

      await sdk.data.put({
        type: "@test/photo",
        ownerId: "test-owner",
      });

      const result = await sdk.sync!.fullSync();
      expect(result.pushed).toBeGreaterThanOrEqual(1);
    });
  });

  describe("lifecycle", () => {
    it("should close without errors", async () => {
      const { sdk } = await createTestSdk();
      await expect(sdk.close()).resolves.toBeUndefined();
    });
  });
});
