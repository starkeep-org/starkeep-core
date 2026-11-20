/**
 * Run one operation by name, in this process.
 *
 * Two callers use it. `scripts/run-operation.ts` is the entry point that
 * admin-web and the CLI start as a detached child: it writes every event as
 * one prefixed line, so the run's log file carries them. The `cli-*.ts`
 * scripts call it with a renderer that prints the events as text, so the e2e
 * harness and the IAM trace capture see what they always saw.
 *
 * Whatever the operation throws becomes an `OperationError`. While it runs,
 * this watches the process's own output for the text of a credential failure,
 * because Pulumi prints the AWS error and then throws a summary that may not
 * repeat it. A failure after such a line is `CREDENTIALS_EXPIRED`.
 */
import type { OperationContext, OperationOverrides } from "./context";
import { processAdminLane } from "./admin-lane";
import type { Emit } from "./events";
import { isCredentialFailureText, OperationError, toOperationError } from "./errors";
import { isOperationName, OPERATIONS } from "./index";

export type OperationOutcome = { ok: true; data: unknown } | { ok: false; error: OperationError };

export interface RunOptions {
  starkeepDir: string;
  emit: Emit;
  /** Resolve the admin's credentials from the environment only, never the session file. */
  environmentOnly?: boolean;
  /** For tests: the admin lane, instead of the environment and session file. */
  adminLane?: OperationContext["adminLane"];
  overrides?: OperationOverrides;
}

type Write = typeof process.stdout.write;

/** Call `onText` with everything this process writes, while `body` runs. */
async function watchingOutput<T>(
  onText: (text: string) => void,
  body: () => Promise<T>,
): Promise<T> {
  const streams = [process.stdout, process.stderr];
  const originals = streams.map((s) => s.write);
  streams.forEach((stream, i) => {
    const original = originals[i]!;
    stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
      try {
        onText(
          typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"),
        );
      } catch {
        // Watching must never break the write.
      }
      return (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
    } as Write;
  });
  try {
    return await body();
  } finally {
    streams.forEach((stream, i) => {
      stream.write = originals[i]!;
    });
  }
}

export async function runOperation(
  name: string,
  input: unknown,
  options: RunOptions,
): Promise<OperationOutcome> {
  if (!isOperationName(name)) {
    return {
      ok: false,
      error: new OperationError(
        "INVALID_INPUT",
        `Unknown operation "${name}". Known: ${Object.keys(OPERATIONS).join(", ")}.`,
      ),
    };
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: new OperationError("INVALID_INPUT", "An operation's input is a JSON object."),
    };
  }
  const ctx: OperationContext = {
    starkeepDir: options.starkeepDir,
    adminLane:
      options.adminLane ?? processAdminLane({ environmentOnly: options.environmentOnly === true }),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  };
  let sawCredentialFailure = false;
  const emit: Emit = (event) => {
    if (event.type === "log" && isCredentialFailureText(event.line)) sawCredentialFailure = true;
    options.emit(event);
  };
  try {
    const op = OPERATIONS[name] as (c: OperationContext, i: unknown, e: Emit) => Promise<unknown>;
    const data = await watchingOutput(
      (text) => {
        if (isCredentialFailureText(text)) sawCredentialFailure = true;
      },
      () => op(ctx, input, emit),
    );
    return { ok: true, data };
  } catch (err) {
    const error = toOperationError(err, { sawCredentialFailure });
    // The whole story, stack included, goes to the log; the result carries
    // the one-line reason.
    const cause = error.cause ?? err;
    if (!(err instanceof OperationError) && cause instanceof Error && cause.stack) {
      options.emit({ type: "log", line: cause.stack });
    }
    return { ok: false, error };
  }
}
