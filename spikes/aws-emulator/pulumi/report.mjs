// Prints the driver's JSON (spike.mjs) as plain tables.
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const one = (s) => String(s ?? "").replace(/\s+/g, " ");

function table(title, header, rows) {
  console.log(`\n## ${title}`);
  const all = [header, ...rows.map((row) => row.map(one))];
  const widths = header.map((_, i) => Math.min(80, Math.max(...all.map((row) => row[i].length))));
  const line = (row) =>
    row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join(" | ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const row of all.slice(1)) console.log(line(row));
}

console.log(
  `versions: @pulumi/pulumi ${r.versions?.pulumiSdk}, @pulumi/aws ${r.versions?.pulumiAws}, Pulumi CLI ${r.versions?.pulumiCli}`,
);

table(
  "Inputs and installer steps",
  ["section", "step", "outcome", "ms", "detail"],
  r.rows.map((x) => [x.section, x.step, x.outcome, x.ms, x.detail]),
);

table(
  "Provider configurations (example-app program, one `up` + `destroy` each)",
  ["variant", "up", "created/failed/skipped", "s", "configuration", "first error", "destroy"],
  (r.variants ?? []).map((v) => [
    v.name,
    v.ok ? "ok" : "failed",
    `${v.counts.created}/${v.counts.failed}/${v.counts.skipped}`,
    v.seconds,
    `${v.label}${v.envKeys ? ` [env: ${v.envKeys}]` : ""}`,
    v.error,
    v.destroyed,
  ]),
);

table(
  "Declared resources, variant `full`",
  ["type", "name", "outcome", "detail"],
  (r.resources ?? []).map((x) => [x.type, x.name, x.outcome, x.detail]),
);
if (r.control) {
  table(
    "Declared resources, control manifest (one-line handler)",
    ["type", "name", "outcome", "detail"],
    r.control.outcomes.map((x) => [x.type, x.name, x.outcome, x.detail]),
  );
}

table(
  "Invokes",
  ["what", "request", "status", "body / payload", "log tail"],
  (r.invokes ?? []).map((x) => [x.label, x.request, x.status, x.body, x.log ?? ""]),
);

if (r.bundleImports) {
  console.log("\n## Static node:* imports in the example-app bundle");
  console.log(r.bundleImports);
}
if (r.logs) {
  console.log("\n## CloudWatch Logs, /aws/lambda/<fn> after the invokes");
  for (const [k, v] of Object.entries(r.logs)) console.log(`${k}: ${one(v)}`);
}

console.log("\n## installComputeStack (unchanged)");
console.log(`outcome : ${r.install?.outcome} after ${r.install?.seconds} s`);
console.log(`detail  : ${one(r.install?.detail)}`);
if (r.install?.log) console.log(`log     : ${one(r.install.log)}`);
