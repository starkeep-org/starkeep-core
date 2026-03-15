import type { StarkeepId } from "@starkeep/core";
import type { AccessPolicy, AccessCheckResult, Permission } from "./types.js";

export function resolvePolicy(
  policies: AccessPolicy[],
  resourceId: StarkeepId,
  recordType: string,
  permission: Permission,
  currentTime: number,
): AccessCheckResult {
  const activePolicies = policies.filter(
    (policy) => policy.expiresAt === null || policy.expiresAt.wallTime >= currentTime,
  );

  // Priority 1: item-specific match
  const itemPolicy = activePolicies.find(
    (policy) =>
      policy.resourceType === "item" &&
      policy.resourceId === resourceId &&
      (policy.permissions.includes(permission) || policy.permissions.includes("admin")),
  );

  if (itemPolicy) {
    return {
      allowed: true,
      matchedPolicy: itemPolicy,
      reason: `Allowed by item-specific policy ${itemPolicy.policyId}`,
    };
  }

  // Priority 2: type-level match
  const typePolicy = activePolicies.find(
    (policy) =>
      policy.resourceType === "type" &&
      policy.resourceId === recordType &&
      (policy.permissions.includes(permission) || policy.permissions.includes("admin")),
  );

  if (typePolicy) {
    return {
      allowed: true,
      matchedPolicy: typePolicy,
      reason: `Allowed by type-level policy ${typePolicy.policyId}`,
    };
  }

  // Priority 3: wildcard match
  const wildcardPolicy = activePolicies.find(
    (policy) =>
      policy.resourceType === "wildcard" &&
      (policy.permissions.includes(permission) || policy.permissions.includes("admin")),
  );

  if (wildcardPolicy) {
    return {
      allowed: true,
      matchedPolicy: wildcardPolicy,
      reason: `Allowed by wildcard policy ${wildcardPolicy.policyId}`,
    };
  }

  return {
    allowed: false,
    matchedPolicy: null,
    reason: "No matching policy found",
  };
}
