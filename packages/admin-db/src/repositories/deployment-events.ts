import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface DeploymentEvent {
  id: string;
  deployment_id: string;
  event_id: string | null;
  timestamp: Date;
  resource_type: string | null;
  logical_resource_id: string | null;
  physical_resource_id: string | null;
  resource_status: string | null;
  resource_status_reason: string | null;
  created_at: Date;
}

export interface CreateDeploymentEventInput {
  deployment_id: string;
  event_id?: string;
  timestamp: Date;
  resource_type?: string;
  logical_resource_id?: string;
  physical_resource_id?: string;
  resource_status?: string;
  resource_status_reason?: string;
}

export class DeploymentEventsRepository {
  async findById(id: string): Promise<DeploymentEvent | null> {
    const pool = getPool();
    const result: QueryResult<DeploymentEvent> = await pool.query(
      "SELECT * FROM deployment_events WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async findByDeploymentId(deploymentId: string, limit = 100): Promise<DeploymentEvent[]> {
    const pool = getPool();
    const result: QueryResult<DeploymentEvent> = await pool.query(
      "SELECT * FROM deployment_events WHERE deployment_id = $1 ORDER BY timestamp DESC LIMIT $2",
      [deploymentId, limit]
    );
    return result.rows;
  }

  async create(input: CreateDeploymentEventInput): Promise<DeploymentEvent> {
    const pool = getPool();
    const result: QueryResult<DeploymentEvent> = await pool.query(
      `INSERT INTO deployment_events (
        deployment_id, event_id, timestamp, resource_type,
        logical_resource_id, physical_resource_id,
        resource_status, resource_status_reason
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.deployment_id,
        input.event_id || null,
        input.timestamp,
        input.resource_type || null,
        input.logical_resource_id || null,
        input.physical_resource_id || null,
        input.resource_status || null,
        input.resource_status_reason || null,
      ]
    );
    return requireRow(result, "Failed to create deployment event");
  }

  async createBatch(events: CreateDeploymentEventInput[]): Promise<DeploymentEvent[]> {
    if (events.length === 0) return [];

    const pool = getPool();
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramCount = 1;

    events.forEach((event) => {
      placeholders.push(
        `($${paramCount++}, $${paramCount++}, $${paramCount++}, $${paramCount++}, $${paramCount++}, $${paramCount++}, $${paramCount++}, $${paramCount++})`
      );
      values.push(
        event.deployment_id,
        event.event_id || null,
        event.timestamp,
        event.resource_type || null,
        event.logical_resource_id || null,
        event.physical_resource_id || null,
        event.resource_status || null,
        event.resource_status_reason || null
      );
    });

    const result: QueryResult<DeploymentEvent> = await pool.query(
      `INSERT INTO deployment_events (
        deployment_id, event_id, timestamp, resource_type,
        logical_resource_id, physical_resource_id,
        resource_status, resource_status_reason
      )
       VALUES ${placeholders.join(", ")}
       RETURNING *`,
      values
    );

    return result.rows;
  }

  async delete(id: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM deployment_events WHERE id = $1", [id]);
  }

  async deleteByDeploymentId(deploymentId: string): Promise<void> {
    const pool = getPool();
    await pool.query("DELETE FROM deployment_events WHERE deployment_id = $1", [deploymentId]);
  }
}
