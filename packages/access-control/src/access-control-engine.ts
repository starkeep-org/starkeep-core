import type { StarkeepId, HLCClock } from "@starkeep/core";
import { generateId, SyncStatus } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type {
  AccessControlEngine,
  AccessPolicy,
  CreatePolicyInput,
  AccessCheckRequest,
  AccessCheckResult,
  SharingToken,
  SharingTokenOptions,
  SubjectType,
  ResourceType,
  Permission,
} from "./types.js";
import { resolvePolicy } from "./policy-resolver.js";
import { generateToken, hashToken } from "./sharing-token.js";
import { PolicyNotFoundError } from "./errors.js";

const POLICY_RECORD_TYPE = "@starkeep/access-policy";
const TOKEN_RECORD_TYPE = "@starkeep/sharing-token";

export function createAccessControlEngine(options: {
  databaseAdapter: DatabaseAdapter;
  clock: HLCClock;
  ownerId: string;
}): AccessControlEngine {
  const { databaseAdapter, clock, ownerId } = options;

  const policyStore = new Map<string, AccessPolicy>();
  const tokenStore = new Map<string, SharingToken>();

  async function loadPolicies(): Promise<void> {
    policyStore.clear();
    tokenStore.clear();

    const policiesResult = await databaseAdapter.query({ type: POLICY_RECORD_TYPE, kind: "data" });
    for (const record of policiesResult.records) {
      if (record.kind !== "data") continue;
      const p = record.payload as Record<string, unknown>;
      const policy: AccessPolicy = {
        policyId: record.id,
        subjectType: p.subjectType as SubjectType,
        subjectId: p.subjectId as string,
        resourceType: p.resourceType as ResourceType,
        resourceId: p.resourceId as string,
        permissions: p.permissions as Permission[],
        grantedAt: record.createdAt,
        expiresAt: (p.expiresAt as AccessPolicy["expiresAt"]) ?? null,
      };
      policyStore.set(policy.policyId, policy);
    }

    const tokensResult = await databaseAdapter.query({ type: TOKEN_RECORD_TYPE, kind: "data" });
    for (const record of tokensResult.records) {
      if (record.kind !== "data") continue;
      const t = record.payload as Record<string, unknown>;
      const token: SharingToken = {
        tokenId: record.id,
        tokenHash: t.tokenHash as string,
        policyId: t.policyId as StarkeepId,
        createdAt: record.createdAt,
        expiresAt: (t.expiresAt as SharingToken["expiresAt"]) ?? null,
        maxUses: (t.maxUses as number | null) ?? null,
        usageCount: (t.usageCount as number) ?? 0,
      };
      tokenStore.set(token.tokenHash, token);
    }
  }

  async function createPolicy(input: CreatePolicyInput): Promise<AccessPolicy> {
    const policyId = generateId();
    const now = clock.now();
    const policy: AccessPolicy = {
      policyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      permissions: [...input.permissions],
      grantedAt: now,
      expiresAt: input.expiresAt ?? null,
    };
    policyStore.set(policyId, policy);

    await databaseAdapter.put({
      id: policyId,
      kind: "data",
      type: POLICY_RECORD_TYPE,
      createdAt: now,
      updatedAt: now,
      ownerId,
      syncStatus: SyncStatus.Local,
      deletedAt: null,
      version: 1,
      contentHash: null,
      objectStorageKey: null,
      mimeType: null,
      sizeBytes: null,
      payload: {
        subjectType: policy.subjectType,
        subjectId: policy.subjectId,
        resourceType: policy.resourceType,
        resourceId: policy.resourceId,
        permissions: policy.permissions,
        expiresAt: policy.expiresAt,
      },
    });

    return policy;
  }

  async function revokePolicy(policyId: StarkeepId): Promise<void> {
    if (!policyStore.has(policyId)) {
      throw new PolicyNotFoundError(policyId);
    }
    policyStore.delete(policyId);
    await databaseAdapter.delete(policyId);
  }

  async function listPolicies(
    filterOptions?: { subjectId?: string; resourceId?: string },
  ): Promise<AccessPolicy[]> {
    let policies = Array.from(policyStore.values());
    if (filterOptions?.subjectId) {
      policies = policies.filter((policy) => policy.subjectId === filterOptions.subjectId);
    }
    if (filterOptions?.resourceId) {
      policies = policies.filter((policy) => policy.resourceId === filterOptions.resourceId);
    }
    return policies;
  }

  async function checkAccess(request: AccessCheckRequest): Promise<AccessCheckResult> {
    if (request.subjectId === ownerId) {
      return {
        allowed: true,
        matchedPolicy: null,
        reason: "Owner has full access",
      };
    }

    const subjectPolicies = Array.from(policyStore.values()).filter(
      (policy) => policy.subjectType === request.subjectType && policy.subjectId === request.subjectId,
    );

    if (subjectPolicies.length === 0) {
      return {
        allowed: false,
        matchedPolicy: null,
        reason: "No matching policy found",
      };
    }

    const record = await databaseAdapter.get(request.resourceId);
    const recordType = record?.type ?? "";

    return resolvePolicy(
      subjectPolicies,
      request.resourceId,
      recordType,
      request.permission,
      Date.now(),
    );
  }

  async function createSharingToken(
    policyId: StarkeepId,
    sharingTokenOptions?: SharingTokenOptions,
  ): Promise<{ token: string; tokenId: string }> {
    const policy = policyStore.get(policyId);
    if (!policy) {
      throw new PolicyNotFoundError(policyId);
    }

    const { token, tokenHash } = await generateToken();
    const tokenId = generateId();
    const now = clock.now();

    const sharingToken: SharingToken = {
      tokenId,
      tokenHash,
      policyId,
      createdAt: now,
      expiresAt: sharingTokenOptions?.expiresAt ?? null,
      maxUses: sharingTokenOptions?.maxUses ?? null,
      usageCount: 0,
    };

    tokenStore.set(tokenHash, sharingToken);

    await databaseAdapter.put({
      id: tokenId as StarkeepId,
      kind: "data",
      type: TOKEN_RECORD_TYPE,
      createdAt: now,
      updatedAt: now,
      ownerId,
      syncStatus: SyncStatus.Local,
      deletedAt: null,
      version: 1,
      contentHash: null,
      objectStorageKey: null,
      mimeType: null,
      sizeBytes: null,
      payload: {
        tokenHash,
        policyId,
        expiresAt: sharingToken.expiresAt,
        maxUses: sharingToken.maxUses,
        usageCount: 0,
      },
    });

    return { token, tokenId };
  }

  async function validateSharingToken(token: string): Promise<AccessPolicy | null> {
    const hashedToken = await hashToken(token);
    const sharingToken = tokenStore.get(hashedToken);

    if (!sharingToken) {
      return null;
    }

    if (sharingToken.expiresAt !== null && sharingToken.expiresAt.wallTime < Date.now()) {
      return null;
    }

    if (sharingToken.maxUses !== null && sharingToken.usageCount >= sharingToken.maxUses) {
      return null;
    }

    sharingToken.usageCount++;

    // Persist the updated usageCount
    const now = clock.now();
    await databaseAdapter.put({
      id: sharingToken.tokenId as StarkeepId,
      kind: "data",
      type: TOKEN_RECORD_TYPE,
      createdAt: sharingToken.createdAt,
      updatedAt: now,
      ownerId,
      syncStatus: SyncStatus.Local,
      deletedAt: null,
      version: 1,
      contentHash: null,
      objectStorageKey: null,
      mimeType: null,
      sizeBytes: null,
      payload: {
        tokenHash: sharingToken.tokenHash,
        policyId: sharingToken.policyId,
        expiresAt: sharingToken.expiresAt,
        maxUses: sharingToken.maxUses,
        usageCount: sharingToken.usageCount,
      },
    });

    const policy = policyStore.get(sharingToken.policyId);
    return policy ?? null;
  }

  return {
    loadPolicies,
    createPolicy,
    revokePolicy,
    listPolicies,
    checkAccess,
    createSharingToken,
    validateSharingToken,
  };
}
