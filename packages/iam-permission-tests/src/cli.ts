/**
 * Usage:
 *   pnpm simulate --context=<name> <trace-file> [<trace-file> ...]
 *   pnpm simulate --list-contexts
 *
 * Parses each trace file (TF_LOG-style Pulumi traces or, eventually,
 * Node-side SDK trace JSON) and simulates every captured call against
 * the named IAM context.
 *
 * Multiple trace files are unioned by (service:operation) — useful when
 * one install run produces both a Pulumi trace and a Node-SDK trace.
 *
 * Env (with placeholder defaults so a dry run works):
 *   STACK_PREFIX (default: starkeep)
 *   ACCOUNT_ID   (default: 111122223333)
 *   REGION       (default: us-east-1)
 *
 * Exit code: 0 if every call is Allowed, 1 if any verdict is non-Allowed
 * (Denied or Error), 2 on argument errors.
 */

import { readFileSync } from "node:fs";
import { parseTfTrace, type CapturedCall } from "./parse-tf-trace";
import { parseSdkTrace, looksLikeSdkTrace } from "./parse-sdk-trace";
import { simulateCalls } from "./simulate";
import { listContexts } from "./contexts";

function usage(): never {
  console.error("usage: simulate --context=<name> <trace-file> [<trace-file> ...]");
  console.error("       simulate --list-contexts");
  process.exit(2);
}

function parseArgs(argv: string[]): { contextName?: string; traceFiles: string[]; list: boolean } {
  let contextName: string | undefined;
  const traceFiles: string[] = [];
  let list = false;
  for (const arg of argv) {
    if (arg === "--list-contexts") list = true;
    else if (arg.startsWith("--context=")) contextName = arg.slice("--context=".length);
    else if (arg === "--context") {
      console.error("--context requires a value; use --context=<name>");
      usage();
    } else if (arg.startsWith("--")) {
      console.error(`unknown option: ${arg}`);
      usage();
    } else {
      traceFiles.push(arg);
    }
  }
  return { contextName, traceFiles, list };
}

function unionCalls(perFile: CapturedCall[][]): CapturedCall[] {
  const byKey = new Map<string, CapturedCall>();
  for (const calls of perFile) {
    for (const c of calls) {
      const key = `${c.service}:${c.operation}`;
      const existing = byKey.get(key);
      if (existing) existing.count += c.count;
      else byKey.set(key, { ...c });
    }
  }
  return [...byKey.values()];
}

async function main() {
  const { contextName, traceFiles, list } = parseArgs(process.argv.slice(2));

  if (list) {
    for (const c of listContexts()) {
      console.log(`  ${c.name.padEnd(28)} ${c.description}`);
    }
    return;
  }

  if (!contextName) {
    console.error("--context=<name> is required (or --list-contexts)");
    usage();
  }
  if (traceFiles.length === 0) {
    console.error("at least one trace file is required");
    usage();
  }

  const parsed = traceFiles.map((path) => {
    const text = readFileSync(path, "utf8");
    return looksLikeSdkTrace(text) ? parseSdkTrace(text) : parseTfTrace(text);
  });
  const calls = unionCalls(parsed.map((p) => p.calls));
  const totalUnparsed = parsed.reduce((n, p) => n + p.unparsed.length, 0);

  console.log(
    `Context: ${contextName}\n` +
      `Parsed ${calls.length} unique call(s) from ${traceFiles.length} file(s), ${totalUnparsed} unparsed entr(ies).`,
  );

  const stackPrefix = process.env.STACK_PREFIX ?? "starkeep";
  const accountId = process.env.ACCOUNT_ID ?? "111122223333";
  const region = process.env.REGION ?? "us-east-1";

  const outcomes = await simulateCalls(calls, { contextName, stackPrefix, accountId, region });

  const denied = outcomes.filter((o) => o.verdict !== "Allowed");
  const allowed = outcomes.filter((o) => o.verdict === "Allowed");

  console.log(`\n== Allowed (${allowed.length}) ==`);
  for (const o of allowed) console.log(`  ${o.action}  (${o.resourceArn})`);

  if (denied.length > 0) {
    console.log(`\n== NOT ALLOWED (${denied.length}) ==`);
    for (const o of denied) {
      console.log(`  ${o.verdict.padEnd(18)} ${o.action}  (${o.resourceArn})`);
      if (o.errorMessage) console.log(`    error: ${o.errorMessage}`);
    }
  }

  if (totalUnparsed > 0) {
    console.log(`\n== Unparsed (${totalUnparsed}) ==`);
    const sample = parsed.flatMap((p) => p.unparsed).slice(0, 20);
    for (const u of sample) console.log(`  [${u.reason}] ${u.evidence.split("\n")[0]}`);
    if (totalUnparsed > 20) console.log(`  …and ${totalUnparsed - 20} more`);
  }

  process.exit(denied.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
