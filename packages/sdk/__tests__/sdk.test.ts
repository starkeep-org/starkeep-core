import { describe, it, expect } from "vitest";
import {
  createHLCClock,
  type StarkeepId,
  type HLCTimestamp,
  type TypeRegistration,
  type TypeRegistrationStore,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import {
  type AccessPolicy,
  type AccessPolicyStore,
  type SharingToken,
  type SharingTokenStore,
} from "@starkeep/access-control";
import { createStarkeepSdk } from "../src/sdk.js";

function memoryPolicyStore(): AccessPolicyStore {
  const policies = new Map<StarkeepId, AccessPolicy>();
  return {
    async putPolicy(p) { policies.set(p.policyId, p); },
    async getPolicy(id) { return policies.get(id) ?? null; },
    async listPolicies() { return Array.from(policies.values()); },
    async deletePolicy(id) { policies.delete(id); },
  };
}

function memoryTokenStore(): SharingTokenStore {
  const byHash = new Map<string, SharingToken>();
  return {
    async putToken(t) { byHash.set(t.tokenHash, t); },
    async getTokenByHash(h) { return byHash.get(h) ?? null; },
    async incrementUsage(h, _now: HLCTimestamp) {
      const t = byHash.get(h);
      if (t) t.usageCount++;
    },
    async deleteToken(h) { byHash.delete(h); },
  };
}

function memoryTypeRegistrationStore(): TypeRegistrationStore {
  const regs = new Map<string, TypeRegistration>();
  return {
    async put(r) { regs.set(r.typeId, r); },
    async get(id) { return regs.get(id) ?? null; },
    async list() { return Array.from(regs.values()); },
    async delete(id) { regs.delete(id); },
  };
}

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
      accessPolicyStore: memoryPolicyStore(),
      sharingTokenStore: memoryTokenStore(),
      typeRegistrationStore: memoryTypeRegistrationStore(),
      ownerId: "test-owner",
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
        { type: "jpg", ownerId: "test-owner", originAppId: "test" },
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
        accessPolicyStore: memoryPolicyStore(),
        sharingTokenStore: memoryTokenStore(),
        typeRegistrationStore: memoryTypeRegistrationStore(),
        ownerId: "test-owner",
        nodeId: "app-a",
        clock,
      });
      const sdkB = await createStarkeepSdk({
        databaseAdapter: localDatabase,
        objectStorageAdapter: localObjectStorage,
        accessPolicyStore: memoryPolicyStore(),
        sharingTokenStore: memoryTokenStore(),
        typeRegistrationStore: memoryTypeRegistrationStore(),
        ownerId: "test-owner",
        nodeId: "app-b",
        clock,
      });

      const fileData = Buffer.from("shared bytes");
      const written = await sdkA.data.putWithFile(
        { type: "jpg", ownerId: "test-owner", originAppId: "test" },
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
        { type: "@test/photo", ownerId: "test-owner", originAppId: "test" },
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
        { type: "jpg", ownerId: "test-owner", originAppId: "test" },
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
        { type: "@test/photo", ownerId: "test-owner", originAppId: "test" },
        Buffer.from("a"),
        "image/jpeg",
      );
      await sdk.data.putWithFile(
        { type: "@test/document", ownerId: "test-owner", originAppId: "test" },
        Buffer.from("b"),
        "text/plain",
      );

      const result = await sdk.index.search({ types: ["@test/photo"] });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("aggregation operations", () => {
    it("should compute aggregations", async () => {
      const { sdk } = await createTestSdk();

      await sdk.data.putWithFile(
        { type: "@test/photo", ownerId: "test-owner", originAppId: "test" },
        Buffer.alloc(1000),
        "image/jpeg",
      );
      await sdk.data.putWithFile(
        { type: "@test/photo", ownerId: "test-owner", originAppId: "test" },
        Buffer.alloc(2000),
        "image/png",
      );

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

  describe("type registrations", () => {
    it("should register and list types", async () => {
      const { sdk } = await createTestSdk();
      const reg = await sdk.typeRegistrations.register({
        typeId: "image",
        schema: { type: "object" },
        schemaVersion: "1.0.0",
        description: "Image file",
        registeredByAppId: "photos",
      });
      expect(reg.typeId).toBe("image");
      expect(reg.registeredAt).toBeTruthy();

      const list = await sdk.typeRegistrations.list();
      expect(list).toHaveLength(1);
      expect(list[0].typeId).toBe("image");
    });
  });

  describe("lifecycle", () => {
    it("should close without errors", async () => {
      const { sdk } = await createTestSdk();
      await expect(sdk.close()).resolves.toBeUndefined();
    });
  });
});
