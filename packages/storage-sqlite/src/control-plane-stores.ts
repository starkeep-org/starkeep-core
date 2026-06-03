import type { DatabaseSync } from "node:sqlite";
import {
  createStarkeepId,
  deserializeHLC,
  serializeHLC,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type {
  AccessPolicy,
  AccessPolicyStore,
  Permission,
  ResourceType,
  SubjectType,
} from "@starkeep/access-control";

/**
 * SQLite-backed AccessPolicyStore. Schema is bootstrapped in
 * storage-sqlite/src/schema/bootstrap.ts. Permissions are stored as a
 * comma-separated string — never user-supplied, always picked from the
 * Permission enum so no escaping is required.
 */
export function createSqliteAccessPolicyStore(db: DatabaseSync): AccessPolicyStore {
  return {
    async putPolicy(policy: AccessPolicy): Promise<void> {
      db.prepare(
        `INSERT INTO access_policies (
           policy_id, subject_type, subject_id, resource_type, resource_id,
           permissions, granted_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(policy_id) DO UPDATE SET
           subject_type = excluded.subject_type,
           subject_id = excluded.subject_id,
           resource_type = excluded.resource_type,
           resource_id = excluded.resource_id,
           permissions = excluded.permissions,
           granted_at = excluded.granted_at,
           expires_at = excluded.expires_at`,
      ).run(
        policy.policyId,
        policy.subjectType,
        policy.subjectId,
        policy.resourceType,
        policy.resourceId,
        policy.permissions.join(","),
        serializeHLC(policy.grantedAt),
        policy.expiresAt ? serializeHLC(policy.expiresAt) : null,
      );
    },

    async getPolicy(policyId: StarkeepId): Promise<AccessPolicy | null> {
      const row = db
        .prepare("SELECT * FROM access_policies WHERE policy_id = ?")
        .get(policyId) as PolicyRow | undefined;
      return row ? rowToPolicy(row) : null;
    },

    async listPolicies(): Promise<AccessPolicy[]> {
      const rows = db.prepare("SELECT * FROM access_policies").all() as unknown as PolicyRow[];
      return rows.map(rowToPolicy);
    },

    async deletePolicy(policyId: StarkeepId): Promise<void> {
      db.prepare("DELETE FROM access_policies WHERE policy_id = ?").run(policyId);
    },
  };
}

interface PolicyRow {
  policy_id: string;
  subject_type: string;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  permissions: string;
  granted_at: string;
  expires_at: string | null;
}

function rowToPolicy(row: PolicyRow): AccessPolicy {
  return {
    policyId: createStarkeepId(row.policy_id),
    subjectType: row.subject_type as SubjectType,
    subjectId: row.subject_id,
    resourceType: row.resource_type as ResourceType,
    resourceId: row.resource_id,
    permissions: row.permissions.split(",").filter(Boolean) as Permission[],
    grantedAt: deserializeHLC(row.granted_at),
    expiresAt: row.expires_at ? deserializeHLC(row.expires_at) : null,
  };
}

