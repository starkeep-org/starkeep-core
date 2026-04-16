import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface AccessPolicy {
  id: string;
  subject_type: string;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  permissions: string[];
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export interface CreateAccessPolicyInput {
  subject_type: string;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  permissions: string[];
}

export class AccessPoliciesRepository {
  async findAll(): Promise<AccessPolicy[]> {
    const pool = getPool();
    const result: QueryResult<AccessPolicy> = await pool.query(
      "SELECT * FROM access_policies WHERE revoked_at IS NULL ORDER BY granted_at DESC",
    );
    return result.rows;
  }

  async findBySubject(subjectType: string, subjectId: string): Promise<AccessPolicy[]> {
    const pool = getPool();
    const result: QueryResult<AccessPolicy> = await pool.query(
      "SELECT * FROM access_policies WHERE subject_type = $1 AND subject_id = $2 AND revoked_at IS NULL",
      [subjectType, subjectId],
    );
    return result.rows;
  }

  async create(input: CreateAccessPolicyInput): Promise<AccessPolicy> {
    const pool = getPool();
    const result: QueryResult<AccessPolicy> = await pool.query(
      `INSERT INTO access_policies (subject_type, subject_id, resource_type, resource_id, permissions)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.subject_type,
        input.subject_id,
        input.resource_type,
        input.resource_id,
        input.permissions,
      ],
    );
    return requireRow(result, "Failed to create access policy");
  }

  async revoke(policyId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      "UPDATE access_policies SET revoked_at = NOW() WHERE id = $1",
      [policyId],
    );
  }

  async revokeAll(policyIds: string[]): Promise<void> {
    if (policyIds.length === 0) return;
    const pool = getPool();
    await pool.query(
      "UPDATE access_policies SET revoked_at = NOW() WHERE id = ANY($1)",
      [policyIds],
    );
  }
}
