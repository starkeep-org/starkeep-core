import type { StarkeepId, HLCClock } from "@starkeep/protocol-primitives";
import { generateId } from "@starkeep/protocol-primitives";
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
import type { AccessPolicyStore, SharingTokenStore } from "./stores.js";

export interface CreateAccessControlEngineOptions {
  policyStore: AccessPolicyStore;
  /**
   * Sharing-token storage. No production store exists yet — neither local nor
   * cloud persists tokens, and no endpoint redeems them. Pass
   * `disabledSharingTokenStore()` from "./stores.js" so any code that tries
   * to issue or validate a token fails loudly until a real backend is wired.
   */
  tokenStore: SharingTokenStore;
  clock: HLCClock;
  ownerId: string;
}

export function createAccessControlEngine(
  options: CreateAccessControlEngineOptions,
): AccessControlEngine {
  const { policyStore, tokenStore, clock, ownerId } = options;

  // In-memory cache. checkAccess is on the hot path (every read/write of a
  // shared record) so we trade a startup load for cheap subject lookups.
  const policyCache = new Map<string, AccessPolicy>();

  async function loadPolicies(): Promise<void> {
    policyCache.clear();
    const policies = await policyStore.listPolicies();
    for (const policy of policies) {
      policyCache.set(policy.policyId, policy);
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
    await policyStore.putPolicy(policy);
    policyCache.set(policyId, policy);
    return policy;
  }

  async function revokePolicy(policyId: StarkeepId): Promise<void> {
    if (!policyCache.has(policyId)) {
      throw new PolicyNotFoundError(policyId);
    }
    policyCache.delete(policyId);
    await policyStore.deletePolicy(policyId);
  }

  async function listPolicies(
    filterOptions?: { subjectId?: string; resourceId?: string },
  ): Promise<AccessPolicy[]> {
    let policies = Array.from(policyCache.values());
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

    const subjectPolicies = Array.from(policyCache.values()).filter(
      (policy) => policy.subjectType === request.subjectType && policy.subjectId === request.subjectId,
    );

    if (subjectPolicies.length === 0) {
      return {
        allowed: false,
        matchedPolicy: null,
        reason: "No matching policy found",
      };
    }

    // checkAccess requires the caller to supply recordType — we no longer
    // chase a record through the data adapter just to learn its type. The
    // SDK's enforced adapter knows the record type at the call site.
    const recordType = request.recordType ?? "";

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
    const policy = policyCache.get(policyId);
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

    await tokenStore.putToken(sharingToken);

    return { token, tokenId };
  }

  async function validateSharingToken(token: string): Promise<AccessPolicy | null> {
    const tokenHash = await hashToken(token);
    const sharingToken = await tokenStore.getTokenByHash(tokenHash);
    if (!sharingToken) return null;

    if (sharingToken.expiresAt !== null && sharingToken.expiresAt.wallTime < Date.now()) {
      return null;
    }
    if (sharingToken.maxUses !== null && sharingToken.usageCount >= sharingToken.maxUses) {
      return null;
    }

    await tokenStore.incrementUsage(tokenHash, clock.now());

    return policyCache.get(sharingToken.policyId) ?? null;
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
