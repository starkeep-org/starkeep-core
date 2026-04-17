import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface Plan {
  id: string;
  customer_id: string;
  template_id: string | null;
  change_set_id: string | null;
  change_set_arn: string | null;
  stack_name: string;
  region: string;
  environment: string | null;
  parameters: Record<string, any> | null;
  tags: Record<string, any> | null;
  status: string;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePlanInput {
  customer_id: string;
  template_id?: string;
  change_set_id?: string;
  change_set_arn?: string;
  stack_name: string;
  region: string;
  environment?: string;
  parameters?: Record<string, any>;
  tags?: Record<string, any>;
  created_by?: string;
}

export interface UpdatePlanInput {
  change_set_id?: string;
  change_set_arn?: string;
  status?: string;
  approved_by?: string;
  approved_at?: Date;
}

export class PlansRepository {
  async findById(id: string): Promise<Plan | null> {
    const pool = getPool();
    const result: QueryResult<Plan> = await pool.query(
      "SELECT * FROM plans WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async findByCustomerId(customerId: string): Promise<Plan[]> {
    const pool = getPool();
    const result: QueryResult<Plan> = await pool.query(
      "SELECT * FROM plans WHERE customer_id = $1 ORDER BY created_at DESC",
      [customerId]
    );
    return result.rows;
  }

  async findByStatus(status: string): Promise<Plan[]> {
    const pool = getPool();
    const result: QueryResult<Plan> = await pool.query(
      "SELECT * FROM plans WHERE status = $1 ORDER BY created_at DESC",
      [status]
    );
    return result.rows;
  }

  async create(input: CreatePlanInput): Promise<Plan> {
    const pool = getPool();
    const result: QueryResult<Plan> = await pool.query(
      `INSERT INTO plans (
        customer_id, template_id, change_set_id, change_set_arn,
        stack_name, region, environment, parameters, tags, created_by
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.customer_id,
        input.template_id || null,
        input.change_set_id || null,
        input.change_set_arn || null,
        input.stack_name,
        input.region,
        input.environment || null,
        input.parameters ? JSON.stringify(input.parameters) : null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.created_by || null,
      ]
    );
    return requireRow(result, "Failed to create plan");
  }

  async update(id: string, input: UpdatePlanInput): Promise<Plan> {
    const pool = getPool();
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.change_set_id !== undefined) {
      updates.push(`change_set_id = $${paramCount++}`);
      values.push(input.change_set_id);
    }
    if (input.change_set_arn !== undefined) {
      updates.push(`change_set_arn = $${paramCount++}`);
      values.push(input.change_set_arn);
    }
    if (input.status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(input.status);
    }
    if (input.approved_by !== undefined) {
      updates.push(`approved_by = $${paramCount++}`);
      values.push(input.approved_by);
    }
    if (input.approved_at !== undefined) {
      updates.push(`approved_at = $${paramCount++}`);
      values.push(input.approved_at);
    }

    if (updates.length === 0) {
      throw new Error("No fields to update");
    }

    values.push(id);
    const result: QueryResult<Plan> = await pool.query(
      `UPDATE plans
       SET ${updates.join(", ")}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    return requireRow(result, "Plan not found");
  }

  async delete(id: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM plans WHERE id = $1", [id]);
  }
}
