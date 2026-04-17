import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface AppRegistryEntry {
  id: string;
  app_id: string;
  name: string;
  version: string;
  tier: string;
  manifest: Record<string, unknown>;
  status: string;
  policy_ids: string[];
  registered_type_ids: string[];
  installed_at: Date;
  updated_at: Date;
}

export interface CreateAppRegistryInput {
  app_id: string;
  name: string;
  version: string;
  tier: string;
  manifest: Record<string, unknown>;
  policy_ids?: string[];
  registered_type_ids?: string[];
}

export class AppRegistryRepository {
  async findAll(): Promise<AppRegistryEntry[]> {
    const pool = getPool();
    const result: QueryResult<AppRegistryEntry> = await pool.query(
      "SELECT * FROM app_registry ORDER BY installed_at DESC",
    );
    return result.rows;
  }

  async findByAppId(appId: string): Promise<AppRegistryEntry | null> {
    const pool = getPool();
    const result: QueryResult<AppRegistryEntry> = await pool.query(
      "SELECT * FROM app_registry WHERE app_id = $1",
      [appId],
    );
    return result.rows[0] || null;
  }

  async create(input: CreateAppRegistryInput): Promise<AppRegistryEntry> {
    const pool = getPool();
    const result: QueryResult<AppRegistryEntry> = await pool.query(
      `INSERT INTO app_registry (app_id, name, version, tier, manifest, status, policy_ids, registered_type_ids)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
       RETURNING *`,
      [
        input.app_id,
        input.name,
        input.version,
        input.tier,
        JSON.stringify(input.manifest),
        input.policy_ids ?? [],
        input.registered_type_ids ?? [],
      ],
    );
    return requireRow(result, "Failed to create app registry entry");
  }

  async updateStatus(appId: string, status: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      "UPDATE app_registry SET status = $1, updated_at = NOW() WHERE app_id = $2",
      [status, appId],
    );
  }

  async delete(appId: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM app_registry WHERE app_id = $1", [appId]);
  }
}
