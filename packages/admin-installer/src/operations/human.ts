/**
 * Run an operation for a person at a terminal: events as plain text, the
 * failure as one `Error:` line, and the exit code its error code names. The
 * `cli-*.ts` scripts use it, so their output reads as it always did.
 */
import { starkeepDir } from "@starkeep/app-client";
import type { OperationOverrides } from "./context";
import type { Emit } from "./events";
import { exitCodeFor } from "./errors";
import { runOperation } from "./run";
import type { OperationInput, OperationName } from "./index";

export const printEvent: Emit = (event) => {
  switch (event.type) {
    case "progress":
      if (event.message.startsWith("Warning:")) console.warn(event.message);
      else console.log(event.message);
      return;
    case "log":
      console.log(event.line);
      return;
    case "prompt-needed":
      console.log(event.detail);
      return;
    case "result":
      return;
  }
};

/**
 * Run `name` and exit the process. The exit is explicit. After a failed
 * inline Pulumi `up` or `destroy`, the Pulumi language host loaded in this
 * process swallows a later top-level rejection and the process exits 0, which
 * the e2e harness would read as success. A `process.on("unhandledRejection")`
 * guard does not help, because the host strips it.
 */
export async function runForTerminal<N extends OperationName>(
  name: N,
  input: OperationInput<N>,
  options: { environmentOnly?: boolean; overrides?: OperationOverrides } = {},
): Promise<never> {
  const outcome = await runOperation(name, input, {
    starkeepDir: starkeepDir(),
    emit: printEvent,
    ...(options.environmentOnly ? { environmentOnly: true } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  });
  if (outcome.ok) process.exit(0);
  console.error(`Error: ${outcome.error.message}`);
  process.exit(exitCodeFor(outcome.error.code));
}
