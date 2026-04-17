import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface AwsSettings {
  id: string;
  customer_id: string;
  account_id: string;
  default_region: string;
  allowed_regions: string[] | null;
  stack_prefix: string;
  role_arn: string; // IAM role to assume in target account (required)
  external_id: string; // External ID for AssumeRole (required)
  execution_role_arn: string | null; // CloudFormation execution role ARN
  permission_boundary_arn: string | null; // Permission boundary for IAM roles
  created_at: Date;
  updated_at: Date;
}

export interface CreateAwsSettingsInput {
  customer_id: string;
  account_id: string;
  role_arn: string; // Required - IAM role to assume
  external_id: string; // Required - External ID for security
  default_region?: string;
  allowed_regions?: string[];
  stack_prefix?: string;
  execution_role_arn?: string;
  permission_boundary_arn?: string;
}

export interface UpdateAwsSettingsInput {
  account_id?: string;
  default_region?: string;
  allowed_regions?: string[];
  stack_prefix?: string;
  role_arn?: string;
  external_id?: string;
  execution_role_arn?: string;
  permission_boundary_arn?: string;
}

export class AwsSettingsRepository {
  async findById(id: string): Promise<AwsSettings | null> {
    const pool = getPool();
    const result: QueryResult<AwsSettings> = await pool.query(
      "SELECT * FROM aws_settings WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async findByCustomerId(customerId: string): Promise<AwsSettings | null> {
    const pool = getPool();
    const result: QueryResult<AwsSettings> = await pool.query(
      "SELECT * FROM aws_settings WHERE customer_id = $1",
      [customerId]
    );
    return result.rows[0] || null;
  }

  async create(input: CreateAwsSettingsInput): Promise<AwsSettings> {
    const pool = getPool();
    const result: QueryResult<AwsSettings> = await pool.query(
      `INSERT INTO aws_settings (
        customer_id, account_id, default_region, allowed_regions, stack_prefix,
        role_arn, external_id, execution_role_arn, permission_boundary_arn
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.customer_id,
        input.account_id,
        input.default_region || "us-east-1",
        input.allowed_regions || null,
        input.stack_prefix || "app",
        input.role_arn, // Required
        input.external_id, // Required
        input.execution_role_arn || null,
        input.permission_boundary_arn || null,
      ]
    );
    return requireRow(result, "Failed to create AWS settings");
  }

  async update(customerId: string, input: UpdateAwsSettingsInput): Promise<AwsSettings> {
    const pool = getPool();
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.account_id !== undefined) {
      updates.push(`account_id = $${paramCount++}`);
      values.push(input.account_id);
    }
    if (input.default_region !== undefined) {
      updates.push(`default_region = $${paramCount++}`);
      values.push(input.default_region);
    }
    if (input.allowed_regions !== undefined) {
      updates.push(`allowed_regions = $${paramCount++}`);
      values.push(input.allowed_regions);
    }
    if (input.stack_prefix !== undefined) {
      updates.push(`stack_prefix = $${paramCount++}`);
      values.push(input.stack_prefix);
    }
    if (input.role_arn !== undefined) {
      updates.push(`role_arn = $${paramCount++}`);
      values.push(input.role_arn);
    }
    if (input.external_id !== undefined) {
      updates.push(`external_id = $${paramCount++}`);
      values.push(input.external_id);
    }
    if (input.execution_role_arn !== undefined) {
      updates.push(`execution_role_arn = $${paramCount++}`);
      values.push(input.execution_role_arn);
    }
    if (input.permission_boundary_arn !== undefined) {
      updates.push(`permission_boundary_arn = $${paramCount++}`);
      values.push(input.permission_boundary_arn);
    }

    if (updates.length === 0) {
      throw new Error("No fields to update");
    }

    values.push(customerId);
    const result: QueryResult<AwsSettings> = await pool.query(
      `UPDATE aws_settings
       SET ${updates.join(", ")}
       WHERE customer_id = $${paramCount}
       RETURNING *`,
      values
    );

    return requireRow(result, "AWS settings not found");
  }

  async upsert(input: CreateAwsSettingsInput): Promise<AwsSettings> {
    const existing = await this.findByCustomerId(input.customer_id);
    if (existing) {
      return this.update(input.customer_id, input);
    }
    return this.create(input);
  }

  async delete(customerId: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM aws_settings WHERE customer_id = $1", [customerId]);
  }
}
