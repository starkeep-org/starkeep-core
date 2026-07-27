/**
 * Runner for step 0c — the reverse-index shape verification.
 *
 *   POC_DSQL_CLUSTER=<id> [POC_DSQL_REGION=us-east-2] pnpm exec tsx src/poc-record-labels/verify-index.ts
 *
 * Separate from `run.ts` so the row-per-key vs jsonb result stays reproducible
 * on its own. Same disposable-cluster rule: the identifier has no default.
 */

import { connect, clusterId, REGION } from "./connect.js";
import { SCHEMA } from "./schema.js";
import { tryQuery } from "./connect.js";
import {
  q1CreateIndexes,
  q2ScanKey,
  seedChurn,
  LIVE_COUNT,
  TOMBSTONE_COUNT,
} from "./reverse-index.js";
import type { Probe, QueryResult } from "./experiments.js";

function header(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

function printProbes(probes: Probe[]): void {
  for (const p of probes) {
    console.log(`  ${p.ok ? "✓" : "✗"} ${p.what}`);
    console.log(`      ${p.detail.replace(/\n/g, "\n      ")}`);
  }
}

function printQueries(results: QueryResult[]): void {
  for (const r of results) {
    console.log(
      `  ${r.what.padEnd(50)} ${r.medianMs.toFixed(1).padStart(9)} ms   (${r.rowCount} rows)`,
    );
  }
  for (const r of results) {
    console.log(`\n  --- plan: ${r.what} ---\n      ${r.plan.replace(/\n/g, "\n      ")}`);
  }
}

/** `Execution Time: 0.918 ms` → 0.918. */
function execMs(plan: string): number | null {
  const m = /Execution Time:\s*([\d.]+)\s*ms/.exec(plan);
  return m ? Number(m[1]) : null;
}

/**
 * Largest `actual rows=N` on a B-Tree Scan line — how many index entries the
 * scan actually walked, which is the thing `deleted_at` in the key is supposed
 * to shrink.
 */
function scannedRows(plan: string): number | null {
  const counts = [...plan.matchAll(/B-Tree Scan[^\n]*actual rows=(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  return counts.length > 0 ? Math.max(...counts) : null;
}

async function main(): Promise<void> {
  console.log(`POC cluster: ${clusterId()} (${REGION})`);
  const client = await connect();
  await tryQuery(client, `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

  header("Q1 — does DSQL accept INCLUDE on a regular b-tree?");
  const { probes, variant } = await q1CreateIndexes(client);
  printProbes(probes);
  if (!variant) {
    console.error("\nNo reverse-index shape was accepted — §4 needs rethinking, not a fallback.");
    await client.end();
    process.exit(1);
  }
  console.log(`\n  → winning variant: ${variant}`);

  header(`Seed — ${LIVE_COUNT} live rows behind ${TOMBSTONE_COUNT} tombstones on one key`);
  const counts = await seedChurn(client);
  console.log(`  live: ${counts.live}   tombstoned: ${counts.dead}`);

  header("Q2 — is `deleted_at IS NULL` a scan key or a filter?");
  const results = await q2ScanKey(client);
  printQueries(results);

  const final = results[0]!;
  const ctl = results[1]!;
  header("Verdict");

  // Round-trip wall time is dominated by network and cold-cache effects — it
  // swung 6× between runs here. The decisive numbers are DSQL-side: how many
  // index entries the scan actually walked, and the engine's own execution
  // time. §3a used the same metric for the same reason.
  console.log(
    `  index entries scanned   final ${scannedRows(final.plan) ?? "?"}   ` +
      `ctl ${scannedRows(ctl.plan) ?? "?"}`,
  );
  console.log(
    `  DSQL execution time     final ${execMs(final.plan)?.toFixed(3) ?? "?"} ms   ` +
      `ctl ${execMs(ctl.plan)?.toFixed(3) ?? "?"} ms`,
  );
  console.log(
    `  wall (median of 5)      final ${final.medianMs.toFixed(1)} ms   ctl ${ctl.medianMs.toFixed(1)} ms   (noisy — not the signal)`,
  );

  const finalScanned = scannedRows(final.plan);
  const ctlScanned = scannedRows(ctl.plan);
  const isScanKey =
    finalScanned !== null && ctlScanned !== null && ctlScanned > finalScanned * 10;
  console.log(
    isScanKey
      ? "\n  → SCAN KEY. `deleted_at IS NULL` appears in the Index Cond and the scan\n" +
          "    touches only live rows; the control walks the whole tombstone pile and\n" +
          "    filters after a heap lookup. §4's shape stands, and the tombstone sweep\n" +
          "    (§10) stays a storage-cost question rather than a latency remedy."
      : "\n  → NOT a scan key. Apply §4's fallback: drop `deleted_at` from the index,\n" +
          "    reinstate the tombstone-accumulation caveat in §6 and the janitor in §10.",
  );

  await client.end();
  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
