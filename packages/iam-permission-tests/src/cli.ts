/**
 * Usage:
 *   pnpm simulate --context=<name> [trace-file ...]
 *   pnpm simulate --list-contexts
 *
 * Two evidence sources, both run through @cloud-copilot/iam-simulate:
 *   1. Expected calls — the model declared by the context (the
 *      authoritative "deployments will work" check; independent of any
 *      live install).
 *   2. Captured calls — replayed from trace files written by
 *      sdk-trace.ts and pulumi -v=9 logs. Filtered by principal role so
 *      a single multi-role trace can be evaluated against each role's
 *      context separately. Pass --no-filter to disable.
 *
 * Multiple trace files are unioned per-(principal, action). The CLI
 * auto-detects format per file (Pulumi vs SDK).
 *
 * Env (with placeholder defaults so a dry run works):
 *   STACK_PREFIX (default: starkeep)
 *   ACCOUNT_ID   (default: 111122223333)
 *   REGION       (default: us-east-1)
 *   APP_ID       (required by per-app contexts: install-ddl, install-infra)
 *
 * Exit code: 0 if every expected call AND every (in-context) captured
 * call is Allowed, 1 otherwise, 2 on argument errors.
 */

import { readFileSync } from "node:fs";
import { parseTfTrace, type CapturedCall } from "./parse-tf-trace";
import { parseSdkTrace, looksLikeSdkTrace } from "./parse-sdk-trace";
import {
  simulateCalls,
  simulateExpectedCalls,
  principalMatchesRole,
} from "./simulate";
import { buildContext, listContexts } from "./contexts";

function usage(): never {
  console.error("usage: simulate --context=<name> [trace-file ...]");
  console.error("       simulate --list-contexts");
  process.exit(2);
}

interface ParsedArgs {
  contextName?: string;
  traceFiles: string[];
  list: boolean;
  filterByPrincipal: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let contextName: string | undefined;
  const traceFiles: string[] = [];
  let list = false;
  let filterByPrincipal = true;
  for (const arg of argv) {
    if (arg === "--list-contexts") list = true;
    else if (arg === "--no-filter") filterByPrincipal = false;
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
  return { contextName, traceFiles, list, filterByPrincipal };
}

function unionCalls(perFile: CapturedCall[][]): CapturedCall[] {
  // Key by (principal, service, operation) so calls made by different
  // principals don't collapse into a single row that loses the context.
  const byKey = new Map<string, CapturedCall>();
  for (const calls of perFile) {
    for (const c of calls) {
      const key = `${c.principalArn ?? "unknown"}::${c.service}:${c.operation}`;
      const existing = byKey.get(key);
      if (existing) existing.count += c.count;
      else byKey.set(key, { ...c });
    }
  }
  return [...byKey.values()];
}

async function main() {
  const { contextName, traceFiles, list, filterByPrincipal } = parseArgs(process.argv.slice(2));

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

  const stackPrefix = process.env.STACK_PREFIX ?? "starkeep";
  const accountId = process.env.ACCOUNT_ID ?? "111122223333";
  const region = process.env.REGION ?? "us-east-1";
  const appId = process.env.APP_ID;
  const simOptions = { contextName, stackPrefix, accountId, region, appId };

  const ctx = buildContext(contextName, simOptions);

  console.log(`Context: ${contextName}`);
  console.log(`Principal: ${ctx.principalArn}`);

  // ----- Expected calls (the authoritative model) ------------------------
  const expectedOutcomes = await simulateExpectedCalls(simOptions);
  const expectedAllowed = expectedOutcomes.filter((o) => o.verdict === "Allowed");
  const expectedDenied = expectedOutcomes.filter(
    (o) => o.verdict === "ExplicitlyDenied" || o.verdict === "ImplicitlyDenied",
  );
  const expectedEngineErrors = expectedOutcomes.filter((o) => o.verdict === "Error");

  console.log(`\n== Expected calls (modeled) ==`);
  if (expectedOutcomes.length === 0) {
    console.log("  (none modeled for this context yet)");
  } else {
    console.log(
      `  Allowed: ${expectedAllowed.length} / ${expectedOutcomes.length}` +
        (expectedEngineErrors.length > 0
          ? `  (${expectedEngineErrors.length} simulator-engine error${
              expectedEngineErrors.length === 1 ? "" : "s"
            } — see below)`
          : ""),
    );
    if (expectedDenied.length > 0) {
      console.log(`\n  DENIED by policy/boundary:`);
      for (const o of expectedDenied) {
        console.log(`    ${o.verdict.padEnd(18)} ${o.expected.action}  (${o.expected.resource})`);
        console.log(`      why:   ${o.expected.why}`);
      }
    }
    if (expectedEngineErrors.length > 0) {
      // iam-simulate can't evaluate some action/resource shapes (notably
      // apigatewayv2:* and apigateway:VERB on /v2/* — see README "Misses").
      // Surface these so they aren't silently dropped, but don't fail.
      console.log(`\n  Simulator-engine errors (not policy denials):`);
      for (const o of expectedEngineErrors) {
        console.log(`    ${o.expected.action}  (${o.expected.resource})  — ${o.errorMessage ?? ""}`);
      }
    }
  }

  // ----- Captured calls --------------------------------------------------
  let capturedAllowed = 0;
  let capturedDeniedCount = 0;
  let skippedOutOfContext = 0;

  if (traceFiles.length > 0) {
    const parsed = traceFiles.map((path) => {
      const text = readFileSync(path, "utf8");
      return looksLikeSdkTrace(text) ? parseSdkTrace(text) : parseTfTrace(text);
    });
    const allCalls = unionCalls(parsed.map((p) => p.calls));
    const totalUnparsed = parsed.reduce((n, p) => n + p.unparsed.length, 0);

    let scopedCalls = allCalls;
    if (filterByPrincipal) {
      scopedCalls = allCalls.filter((c) => {
        // tf-trace calls have no principalArn — we can't attribute them, so
        // we include them rather than silently dropping (their verdicts
        // remain informative). SDK-trace calls do have a principal; filter.
        if (c.principalArn === undefined) return true;
        return principalMatchesRole(c.principalArn, ctx.principalRoleName);
      });
      skippedOutOfContext = allCalls.length - scopedCalls.length;
    }

    console.log(
      `\n== Captured calls ==\n` +
        `  ${allCalls.length} unique row(s) across ${traceFiles.length} file(s)` +
        (filterByPrincipal ? `, ${skippedOutOfContext} skipped (other principal)` : "") +
        `, ${totalUnparsed} unparsed`,
    );

    const outcomes = await simulateCalls(scopedCalls, simOptions);
    const denied = outcomes.filter(
      (o) => o.verdict === "ExplicitlyDenied" || o.verdict === "ImplicitlyDenied",
    );
    const engineErrors = outcomes.filter((o) => o.verdict === "Error");
    capturedAllowed = outcomes.filter((o) => o.verdict === "Allowed").length;
    capturedDeniedCount = denied.length;

    console.log(
      `  Allowed: ${capturedAllowed} / ${outcomes.length}` +
        (engineErrors.length > 0
          ? `  (${engineErrors.length} simulator-engine error${
              engineErrors.length === 1 ? "" : "s"
            })`
          : ""),
    );
    if (denied.length > 0) {
      console.log(`\n  DENIED by policy/boundary:`);
      for (const o of denied) {
        console.log(`    ${o.verdict.padEnd(18)} ${o.action}  (${o.resourceArn})`);
        if (o.call.principalArn) console.log(`      principal: ${o.call.principalArn}`);
      }
    }
    if (engineErrors.length > 0) {
      console.log(`\n  Simulator-engine errors (not policy denials):`);
      for (const o of engineErrors) {
        console.log(`    ${o.action}  (${o.resourceArn})  — ${o.errorMessage ?? ""}`);
      }
    }

    if (totalUnparsed > 0) {
      console.log(`\n  Unparsed (${totalUnparsed}):`);
      const sample = parsed.flatMap((p) => p.unparsed).slice(0, 10);
      for (const u of sample) console.log(`    [${u.reason}] ${u.evidence.split("\n")[0]}`);
      if (totalUnparsed > 10) console.log(`    …and ${totalUnparsed - 10} more`);
    }
  }

  const failed = expectedDenied.length > 0 || capturedDeniedCount > 0;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
