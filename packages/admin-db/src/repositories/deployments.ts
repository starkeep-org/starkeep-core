import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface Deployment {
  id: string;
  plan_id: string;
  customer_id: string;
  stack_id: string | null;
  stack_arn: string | null;
  stack_name: string;
  region: string;
  status: string;
  status_reason: string | null;
  outputs: Record<string, any> | null;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateDeploymentInput {
  plan_id: string;
  customer_id: string;
  stack_id?: string;
  stack_arn?: string;
  stack_name: string;
  region: string;
  status?: string;
}

export interface UpdateDeploymentInput {
  stack_id?: string;
  stack_arn?: string;
  status?: string;
  status_reason?: string | null;
  outputs?: Record<string, any>;
  completed_at?: Date;
}

export class DeploymentsRepository {
  async findById(id: string): Promise<Deployment | null> {
    const pool = getPool();
    const result: QueryResult<Deployment> = await pool.query(
      "SELECT * FROM deployments WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async findByPlanId(planId: string): Promise<Deployment[]> {
    const pool = getPool();
    const result: QueryResult<Deployment> = await pool.query(
      "SELECT * FROM deployments WHERE plan_id = $1 ORDER BY started_at DESC",
      [planId]
    );
    return result.rows;
  }

  async findByCustomerId(customerId: string): Promise<Deployment[]> {
    const pool = getPool();
    const result: QueryResult<Deployment> = await pool.query(
      "SELECT * FROM deployments WHERE customer_id = $1 ORDER BY started_at DESC",
      [customerId]
    );
    return result.rows;
  }

  async findByStatus(status: string): Promise<Deployment[]> {
    const pool = getPool();
    const result: QueryResult<Deployment> = await pool.query(
      "SELECT * FROM deployments WHERE status = $1 ORDER BY started_at DESC",
      [status]
    );
    return result.rows;
  }

  async create(input: CreateDeploymentInput): Promise<Deployment> {
    const pool = getPool();
    const result: QueryResult<Deployment> = await pool.query(
      `INSERT INTO deployments (
        plan_id, customer_id, stack_id, stack_arn,
        stack_name, region, status
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.plan_id,
        input.customer_id,
        input.stack_id || null,
        input.stack_arn || null,
        input.stack_name,
        input.region,
        input.status || "IN_PROGRESS",
      ]
    );
    return requireRow(result, "Failed to create deployment");
  }

  async update(id: string, input: UpdateDeploymentInput): Promise<Deployment> {
    const pool = getPool();
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.stack_id !== undefined) {
      updates.push(`stack_id = $${paramCount++}`);
      values.push(input.stack_id);
    }
    if (input.stack_arn !== undefined) {
      updates.push(`stack_arn = $${paramCount++}`);
      values.push(input.stack_arn);
    }
    if (input.status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(input.status);
    }
    if (input.status_reason !== undefined) {
      updates.push(`status_reason = $${paramCount++}`);
      values.push(input.status_reason);
    }
    if (input.outputs !== undefined) {
      updates.push(`outputs = $${paramCount++}`);
      values.push(input.outputs ? JSON.stringify(input.outputs) : null);
    }
    if (input.completed_at !== undefined) {
      updates.push(`completed_at = $${paramCount++}`);
      values.push(input.completed_at);
    }

    if (updates.length === 0) {
      throw new Error("No fields to update");
    }

    values.push(id);
    const result: QueryResult<Deployment> = await pool.query(
      `UPDATE deployments
       SET ${updates.join(", ")}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    return requireRow(result, "Deployment not found");
  }

  async delete(id: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM deployments WHERE id = $1", [id]);
  }
}
