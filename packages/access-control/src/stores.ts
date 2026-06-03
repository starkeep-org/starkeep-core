import type { StarkeepId, HLCTimestamp } from "@starkeep/protocol-primitives";
import type {
  AccessPolicy,
  Permission,
  ResourceType,
  SharingToken,
  SubjectType,
} from "./types.js";

/**
 * Storage for access-control policies. Instance-local: each side
 * (local-data-server, cloud-data-server) maintains its own table. Policies
 * are never replicated between the two.
 */
export interface AccessPolicyStore {
  putPolicy(policy: AccessPolicy): Promise<void>;
  getPolicy(policyId: StarkeepId): Promise<AccessPolicy | null>;
  listPolicies(): Promise<AccessPolicy[]>;
  deletePolicy(policyId: StarkeepId): Promise<void>;
}

/**
 * Storage for sharing tokens (bearer credentials that invoke a pre-issued
 * AccessPolicy when presented). Only the cloud-data-server stores these —
 * shared content is served from cloud, so token validation must live where
 * the resource actually exists. The local-data-server uses
 * `disabledSharingTokenStore` which errors on every method.
 */
export interface SharingTokenStore {
  putToken(token: SharingToken): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<SharingToken | null>;
  incrementUsage(tokenHash: string, now: HLCTimestamp): Promise<void>;
  deleteToken(tokenHash: string): Promise<void>;
}

/**
 * Helper for engine constructors that need a SharingTokenStore on the local
 * side (where issuing tokens is not supported). Every method throws.
 */
export function disabledSharingTokenStore(): SharingTokenStore {
  const error = () => {
    throw new Error(
      "Sharing tokens are issued and validated cloud-side only. " +
        "Use the cloud-data-server's owner-auth surface to mint and validate tokens.",
    );
  };
  return {
    putToken: () => error(),
    getTokenByHash: () => error(),
    incrementUsage: () => error(),
    deleteToken: () => error(),
  };
}

// Re-export the policy / token / permission types so storage adapters that
// implement these interfaces can import everything from one place.
export type { AccessPolicy, SharingToken, Permission, SubjectType, ResourceType };
