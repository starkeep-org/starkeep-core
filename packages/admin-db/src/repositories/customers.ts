import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface Customer {
  id: string;
  email: string;
  name: string | null;
  aws_account_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCustomerInput {
  email: string;
  name?: string;
  aws_account_id?: string;
}

export interface UpdateCustomerInput {
  name?: string;
  aws_account_id?: string;
}

export class CustomersRepository {
  async findById(id: string): Promise<Customer | null> {
    const pool = getPool();
    const result: QueryResult<Customer> = await pool.query(
      "SELECT * FROM customers WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async findByEmail(email: string): Promise<Customer | null> {
    const pool = getPool();
    const result: QueryResult<Customer> = await pool.query(
      "SELECT * FROM customers WHERE email = $1",
      [email]
    );
    return result.rows[0] || null;
  }

  async findAll(): Promise<Customer[]> {
    const pool = getPool();
    const result: QueryResult<Customer> = await pool.query(
      "SELECT * FROM customers ORDER BY created_at DESC"
    );
    return result.rows;
  }

  async create(input: CreateCustomerInput): Promise<Customer> {
    const pool = getPool();
    const result: QueryResult<Customer> = await pool.query(
      `INSERT INTO customers (email, name, aws_account_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.email, input.name || null, input.aws_account_id || null]
    );
    return requireRow(result, "Failed to create customer");
  }

  async update(id: string, input: UpdateCustomerInput): Promise<Customer> {
    const pool = getPool();
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(input.name);
    }
    if (input.aws_account_id !== undefined) {
      updates.push(`aws_account_id = $${paramCount++}`);
      values.push(input.aws_account_id);
    }

    if (updates.length === 0) {
      throw new Error("No fields to update");
    }

    values.push(id);
    const result: QueryResult<Customer> = await pool.query(
      `UPDATE customers
       SET ${updates.join(", ")}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    return requireRow(result, "Customer not found");
  }

  async delete(id: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM customers WHERE id = $1", [id]);
  }
}
