import type { StarkeepId, HLCClock } from "@starkeep/core";
import { generateId } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type {
  AccessControlEngine,
  AccessPolicy,
  CreatePolicyInput,
  AccessCheckRequest,
  AccessCheckResult,
  SharingToken,
  SharingTokenOptions,
} from "./types.js";
import { resolvePolicy } from "./policy-resolver.js";
import { generateToken, hashToken } from "./sharing-token.js";
import { PolicyNotFoundError } from "./errors.js";

export function createAccessControlEngine(options: {
  databaseAdapter: DatabaseAdapter;
  clock: HLCClock;
  ownerId: string;
}): AccessControlEngine {
  const { databaseAdapter, clock, ownerId } = options;

  const policyStore = new Map<string, AccessPolicy>();
  const tokenStore = new Map<string, SharingToken>();

  async function createPolicy(input: CreatePolicyInput): Promise<AccessPolicy> {
    const policyId = generateId();
    const policy: AccessPolicy = {
      policyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      permissions: [...input.permissions],
      grantedAt: clock.now(),
      expiresAt: input.expiresAt ?? null,
    };
    policyStore.set(policyId, policy);
    return policy;
  }

  async function revokePolicy(policyId: StarkeepId): Promise<void> {
    if (!policyStore.has(policyId)) {
      throw new PolicyNotFoundError(policyId);
    }
    policyStore.delete(policyId);
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
    // Owner always has access
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

    // Look up the record to get its type for type-level matching
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

    const { token, tokenHash } = generateToken();
    const tokenId = generateId();

    const sharingToken: SharingToken = {
      tokenId,
      tokenHash,
      policyId,
      createdAt: clock.now(),
      expiresAt: sharingTokenOptions?.expiresAt ?? null,
      maxUses: sharingTokenOptions?.maxUses ?? null,
      usageCount: 0,
    };

    tokenStore.set(tokenHash, sharingToken);

    return { token, tokenId };
  }

  async function validateSharingToken(token: string): Promise<AccessPolicy | null> {
    const hashedToken = hashToken(token);
    const sharingToken = tokenStore.get(hashedToken);

    if (!sharingToken) {
      return null;
    }

    // Check expiry
    if (sharingToken.expiresAt !== null && sharingToken.expiresAt.wallTime < Date.now()) {
      return null;
    }

    // Check max uses
    if (sharingToken.maxUses !== null && sharingToken.usageCount >= sharingToken.maxUses) {
      return null;
    }

    sharingToken.usageCount++;

    const policy = policyStore.get(sharingToken.policyId);
    return policy ?? null;
  }

  return {
    createPolicy,
    revokePolicy,
    listPolicies,
    checkAccess,
    createSharingToken,
    validateSharingToken,
  };
}
