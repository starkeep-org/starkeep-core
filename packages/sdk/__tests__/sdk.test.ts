import { describe, it, expect, vi } from "vitest";
import { createHLCClock, type StarkeepId } from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";
import { createInProcessSyncTransport } from "@starkeep/sync-engine";
import { createStarkeepSdk } from "../src/sdk.js";

function createTestGenerator(): GeneratingFunctionDefinition {
  return {
    generatorId: "@test:file-properties",
    generatorVersion: 1,
    inputTypes: ["@test/photo"],
    dependsOn: [],
    outputColumns: [
      { name: "type", columnType: "text" },
      { name: "extracted", columnType: "boolean" },
    ],
    generate: async (input, context) => {
      const record = await context.databaseAdapter.get(input.dataRecordId);
      return {
        value: {
          type: record?.type ?? "unknown",
          extracted: true,
        },
      };
    },
  };
}

describe("createStarkeepSdk", () => {
  async function createTestSdk(withSync = false) {
    const localDatabase = new MockDatabaseAdapter();
    const localObjectStorage = new MockObjectStorageAdapter();

    const options: Parameters<typeof createStarkeepSdk>[0] = {
      databaseAdapter: localDatabase,
      objectStorageAdapter: localObjectStorage,
      ownerId: "test-owner",
      nodeId: "test-node",
      clock: createHLCClock({
        nodeId: "test-node",
        wallClockFunction: () => 1000,
      }),
      generators: [createTestGenerator()],
    };

    if (withSync) {
      const remoteDatabase = new MockDatabaseAdapter();
      const remoteObjectStorage = new MockObjectStorageAdapter();
      await remoteDatabase.init();
      await remoteObjectStorage.init();
      options.syncTransport = createInProcessSyncTransport({
        databaseAdapter: remoteDatabase,
        clock: options.clock!,
      });
      options.remoteObjectStorageAdapter = remoteObjectStorage;
    }

    const sdk = await createStarkeepSdk(options);
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

  describe("metadata operations", () => {
    it("should generate metadata for a record", async () => {
      const { sdk } = await createTestSdk();

      const record = await sdk.data.put({
        type: "@test/photo",
        ownerId: "test-owner",
      });

      const result = await sdk.metadata.generate(
        "@test:file-properties",
        record.id,
      );

      expect(result.metadataRecord.value).toEqual({
        type: "@test/photo",
        extracted: true,
      });
    });

    it("should get metadata for a record", async () => {
      const { sdk } = await createTestSdk();

      const record = await sdk.data.put({
        type: "@test/photo",
        ownerId: "test-owner",
      });

      await sdk.metadata.generate("@test:file-properties", record.id);
      const metadata = await sdk.metadata.getForRecord(record.id);

      expect(metadata).toHaveLength(1);
      expect(metadata[0].generatorId).toBe("@test:file-properties");
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

      const record = await sdk.data.put({
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
