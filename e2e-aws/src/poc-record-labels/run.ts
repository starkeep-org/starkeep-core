/**
 * Runner for the cross-app-label schema POC.
 *
 *   POC_DSQL_CLUSTER=<id> [POC_DSQL_REGION=us-east-2] node --experimental-strip-types run.ts
 *
 * Creates both candidate schemas in a disposable DSQL cluster, seeds them with
 * identical logical data, and runs the experiments that decide between them.
 * Read-only against anything it did not create; it never touches a starkeep
 * deployment's cluster (the cluster id has no default).
 */

import { connect, clusterId, REGION } from "./connect.js";
import { createSchema } from "./schema.js";
import { seed, N_RECORDS, RARE_COUNT } from "./seed.js";
import {
  e1JsonbOperators,
  e2JsonbIndexing,
  e3ReverseLookup,
  e4ForwardLookup,
  e5Concurrency,
  e6TransactionLimits,
  e7Sizes,
  type Probe,
  type QueryResult,
} from "./experiments.js";

function header(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

function printProbes(probes: Probe[]): void {
  for (const p of probes) {
    console.log(`  ${p.ok ? "✓" : "✗"} ${p.what}`);
    console.log(`      ${p.detail.replace(/\n/g, "\n      ")}`);
  }
}

function printQueries(results: QueryResult[], showPlans: boolean): void {
  for (const r of results) {
    console.log(`  ${r.what.padEnd(48)} ${r.medianMs.toFixed(1).padStart(9)} ms   (${r.rowCount} rows)`);
  }
  if (showPlans) {
    for (const r of results) {
      console.log(`\n  --- plan: ${r.what} ---\n      ${r.plan.replace(/\n/g, "\n      ")}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`POC cluster: ${clusterId()} (${REGION})`);
  const client = await connect();

  header("Schema");
  await createSchema(client);

  header(`Seed — ${N_RECORDS} records, ${RARE_COUNT} carrying the rare key`);
  const t0 = performance.now();
  const counts = await seed(client);
  console.log(
    `  design A rows: ${counts.rowsA}   design B rows: ${counts.rowsB}   (${((performance.now() - t0) / 1000).toFixed(1)}s)`,
  );

  header("E1 — jsonb partial-update operators on DSQL");
  printProbes(await e1JsonbOperators(client));

  header("E2 — can a jsonb column be indexed at all?");
  printProbes(await e2JsonbIndexing(client));

  header("E3 — reverse lookup: 'which records did app A label X?'");
  printQueries(await e3ReverseLookup(client), true);

  header("E4 — forward lookup: hydrate labels for a 50-record page");
  printQueries(await e4ForwardLookup(client), false);

  header("E5 — OCC contention under concurrent writes");
  printProbes(await e5Concurrency());

  header("E6 — transaction row limits");
  printProbes(await e6TransactionLimits(client));

  header("E7 — row counts for the same logical data");
  printProbes(await e7Sizes(client));

  await client.end();
  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
