import type { DatabaseSync } from "node:sqlite";
import {
  createStarkeepId,
  deserializeHLC,
  serializeHLC,
  type HLCTimestamp,
  type StarkeepId,
  type TypeRegistration,
  type TypeRegistrationStore,
} from "@starkeep/core";
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

/**
 * SQLite-backed TypeRegistrationStore.
 */
export function createSqliteTypeRegistrationStore(
  db: DatabaseSync,
): TypeRegistrationStore {
  return {
    async put(registration: TypeRegistration): Promise<void> {
      db.prepare(
        `INSERT INTO type_registrations (
           type_id, schema_json, schema_version, description,
           registered_by_app_id, registered_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(type_id) DO UPDATE SET
           schema_json = excluded.schema_json,
           schema_version = excluded.schema_version,
           description = excluded.description,
           registered_by_app_id = excluded.registered_by_app_id,
           registered_at = excluded.registered_at`,
      ).run(
        registration.typeId,
        JSON.stringify(registration.schema),
        registration.schemaVersion,
        registration.description,
        registration.registeredByAppId,
        serializeHLC(registration.registeredAt),
      );
    },

    async get(typeId: string): Promise<TypeRegistration | null> {
      const row = db
        .prepare("SELECT * FROM type_registrations WHERE type_id = ?")
        .get(typeId) as TypeRegistrationRow | undefined;
      return row ? rowToTypeRegistration(row) : null;
    },

    async list(): Promise<TypeRegistration[]> {
      const rows = db
        .prepare("SELECT * FROM type_registrations")
        .all() as unknown as TypeRegistrationRow[];
      return rows.map(rowToTypeRegistration);
    },

    async delete(typeId: string): Promise<void> {
      db.prepare("DELETE FROM type_registrations WHERE type_id = ?").run(typeId);
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
    registeredAt: deserializeHLC(row.registered_at) as HLCTimestamp,
  };
}
