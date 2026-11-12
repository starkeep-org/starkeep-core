// Print the per-step table from the JSON document cognito.mjs wrote.
// (Adapted from ../s3-ssm/report.mjs: one driver, rows grouped by area.)
//
// Usage: node report.mjs <cognito.json>
// Exit code: 0 when the driver ran to the end (whatever the per-step
// outcomes), 1 when it produced no report or aborted part-way.

import { readFileSync } from "node:fs";

let missing = 0;
const reports = process.argv.slice(2).map((path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1));
  } catch (err) {
    missing += 1;
    return { area: path, rows: [], error: `no report (${err.message})` };
  }
});

const rows = reports.flatMap((r) => r.rows);
const width = (key, cap) =>
  Math.min(cap, Math.max(key.length, ...rows.map((r) => String(r[key]).length)));
const cols = [
  ["area", width("area", 8)],
  ["op", width("op", 80)],
  ["outcome", 7],
  ["ms", 6],
];
const pad = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const line = (cells) => cells.join(" | ");

console.log(line(cols.map(([k, n]) => pad(k, n))) + " | detail");
console.log(line(cols.map(([, n]) => "-".repeat(n))) + " | ------");
for (const r of rows) {
  console.log(
    line(cols.map(([k, n]) => (k === "ms" ? String(r[k]).padStart(n) : pad(String(r[k]), n)))) +
      ` | ${r.detail}`,
  );
}
console.log("");
for (const r of reports) {
  if (r.error) console.log(`${r.area}: ${r.error}`);
}
const count = (o) => rows.filter((x) => x.outcome === o).length;
console.log(
  `${rows.length} steps, ${count("ok")} ok, ${count("differs")} differ from AWS, ${count("failed")} failed; ` +
    `${rows.reduce((s, x) => s + x.ms, 0)} ms in calls`,
);
for (const r of reports) {
  if (!r.fetches?.length) continue;
  const counts = new Map();
  for (const f of r.fetches) counts.set(f, (counts.get(f) ?? 0) + 1);
  console.log(
    `fetch() calls seen by the fetch guard: ${[...counts].map(([f, n]) => `${n}x ${f}`).join(", ")}`,
  );
}
const aborted = rows.some((r) => r.op.startsWith("driver aborted"));
process.exit(missing || aborted ? 1 : 0);
