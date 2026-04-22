import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface InfraCatalogEntry {
  id: string;
  resource_type: string;
  resource_id: string;
  name: string;
  source: string;
  owner_app_id: string | null;
  resolved_for_apps: string[];
  tags: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateInfraCatalogInput {
  resource_type: string;
  resource_id: string;
  name: string;
  source: "core" | "app";
  owner_app_id?: string;
  tags?: Record<string, string>;
}

export class InfraCatalogRepository {
  async findAll(): Promise<InfraCatalogEntry[]> {
    const pool = getPool();
    const result: QueryResult<InfraCatalogEntry> = await pool.query(
      "SELECT * FROM infra_catalog ORDER BY resource_type, name",
    );
    return result.rows;
  }

  async findByType(resourceType: string): Promise<InfraCatalogEntry[]> {
    const pool = getPool();
    const result: QueryResult<InfraCatalogEntry> = await pool.query(
      "SELECT * FROM infra_catalog WHERE resource_type = $1",
      [resourceType],
    );
    return result.rows;
  }

  async create(input: CreateInfraCatalogInput): Promise<InfraCatalogEntry> {
    const pool = getPool();
    const result: QueryResult<InfraCatalogEntry> = await pool.query(
      `INSERT INTO infra_catalog (resource_type, resource_id, name, source, owner_app_id, tags)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.resource_type,
        input.resource_id,
        input.name,
        input.source,
        input.owner_app_id ?? null,
        JSON.stringify(input.tags ?? {}),
      ],
    );
    return requireRow(result, "Failed to create infra catalog entry");
  }

  async addResolvedApp(id: string, appId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      "UPDATE infra_catalog SET resolved_for_apps = array_append(resolved_for_apps, $1), updated_at = NOW() WHERE id = $2",
      [appId, id],
    );
  }

  async removeResolvedApp(appId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      "UPDATE infra_catalog SET resolved_for_apps = array_remove(resolved_for_apps, $1), updated_at = NOW() WHERE $1 = ANY(resolved_for_apps)",
      [appId],
    );
  }

  async deleteByOwnerApp(appId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      "DELETE FROM infra_catalog WHERE owner_app_id = $1",
      [appId],
    );
  }
}
