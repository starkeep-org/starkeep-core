#!/usr/bin/env tsx
/**
 * Run one installer operation by name and write its events as lines.
 *
 *   pnpm --filter @starkeep/admin-installer run-operation <name> '<input as JSON>'
 *
 * admin-web and the CLI start this as a detached run (`@starkeep/operator/runs`),
 * with the admin's credentials in the environment. Each event is one line on
 * standard output: `@@starkeep-event ` and the event as JSON. Pulumi, an app's
 * bundle command and a dependency install write to the same output, and a
 * reader turns each of their lines into a `log` event. The last event is the
 * `result`. The exit code follows the result's error code: 0 for success, 2
 * for bad input, 3 for a missing sign-in or confirmation, 1 otherwise.
 *
 * The input travels as an argument because a detached run has no standard
 * input. It holds no secrets: credentials come through the environment only.
 * With `-` in its place, the input is read from standard input.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { readFileSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";

// TEMP (iam-permission-tests POC): if IAM_SDK_TRACE_PATH is set, record every
// AWS SDK call this process makes to that file. Must run before any AWS SDK
// client is constructed.
if (process.env.IAM_SDK_TRACE_PATH) {
  const { installSdkTrace } = await import("../../iam-permission-tests/src/sdk-trace");
  installSdkTrace(process.env.IAM_SDK_TRACE_PATH);
}

const { encodeEventLine, exitCodeFor } = await import("../src/operations/index");
const { runOperation } = await import("../src/operations/run");

const [name, rawInput] = process.argv.slice(2);
const emitLine = (event: Parameters<typeof encodeEventLine>[0]) =>
  void process.stdout.write(`${encodeEventLine(event)}\n`);

let input: unknown;
try {
  const text = rawInput === "-" ? readFileSync(0, "utf8") : (rawInput ?? "{}");
  input = JSON.parse(text);
} catch (err) {
  process.stdout.write(
    `${encodeEventLine({
      type: "result",
      ok: false,
      error: {
        message: `The input is not valid JSON: ${(err as Error).message}`,
        code: "INVALID_INPUT",
      },
    })}\n`,
    () => process.exit(2),
  );
  await new Promise(() => {});
}

/** Write the last line, then exit once it is out: a pipe may still hold it. */
function finish(event: Parameters<typeof encodeEventLine>[0], code: number): void {
  process.stdout.write(`${encodeEventLine(event)}\n`, () => process.exit(code));
}

const outcome = await runOperation(name ?? "", input, {
  starkeepDir: starkeepDir(),
  emit: emitLine,
});
if (outcome.ok) {
  finish({ type: "result", ok: true, data: outcome.data }, 0);
} else {
  finish(
    {
      type: "result",
      ok: false,
      error: { message: outcome.error.message, code: outcome.error.code },
    },
    exitCodeFor(outcome.error.code),
  );
}
