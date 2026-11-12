// Print the per-operation table from the JSON documents s3.mjs and ssm.mjs wrote.
//
// Usage: node report.mjs <s3.json> <ssm.json>
// Exit code: 0 when both drivers ran to the end (whatever the per-operation
// outcomes), 1 when a driver produced no report or aborted part-way.

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
  ["area", width("area", 4)],
  ["op", width("op", 66)],
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
  if (r.error) {
    console.log(`${r.area}: ${r.error}`);
    continue;
  }
  const count = (o) => r.rows.filter((x) => x.outcome === o).length;
  const total = r.rows.reduce((s, x) => s + x.ms, 0);
  console.log(
    `${r.area}: ${r.rows.length} operations, ${count("ok")} ok, ${count("differs")} differ from AWS, ` +
      `${count("failed")} failed; ${total} ms in calls`,
  );
}
const aborted = rows.some((r) => r.op.startsWith("driver aborted"));
process.exit(missing || aborted ? 1 : 0);
