/**
 * Exit codes, as section 9 of the CLI design names them:
 *
 * - 0: success.
 * - 1: the operation failed.
 * - 2: bad usage, such as an unknown flag or a missing target.
 * - 3: the operation needs input that a run without a terminal cannot give,
 *   such as consent.
 */
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_NEEDS_INPUT = 3;

/** A failure the CLI reports as one message and an exit code, without a stack. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_FAILED,
    readonly code?: string,
    readonly logPath?: string,
    /** Extra fields for the `--json` result, such as what a run finished before it failed. */
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * A failure another process already reported, such as the process that
 * continues `update --platform` after the pull. The CLI exits with its code
 * and prints nothing more, so `--json` output keeps exactly one result.
 */
export class ReportedFailure extends CliError {
  constructor(exitCode: number) {
    super("", exitCode);
    this.name = "ReportedFailure";
  }
}

export function usageError(message: string): CliError {
  return new CliError(message, EXIT_USAGE, "USAGE");
}
