import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface Template {
  id: string;
  customer_id: string;
  name: string;
  description: string | null;
  s3_bucket: string;
  s3_key: string;
  version: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTemplateInput {
  customer_id: string;
  name: string;
  description?: string;
  s3_bucket: string;
  s3_key: string;
  version?: string;
}

export interface UpdateTemplateInput {
  description?: string;
  is_active?: boolean;
}

export class TemplatesRepository {
  async findById(id: string): Promise<Template | null> {
    const pool = getPool();
    const result: QueryResult<Template> = await pool.query(
      "SELECT * FROM templates WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async findByCustomerId(customerId: string): Promise<Template[]> {
    const pool = getPool();
    const result: QueryResult<Template> = await pool.query(
      "SELECT * FROM templates WHERE customer_id = $1 ORDER BY created_at DESC",
      [customerId]
    );
    return result.rows;
  }

  async findActiveByCustomerId(customerId: string): Promise<Template[]> {
    const pool = getPool();
    const result: QueryResult<Template> = await pool.query(
      "SELECT * FROM templates WHERE customer_id = $1 AND is_active = true ORDER BY created_at DESC",
      [customerId]
    );
    return result.rows;
  }

  async findByCustomerAndName(customerId: string, name: string): Promise<Template[]> {
    const pool = getPool();
    const result: QueryResult<Template> = await pool.query(
      "SELECT * FROM templates WHERE customer_id = $1 AND name = $2 ORDER BY version DESC",
      [customerId, name]
    );
    return result.rows;
  }

  async create(input: CreateTemplateInput): Promise<Template> {
    const pool = getPool();
    const result: QueryResult<Template> = await pool.query(
      `INSERT INTO templates (customer_id, name, description, s3_bucket, s3_key, version)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.customer_id,
        input.name,
        input.description || null,
        input.s3_bucket,
        input.s3_key,
        input.version || "1.0.0",
      ]
    );
    return requireRow(result, "Failed to create template");
  }

  async update(id: string, input: UpdateTemplateInput): Promise<Template> {
    const pool = getPool();
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(input.description);
    }
    if (input.is_active !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      values.push(input.is_active);
    }

    if (updates.length === 0) {
      throw new Error("No fields to update");
    }

    values.push(id);
    const result: QueryResult<Template> = await pool.query(
      `UPDATE templates
       SET ${updates.join(", ")}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    return requireRow(result, "Template not found");
  }

  async delete(id: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM templates WHERE id = $1", [id]);
  }

  getTemplateUrl(template: Template): string {
    return `https://${template.s3_bucket}.s3.amazonaws.com/${template.s3_key}`;
  }
}
