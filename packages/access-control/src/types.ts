import type { StarkeepId, HLCTimestamp } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";

export type Permission = "read" | "write" | "delete" | "admin";
export type SubjectType = "user" | "app" | "api" | "token";
export type ResourceType = "item" | "type" | "collection" | "wildcard";

export interface AccessPolicy {
  readonly policyId: StarkeepId;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly permissions: Permission[];
  readonly grantedAt: HLCTimestamp;
  readonly expiresAt: HLCTimestamp | null;
}

export interface CreatePolicyInput {
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly permissions: Permission[];
  readonly expiresAt?: HLCTimestamp | null;
}

export interface AccessCheckRequest {
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly resourceId: StarkeepId;
  readonly permission: Permission;
  /** When provided, the engine uses this type directly and skips the DB lookup. */
  readonly recordType?: string;
}

export interface AccessCheckResult {
  readonly allowed: boolean;
  readonly matchedPolicy: AccessPolicy | null;
  readonly reason: string;
}

export interface SharingToken {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly policyId: StarkeepId;
  readonly createdAt: HLCTimestamp;
  readonly expiresAt: HLCTimestamp | null;
  readonly maxUses: number | null;
  usageCount: number;
}

export interface SharingTokenOptions {
  readonly expiresAt?: HLCTimestamp | null;
  readonly maxUses?: number | null;
}

export interface AccessControlEngine {
  loadPolicies(): Promise<void>;
  createPolicy(input: CreatePolicyInput): Promise<AccessPolicy>;
  revokePolicy(policyId: StarkeepId): Promise<void>;
  listPolicies(options?: { subjectId?: string; resourceId?: string }): Promise<AccessPolicy[]>;
  checkAccess(request: AccessCheckRequest): Promise<AccessCheckResult>;
  createSharingToken(policyId: StarkeepId, options?: SharingTokenOptions): Promise<{ token: string; tokenId: string }>;
  validateSharingToken(token: string): Promise<AccessPolicy | null>;
}

// Same interface as DatabaseAdapter but with access checks
export type EnforcedDatabaseAdapter = DatabaseAdapter;
