/**
 * The two candidate schemas for cross-app record labels, side by side in one
 * DSQL cluster so they can be measured against identical data.
 *
 *   Design A — row per (record, app, key), scalar `value`.
 *   Design B — row per (record, app), all keys in one `jsonb` column.
 *
 * Both carry the same HLC bookkeeping columns the rest of the shared plane uses
 * (`updated_at` / `node_id` / `deleted_at`) so the sync-path comparison is fair.
 *
 * DSQL DDL rules observed here (see dsql-schema-init.ts): one statement per
 * transaction, no FKs, no partial indexes, `CREATE INDEX ASYNC` for secondary
 * indexes with a pg_indexes pre-check.
 */

import type pg from "pg";
import { tryQuery } from "./connect.js";

export const SCHEMA = "poc";

const DDL: { label: string; sql: string }[] = [
  { label: "schema", sql: `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}` },

  // ---- Design A: row per (record, app, key) -------------------------------
  {
    label: "labels_rows table",
    sql: `CREATE TABLE IF NOT EXISTS ${SCHEMA}.labels_rows (
            record_id   text not null,
            app_id      text not null,
            key         text not null,
            value       text,
            record_type text not null,
            created_at  text not null,
            updated_at  text not null,
            node_id     text not null,
            deleted_at  text,
            primary key (record_id, app_id, key)
          )`,
  },

  // ---- Design B: row per (record, app), keys in jsonb ---------------------
  {
    label: "labels_json table",
    sql: `CREATE TABLE IF NOT EXISTS ${SCHEMA}.labels_json (
            record_id   text not null,
            app_id      text not null,
            labels      jsonb not null,
            record_type text not null,
            created_at  text not null,
            updated_at  text not null,
            node_id     text not null,
            deleted_at  text,
            primary key (record_id, app_id)
          )`,
  },
];

const INDEXES: { name: string; sql: string }[] = [
  {
    name: "idx_labels_rows_reverse",
    sql: `CREATE INDEX ASYNC idx_labels_rows_reverse
            ON ${SCHEMA}.labels_rows (app_id, key, record_id)`,
  },
  {
    name: "idx_labels_rows_watermark",
    sql: `CREATE INDEX ASYNC idx_labels_rows_watermark
            ON ${SCHEMA}.labels_rows (node_id, updated_at)`,
  },
  {
    name: "idx_labels_json_app",
    sql: `CREATE INDEX ASYNC idx_labels_json_app
            ON ${SCHEMA}.labels_json (app_id, record_id)`,
  },
  {
    name: "idx_labels_json_watermark",
    sql: `CREATE INDEX ASYNC idx_labels_json_watermark
            ON ${SCHEMA}.labels_json (node_id, updated_at)`,
  },
];

async function indexExists(client: pg.Client, name: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
    [SCHEMA, name],
  );
  return res.rows.length > 0;
}

/** Poll pg_index until the async build reports valid (or the budget runs out). */
async function waitForIndex(client: pg.Client, name: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const res = await client.query(
      `SELECT indisvalid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [name],
    );
    if (res.rows[0]?.indisvalid === true) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function createSchema(client: pg.Client): Promise<void> {
  for (const stmt of DDL) {
    const res = await tryQuery(client, stmt.sql);
    if (!res.ok) throw new Error(`DDL failed (${stmt.label}): ${res.message}`);
    console.log(`  ✓ ${stmt.label}`);
  }
  for (const idx of INDEXES) {
    if (await indexExists(client, idx.name)) {
      console.log(`  · ${idx.name} (exists)`);
      continue;
    }
    const res = await tryQuery(client, idx.sql);
    if (!res.ok) throw new Error(`index failed (${idx.name}): ${res.message}`);
    const valid = await waitForIndex(client, idx.name);
    console.log(`  ✓ ${idx.name}${valid ? "" : " (WARNING: not valid within budget)"}`);
  }
}

export async function dropSchema(client: pg.Client): Promise<void> {
  for (const t of ["labels_rows", "labels_json"]) {
    await tryQuery(client, `DROP TABLE IF EXISTS ${SCHEMA}.${t}`);
  }
}
