import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface TypeRegistration {
  id: string;
  type_id: string;
  schema_version: string;
  description: string;
  schema: Record<string, unknown> | null;
  registered_by_app_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTypeRegistrationInput {
  type_id: string;
  schema_version: string;
  description: string;
  schema?: Record<string, unknown>;
  registered_by_app_id?: string;
}

export class TypeRegistryRepository {
  async findAll(): Promise<TypeRegistration[]> {
    const pool = getPool();
    const result: QueryResult<TypeRegistration> = await pool.query(
      "SELECT * FROM type_registrations ORDER BY type_id",
    );
    return result.rows;
  }

  async findByTypeId(typeId: string): Promise<TypeRegistration | null> {
    const pool = getPool();
    const result: QueryResult<TypeRegistration> = await pool.query(
      "SELECT * FROM type_registrations WHERE type_id = $1",
      [typeId],
    );
    return result.rows[0] || null;
  }

  async create(input: CreateTypeRegistrationInput): Promise<TypeRegistration> {
    const pool = getPool();
    const result: QueryResult<TypeRegistration> = await pool.query(
      `INSERT INTO type_registrations (type_id, schema_version, description, schema, registered_by_app_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.type_id,
        input.schema_version,
        input.description,
        input.schema ? JSON.stringify(input.schema) : null,
        input.registered_by_app_id ?? null,
      ],
    );
    return requireRow(result, "Failed to create type registration");
  }

  async delete(typeId: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM type_registrations WHERE type_id = $1", [typeId]);
  }
}
