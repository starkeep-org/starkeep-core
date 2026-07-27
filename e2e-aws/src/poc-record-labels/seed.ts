/**
 * Seed both candidate tables with the *same logical data* so the query
 * comparisons are apples-to-apples.
 *
 * Shape (modelled on a real photo library):
 *   - N records of type image/jpeg
 *   - app `alpha` labels EVERY record with `ocr-available`  (high selectivity)
 *   - app `alpha` labels RARE_COUNT of them `needs-review`  (low selectivity —
 *     the "rare flag" pattern that decides the reverse-lookup question)
 *   - app `gamma` labels the first 25% with `quality` = high|low
 *
 * Design A stores that as one row per (record, app, key); design B as one row
 * per (record, app) with the keys merged into a jsonb object.
 */

import type pg from "pg";
import { SCHEMA } from "./schema.js";

export const N_RECORDS = 20_000;
export const RARE_COUNT = 20;
const GAMMA_FRACTION = 0.25;

/** DSQL caps a write transaction at 3,000 rows / 10 MiB; stay well inside. */
const BATCH = 1_000;

const recordId = (i: number) => `rec_${String(i).padStart(6, "0")}`;
const hlc = (i: number) => `2026-07-27T12:00:00.000Z:${String(i).padStart(6, "0")}:nodeA`;

async function countRows(client: pg.Client, table: string): Promise<number> {
  const res = await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.${table}`);
  return (res.rows[0] as { n: number }).n;
}

/** Multi-row INSERT built as one statement (one implicit transaction). */
async function insertBatch(
  client: pg.Client,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const width = columns.length;
  const tuples = rows
    .map(
      (_, r) =>
        `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(",")})`,
    )
    .join(",");
  const sql =
    `INSERT INTO ${SCHEMA}.${table} (${columns.join(",")}) VALUES ${tuples} ` +
    `ON CONFLICT DO NOTHING`;
  await client.query(sql, rows.flat() as never);
}

export async function seed(client: pg.Client): Promise<{ rowsA: number; rowsB: number }> {
  const existingA = await countRows(client, "labels_rows");
  const existingB = await countRows(client, "labels_json");
  if (existingA > 0 || existingB > 0) {
    console.log(`  · already seeded (A=${existingA}, B=${existingB}) — skipping`);
    return { rowsA: existingA, rowsB: existingB };
  }

  const gammaCutoff = Math.floor(N_RECORDS * GAMMA_FRACTION);

  // ---- Design A ----------------------------------------------------------
  const colsA = [
    "record_id",
    "app_id",
    "key",
    "value",
    "record_type",
    "created_at",
    "updated_at",
    "node_id",
    "deleted_at",
  ];
  let batchA: unknown[][] = [];
  const flushA = async () => {
    await insertBatch(client, "labels_rows", colsA, batchA);
    batchA = [];
  };
  for (let i = 0; i < N_RECORDS; i++) {
    const rid = recordId(i);
    batchA.push([rid, "alpha", "ocr-available", null, "image/jpeg", hlc(i), hlc(i), "nodeA", null]);
    if (batchA.length >= BATCH) await flushA();
    if (i < RARE_COUNT) {
      batchA.push([rid, "alpha", "needs-review", null, "image/jpeg", hlc(i), hlc(i), "nodeA", null]);
      if (batchA.length >= BATCH) await flushA();
    }
    if (i < gammaCutoff) {
      const v = i % 2 === 0 ? "high" : "low";
      batchA.push([rid, "gamma", "quality", v, "image/jpeg", hlc(i), hlc(i), "nodeA", null]);
      if (batchA.length >= BATCH) await flushA();
    }
  }
  await flushA();

  // ---- Design B ----------------------------------------------------------
  const colsB = [
    "record_id",
    "app_id",
    "labels",
    "record_type",
    "created_at",
    "updated_at",
    "node_id",
    "deleted_at",
  ];
  let batchB: unknown[][] = [];
  const flushB = async () => {
    await insertBatch(client, "labels_json", colsB, batchB);
    batchB = [];
  };
  for (let i = 0; i < N_RECORDS; i++) {
    const rid = recordId(i);
    const alpha: Record<string, unknown> = { "ocr-available": null };
    if (i < RARE_COUNT) alpha["needs-review"] = null;
    batchB.push([rid, "alpha", JSON.stringify(alpha), "image/jpeg", hlc(i), hlc(i), "nodeA", null]);
    if (batchB.length >= BATCH) await flushB();
    if (i < gammaCutoff) {
      const v = i % 2 === 0 ? "high" : "low";
      batchB.push([
        rid,
        "gamma",
        JSON.stringify({ quality: v }),
        "image/jpeg",
        hlc(i),
        hlc(i),
        "nodeA",
        null,
      ]);
      if (batchB.length >= BATCH) await flushB();
    }
  }
  await flushB();

  return {
    rowsA: await countRows(client, "labels_rows"),
    rowsB: await countRows(client, "labels_json"),
  };
}

export { recordId };
