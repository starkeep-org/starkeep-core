import {
  createStarkeepId,
  deserializeHLC,
  serializeHLC,
  type HLCTimestamp,
  type StarkeepId,
  type TypeRegistration,
  type TypeRegistrationStore,
} from "@starkeep/protocol-primitives";
import type {
  AccessPolicy,
  AccessPolicyStore,
  Permission,
  ResourceType,
  SharingToken,
  SharingTokenStore,
  SubjectType,
} from "@starkeep/access-control";
import type { DatabaseClient } from "./types.js";

/**
 * Aurora DSQL-backed AccessPolicyStore. Tables `shared.access_policies` and
 * its grants are created by admin-installer/src/dsql-schema-init.ts.
 */
export function createDsqlAccessPolicyStore(client: DatabaseClient): AccessPolicyStore {
  return {
    async putPolicy(policy: AccessPolicy): Promise<void> {
      await client.query(
        `INSERT INTO shared.access_policies (
           policy_id, subject_type, subject_id, resource_type, resource_id,
           permissions, granted_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (policy_id) DO UPDATE SET
           subject_type = EXCLUDED.subject_type,
           subject_id = EXCLUDED.subject_id,
           resource_type = EXCLUDED.resource_type,
           resource_id = EXCLUDED.resource_id,
           permissions = EXCLUDED.permissions,
           granted_at = EXCLUDED.granted_at,
           expires_at = EXCLUDED.expires_at`,
        [
          policy.policyId,
          policy.subjectType,
          policy.subjectId,
          policy.resourceType,
          policy.resourceId,
          policy.permissions.join(","),
          serializeHLC(policy.grantedAt),
          policy.expiresAt ? serializeHLC(policy.expiresAt) : null,
        ],
      );
    },

    async getPolicy(policyId: StarkeepId): Promise<AccessPolicy | null> {
      const result = await client.query(
        "SELECT * FROM shared.access_policies WHERE policy_id = $1",
        [policyId],
      );
      if (result.rows.length === 0) return null;
      return rowToPolicy(result.rows[0] as unknown as PolicyRow);
    },

    async listPolicies(): Promise<AccessPolicy[]> {
      const result = await client.query("SELECT * FROM shared.access_policies");
      return (result.rows as unknown as PolicyRow[]).map(rowToPolicy);
    },

    async deletePolicy(policyId: StarkeepId): Promise<void> {
      await client.query(
        "DELETE FROM shared.access_policies WHERE policy_id = $1",
        [policyId],
      );
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

/**
 * Aurora DSQL-backed SharingTokenStore. Cloud-side only — see
 * @starkeep/access-control's plan notes.
 */
export function createDsqlSharingTokenStore(client: DatabaseClient): SharingTokenStore {
  return {
    async putToken(token: SharingToken): Promise<void> {
      await client.query(
        `INSERT INTO shared.sharing_tokens (
           token_id, token_hash, policy_id, created_at, expires_at,
           max_uses, usage_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (token_id) DO UPDATE SET
           token_hash = EXCLUDED.token_hash,
           policy_id = EXCLUDED.policy_id,
           expires_at = EXCLUDED.expires_at,
           max_uses = EXCLUDED.max_uses,
           usage_count = EXCLUDED.usage_count`,
        [
          token.tokenId,
          token.tokenHash,
          token.policyId,
          serializeHLC(token.createdAt),
          token.expiresAt ? serializeHLC(token.expiresAt) : null,
          token.maxUses,
          token.usageCount,
        ],
      );
    },

    async getTokenByHash(tokenHash: string): Promise<SharingToken | null> {
      const result = await client.query(
        "SELECT * FROM shared.sharing_tokens WHERE token_hash = $1",
        [tokenHash],
      );
      if (result.rows.length === 0) return null;
      return rowToToken(result.rows[0] as unknown as TokenRow);
    },

    async incrementUsage(tokenHash: string, _now: HLCTimestamp): Promise<void> {
      await client.query(
        "UPDATE shared.sharing_tokens SET usage_count = usage_count + 1 WHERE token_hash = $1",
        [tokenHash],
      );
    },

    async deleteToken(tokenHash: string): Promise<void> {
      await client.query(
        "DELETE FROM shared.sharing_tokens WHERE token_hash = $1",
        [tokenHash],
      );
    },
  };
}

interface TokenRow {
  token_id: string;
  token_hash: string;
  policy_id: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  usage_count: number;
}

function rowToToken(row: TokenRow): SharingToken {
  return {
    tokenId: row.token_id,
    tokenHash: row.token_hash,
    policyId: createStarkeepId(row.policy_id),
    createdAt: deserializeHLC(row.created_at),
    expiresAt: row.expires_at ? deserializeHLC(row.expires_at) : null,
    maxUses: row.max_uses,
    usageCount: row.usage_count,
  };
}

/**
 * Aurora DSQL-backed TypeRegistrationStore.
 */
export function createDsqlTypeRegistrationStore(
  client: DatabaseClient,
): TypeRegistrationStore {
  return {
    async put(registration: TypeRegistration): Promise<void> {
      await client.query(
        `INSERT INTO shared.type_registrations (
           type_id, schema_json, schema_version, description,
           registered_by_app_id, registered_at
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (type_id) DO UPDATE SET
           schema_json = EXCLUDED.schema_json,
           schema_version = EXCLUDED.schema_version,
           description = EXCLUDED.description,
           registered_by_app_id = EXCLUDED.registered_by_app_id,
           registered_at = EXCLUDED.registered_at`,
        [
          registration.typeId,
          JSON.stringify(registration.schema),
          registration.schemaVersion,
          registration.description,
          registration.registeredByAppId,
          serializeHLC(registration.registeredAt),
        ],
      );
    },

    async get(typeId: string): Promise<TypeRegistration | null> {
      const result = await client.query(
        "SELECT * FROM shared.type_registrations WHERE type_id = $1",
        [typeId],
      );
      if (result.rows.length === 0) return null;
      return rowToTypeRegistration(result.rows[0] as unknown as TypeRegistrationRow);
    },

    async list(): Promise<TypeRegistration[]> {
      const result = await client.query("SELECT * FROM shared.type_registrations");
      return (result.rows as unknown as TypeRegistrationRow[]).map(rowToTypeRegistration);
    },

    async delete(typeId: string): Promise<void> {
      await client.query(
        "DELETE FROM shared.type_registrations WHERE type_id = $1",
        [typeId],
      );
    },
  };
}

interface TypeRegistrationRow {
  type_id: string;
  schema_json: string;
  schema_version: string;
  description: string;
  registered_by_app_id: string;
  registered_at: string;
}

function rowToTypeRegistration(row: TypeRegistrationRow): TypeRegistration {
  return {
    typeId: row.type_id,
    schema: JSON.parse(row.schema_json) as object,
    schemaVersion: row.schema_version,
    description: row.description,
    registeredByAppId: row.registered_by_app_id,
    registeredAt: deserializeHLC(row.registered_at),
  };
}
