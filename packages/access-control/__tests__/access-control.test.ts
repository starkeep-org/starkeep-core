import { describe, it, expect, beforeEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type HLCClock,
  type CreateDataRecordInput,
  type StarkeepId,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "@starkeep/storage-adapter";
import { createAccessControlEngine } from "../src/access-control-engine.js";
import { createEnforcedDatabaseAdapter } from "../src/enforced-database-adapter.js";
import { AccessDeniedError } from "../src/errors.js";
import type {
  AccessControlEngine,
  AccessPolicy,
  SharingToken,
  AccessPolicyStore,
  SharingTokenStore,
} from "../src/index.js";

function baseInput(over: Partial<CreateDataRecordInput> = {}): CreateDataRecordInput {
  return {
    type: "@test/note",
    originAppId: "test",
    contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
    objectStorageKey: `shared/@test/note/ab/${Math.random().toString(36).slice(2)}`,
    mimeType: "application/octet-stream",
    sizeBytes: 4,
    ...over,
  };
}

/** In-memory AccessPolicyStore for tests. */
function memoryPolicyStore(): AccessPolicyStore {
  const policies = new Map<StarkeepId, AccessPolicy>();
  return {
    async putPolicy(policy) { policies.set(policy.policyId, policy); },
    async getPolicy(id) { return policies.get(id) ?? null; },
    async listPolicies() { return Array.from(policies.values()); },
    async deletePolicy(id) { policies.delete(id); },
  };
}

/** In-memory SharingTokenStore for tests. */
function memoryTokenStore(): SharingTokenStore {
  const byHash = new Map<string, SharingToken>();
  return {
    async putToken(token) { byHash.set(token.tokenHash, token); },
    async getTokenByHash(hash) { return byHash.get(hash) ?? null; },
    async incrementUsage(hash, _now: HLCTimestamp) {
      const t = byHash.get(hash);
      if (t) t.usageCount++;
    },
    async deleteToken(hash) { byHash.delete(hash); },
  };
}

describe("AccessControl", () => {
  let clock: HLCClock;
  let databaseAdapter: MockDatabaseAdapter;
  let policyStore: AccessPolicyStore;
  let tokenStore: SharingTokenStore;
  let engine: AccessControlEngine;

  beforeEach(async () => {
    clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => Date.now() });
    databaseAdapter = new MockDatabaseAdapter();
    await databaseAdapter.init();
    policyStore = memoryPolicyStore();
    tokenStore = memoryTokenStore();
    engine = createAccessControlEngine({ policyStore, tokenStore, clock });
  });

  describe("createPolicy and listPolicies", () => {
    it("should create a policy and list it", async () => {
      const policy = await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-2",
        resourceType: "item",
        resourceId: "some-item-id",
        permissions: ["read"],
      });

      expect(policy.policyId).toBeTruthy();
      expect(policy.subjectId).toBe("user-2");
      expect(policy.permissions).toEqual(["read"]);

      const policies = await engine.listPolicies({ subjectId: "user-2" });
      expect(policies).toHaveLength(1);
      expect(policies[0].policyId).toBe(policy.policyId);
    });
  });

  describe("revokePolicy", () => {
    it("should remove a policy after revocation", async () => {
      const policy = await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-2",
        resourceType: "item",
        resourceId: "some-item-id",
        permissions: ["read"],
      });

      await engine.revokePolicy(policy.policyId);
      const policies = await engine.listPolicies({ subjectId: "user-2" });
      expect(policies).toHaveLength(0);
    });
  });

  describe("checkAccess", () => {
    it("should allow access with matching item-specific policy", async () => {
      const record = createDataRecord(baseInput(), clock);
      await databaseAdapter.put(record);

      await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-2",
        resourceType: "item",
        resourceId: record.id,
        permissions: ["read"],
      });

      const result = await engine.checkAccess({
        subjectType: "user",
        subjectId: "user-2",
        resourceId: record.id,
        permission: "read",
        recordType: record.type,
      });

      expect(result.allowed).toBe(true);
      expect(result.matchedPolicy).not.toBeNull();
      expect(result.reason).toContain("item-specific");
    });

    it("should allow access with wildcard policy", async () => {
      const record = createDataRecord(baseInput(), clock);
      await databaseAdapter.put(record);

      await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-2",
        resourceType: "wildcard",
        resourceId: "*",
        permissions: ["read"],
      });

      const result = await engine.checkAccess({
        subjectType: "user",
        subjectId: "user-2",
        resourceId: record.id,
        permission: "read",
        recordType: record.type,
      });

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("wildcard");
    });

    it("should deny access when no matching policy exists", async () => {
      const record = createDataRecord(baseInput(), clock);
      await databaseAdapter.put(record);

      const result = await engine.checkAccess({
        subjectType: "user",
        subjectId: "user-2",
        resourceId: record.id,
        permission: "read",
        recordType: record.type,
      });

      expect(result.allowed).toBe(false);
      expect(result.matchedPolicy).toBeNull();
      expect(result.reason).toContain("No matching policy");
    });

    it("should deny access for expired policy", async () => {
      const record = createDataRecord(baseInput(), clock);
      await databaseAdapter.put(record);

      const pastTimestamp = { wallTime: 1000, counter: 0, nodeId: "test-node" };

      await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-2",
        resourceType: "item",
        resourceId: record.id,
        permissions: ["read"],
        expiresAt: pastTimestamp,
      });

      const result = await engine.checkAccess({
        subjectType: "user",
        subjectId: "user-2",
        resourceId: record.id,
        permission: "read",
        recordType: record.type,
      });

      expect(result.allowed).toBe(false);
    });

    it("should grant all access with admin permission", async () => {
      const record = createDataRecord(baseInput(), clock);
      await databaseAdapter.put(record);

      await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-2",
        resourceType: "item",
        resourceId: record.id,
        permissions: ["admin"],
      });

      const readResult = await engine.checkAccess({
        subjectType: "user",
        subjectId: "user-2",
        resourceId: record.id,
        permission: "read",
        recordType: record.type,
      });

      const writeResult = await engine.checkAccess({
        subjectType: "user",
        subjectId: "user-2",
        resourceId: record.id,
        permission: "write",
        recordType: record.type,
      });

      const deleteResult = await engine.checkAccess({
        subjectType: "user",
        subjectId: "user-2",
        resourceId: record.id,
        permission: "delete",
        recordType: record.type,
      });

      expect(readResult.allowed).toBe(true);
      expect(writeResult.allowed).toBe(true);
      expect(deleteResult.allowed).toBe(true);
    });
  });

  describe("sharing tokens", () => {
    it("should create and validate a sharing token", async () => {
      const policy = await engine.createPolicy({
        subjectType: "token",
        subjectId: "token-holder",
        resourceType: "item",
        resourceId: "some-item",
        permissions: ["read"],
      });

      const { token, tokenId } = await engine.createSharingToken(policy.policyId);
      expect(token).toBeTruthy();
      expect(tokenId).toBeTruthy();

      const validatedPolicy = await engine.validateSharingToken(token);
      expect(validatedPolicy).not.toBeNull();
      expect(validatedPolicy!.policyId).toBe(policy.policyId);
    });

    it("should return null for invalid token", async () => {
      const result = await engine.validateSharingToken("invalid-token-that-does-not-exist");
      expect(result).toBeNull();
    });
  });

  describe("persistence via loadPolicies", () => {
    it("should restore policies after re-creating the engine with the same stores", async () => {
      const policy = await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-persist",
        resourceType: "item",
        resourceId: "item-xyz",
        permissions: ["read", "write"],
      });

      const engine2 = createAccessControlEngine({ policyStore, tokenStore, clock });
      await engine2.loadPolicies();

      const policies = await engine2.listPolicies({ subjectId: "user-persist" });
      expect(policies).toHaveLength(1);
      expect(policies[0].policyId).toBe(policy.policyId);
      expect(policies[0].permissions).toEqual(["read", "write"]);
    });

    it("should restore sharing tokens after re-creating the engine", async () => {
      const policy = await engine.createPolicy({
        subjectType: "token",
        subjectId: "*",
        resourceType: "item",
        resourceId: "item-abc",
        permissions: ["read"],
      });
      const { token } = await engine.createSharingToken(policy.policyId);

      const engine2 = createAccessControlEngine({ policyStore, tokenStore, clock });
      await engine2.loadPolicies();

      const validated = await engine2.validateSharingToken(token);
      expect(validated).not.toBeNull();
      expect(validated!.policyId).toBe(policy.policyId);
    });

    it("should not restore revoked policies", async () => {
      const policy = await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-revoke",
        resourceType: "item",
        resourceId: "item-revoke",
        permissions: ["read"],
      });
      await engine.revokePolicy(policy.policyId);

      const engine2 = createAccessControlEngine({ policyStore, tokenStore, clock });
      await engine2.loadPolicies();

      const policies = await engine2.listPolicies({ subjectId: "user-revoke" });
      expect(policies).toHaveLength(0);
    });
  });

  describe("enforced database adapter", () => {
    it("should allow reads with read permission", async () => {
      const record = createDataRecord(baseInput(), clock);
      await databaseAdapter.put(record);

      await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-2",
        resourceType: "item",
        resourceId: record.id,
        permissions: ["read"],
      });

      const enforcedAdapter = createEnforcedDatabaseAdapter({
        databaseAdapter,
        accessControlEngine: engine,
        subjectType: "user",
        subjectId: "user-2",
      });

      const retrieved = await enforcedAdapter.get(record.id);
      expect(retrieved).toEqual(record);
    });

    it("should deny writes without write permission", async () => {
      const record = createDataRecord(baseInput(), clock);

      await engine.createPolicy({
        subjectType: "user",
        subjectId: "user-2",
        resourceType: "item",
        resourceId: record.id,
        permissions: ["read"],
      });

      const enforcedAdapter = createEnforcedDatabaseAdapter({
        databaseAdapter,
        accessControlEngine: engine,
        subjectType: "user",
        subjectId: "user-2",
      });

      await expect(enforcedAdapter.put(record)).rejects.toThrow(AccessDeniedError);
    });

    it("should throw AccessDeniedError on put when no policy covers the record type", async () => {
      const record = createDataRecord(baseInput({ type: "media:photo" }), clock);

      const enforcedAdapter = createEnforcedDatabaseAdapter({
        databaseAdapter,
        accessControlEngine: engine,
        subjectType: "app",
        subjectId: "@starkeep/notes",
      });

      await expect(enforcedAdapter.put(record)).rejects.toThrow(AccessDeniedError);
    });
  });
});
