/**
 * Follow-up to run.ts, giving design B (jsonb) its best shot and testing whether
 * its weakness is structural.
 *
 *   1. DSQL accepts `INCLUDE (labels)` — a covering index with the jsonb as a
 *      non-key column. If that makes the rare-key scan index-only, design B's
 *      reverse lookup might be survivable. Measure it.
 *   2. Grow the library 20k → 60k records and re-measure. A's indexed seek
 *      should be flat; B's scan should grow with the library. That is the
 *      difference between "slower" and "doesn't scale".
 *
 *   POC_DSQL_CLUSTER=<id> tsx src/poc-record-labels/scale.ts
 */

import type pg from "pg";
import { connect, clusterId, timeIt, tryQuery } from "./connect.js";
import { SCHEMA } from "./schema.js";

const RARE_KEY = "needs-review";

async function ensureIncludeIndex(client: pg.Client): Promise<void> {
  const exists = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
    [SCHEMA, "idx_labels_json_include"],
  );
  if (exists.rows.length > 0) {
    console.log("  · idx_labels_json_include (exists)");
    return;
  }
  const res = await tryQuery(
    client,
    `CREATE INDEX ASYNC idx_labels_json_include
       ON ${SCHEMA}.labels_json (app_id, record_id) INCLUDE (labels)`,
  );
  if (!res.ok) throw new Error(`covering index failed: ${res.message}`);
  for (let i = 0; i < 90; i++) {
    const v = await client.query(
      `SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'idx_labels_json_include'`,
    );
    if (v.rows[0]?.indisvalid === true) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("  ✓ idx_labels_json_include built");
}

/** Extend both tables to `target` records, preserving the seed's label shape. */
async function growTo(client: pg.Client, from: number, target: number): Promise<void> {
  const BATCH = 1_000;
  const hlc = (i: number) => `2026-07-27T12:00:00.000Z:${String(i).padStart(6, "0")}:nodeA`;
  const rid = (i: number) => `rec_${String(i).padStart(6, "0")}`;

  for (let start = from; start < target; start += BATCH) {
    const n = Math.min(BATCH, target - start);
    const aRows = Array.from({ length: n }, (_, j) => {
      const i = start + j;
      return [rid(i), "alpha", "ocr-available", null, "image/jpeg", hlc(i), hlc(i), "nodeA", null];
    });
    const bRows = Array.from({ length: n }, (_, j) => {
      const i = start + j;
      return [
        rid(i),
        "alpha",
        JSON.stringify({ "ocr-available": null }),
        "image/jpeg",
        hlc(i),
        hlc(i),
        "nodeA",
        null,
      ];
    });
    const tuples = (rows: unknown[][], width: number) =>
      rows
        .map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(",")})`)
        .join(",");
    await client.query(
      `INSERT INTO ${SCHEMA}.labels_rows
         (record_id,app_id,key,value,record_type,created_at,updated_at,node_id,deleted_at)
       VALUES ${tuples(aRows, 9)} ON CONFLICT DO NOTHING`,
      aRows.flat() as never,
    );
    await client.query(
      `INSERT INTO ${SCHEMA}.labels_json
         (record_id,app_id,labels,record_type,created_at,updated_at,node_id,deleted_at)
       VALUES ${tuples(bRows, 8)} ON CONFLICT DO NOTHING`,
      bRows.flat() as never,
    );
  }
}

async function measure(client: pg.Client, label: string): Promise<void> {
  const total = await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.labels_json`);
  const n = (total.rows[0] as { n: number }).n;

  const aMs = await timeIt(5, async () => {
    await client.query(
      `SELECT record_id FROM ${SCHEMA}.labels_rows
        WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL
        ORDER BY record_id LIMIT 50`,
      ["alpha", RARE_KEY] as never,
    );
  });
  const bMs = await timeIt(5, async () => {
    await client.query(
      `SELECT record_id FROM ${SCHEMA}.labels_json
        WHERE app_id = $1 AND labels ? $2 AND deleted_at IS NULL
        ORDER BY record_id LIMIT 50`,
      ["alpha", RARE_KEY] as never,
    );
  });

  // Server-side execution time, isolated from the ~35ms network round trip.
  const serverTime = async (sql: string, params: unknown[]): Promise<string> => {
    const res = await tryQuery(client, `EXPLAIN ANALYZE ${sql}`, params);
    if (!res.ok) return "?";
    const text = (res.rows as Record<string, string>[]).map((r) => Object.values(r)[0]).join("\n");
    return text.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? "?";
  };
  const aExec = await serverTime(
    `SELECT record_id FROM ${SCHEMA}.labels_rows WHERE app_id = $1 AND key = $2 AND deleted_at IS NULL ORDER BY record_id LIMIT 50`,
    ["alpha", RARE_KEY],
  );
  const bExec = await serverTime(
    `SELECT record_id FROM ${SCHEMA}.labels_json WHERE app_id = $1 AND labels ? $2 AND deleted_at IS NULL ORDER BY record_id LIMIT 50`,
    ["alpha", RARE_KEY],
  );

  console.log(
    `  ${label.padEnd(22)} rows=${String(n).padStart(7)}   ` +
      `A wall ${aMs.toFixed(0).padStart(5)}ms / exec ${aExec.padStart(8)}ms   ` +
      `B wall ${bMs.toFixed(0).padStart(5)}ms / exec ${bExec.padStart(8)}ms`,
  );
}

async function main(): Promise<void> {
  console.log(`POC cluster: ${clusterId()}`);
  const client = await connect();

  console.log("\n--- Give design B its best shot: covering index with jsonb INCLUDEd ---");
  await ensureIncludeIndex(client);
  await measure(client, "20k records");

  console.log("\n--- Grow the library and re-measure (does B's cost scale?) ---");
  await growTo(client, 20_000, 60_000);
  await measure(client, "60k records");

  await growTo(client, 60_000, 120_000);
  await measure(client, "120k records");

  await client.end();
  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
