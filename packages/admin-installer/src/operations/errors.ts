/**
 * The typed failures an operation reports. Each carries a code that the CLI
 * turns into an exit code and admin-web into the remedy it shows, such as a
 * sign-in button for `CREDENTIALS_EXPIRED`.
 */

export type OperationErrorCode =
  /** AWS or DSQL refused the admin's credentials as expired or invalid. Sign in again. */
  | "CREDENTIALS_EXPIRED"
  /** No admin credentials in the environment or the session file. */
  | "NOT_SIGNED_IN"
  /** `config.json` is missing, unreadable, or lacks a field an earlier step writes. */
  | "CONFIG_INCOMPLETE"
  /** The app's folder no longer holds the manifest the person approved. */
  | "MANIFEST_NOT_APPROVED"
  /** The app's folder holds no valid manifest. */
  | "MANIFEST_INVALID"
  /** The app needs a newer platform than the cloud runs, or the reverse. */
  | "PROTOCOL_MISMATCH"
  /** The manifest's bundle command is off the approved list. */
  | "COMMAND_NOT_APPROVED"
  /** The app's dependency install or bundle build failed. */
  | "BUNDLE_FAILED"
  /** The install, uninstall or deletion failed for another reason. */
  | "INSTALL_FAILED"
  /** The input names something that cannot be: an unknown surface, an unknown operation. */
  | "INVALID_INPUT"
  /** The operation deletes or changes something that needs a confirmation it did not get. */
  | "NOT_CONFIRMED"
  /** The deployment's state forbids the operation, such as deleting an installed app's data. */
  | "REFUSED"
  /** The cloud runs patches the checkout lacks, so the deploy would remove them. */
  | "DEPLOY_BACKWARD";

export class OperationError extends Error {
  constructor(
    readonly code: OperationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OperationError";
  }
}

/**
 * The exit code for a failure: 2 for bad input, 3 for input that a run
 * without a terminal cannot give (a sign-in or a confirmation), 1 otherwise.
 */
export function exitCodeFor(code: OperationErrorCode): 1 | 2 | 3 {
  if (code === "INVALID_INPUT") return 2;
  if (code === "NOT_SIGNED_IN" || code === "NOT_CONFIRMED") return 3;
  return 1;
}

/**
 * Text that marks a failure as rejected credentials, whose only remedy is to
 * sign in again and retry.
 *
 * Two surfaces produce it:
 *   1. The AWS SDK and Pulumi, when an STS session token has expired.
 *   2. Aurora DSQL, when it refuses a DbConnect token minted from expired or
 *      invalid IAM credentials. That surfaces as the pg driver's connection
 *      error, not as an SDK error. The installer's first credential-consuming
 *      call is often the DSQL registry connection, so stale credentials show
 *      up there first.
 */
export const CREDENTIAL_FAILURE_SIGNATURES = [
  "ExpiredToken",
  "ExpiredTokenException",
  "The security token included in the request is expired",
  "unable to accept connection, access denied",
];

export function isCredentialFailureText(text: string): boolean {
  return CREDENTIAL_FAILURE_SIGNATURES.some((sig) => text.includes(sig));
}

/**
 * The typed form of whatever an operation threw. `sawCredentialFailure` says
 * whether the run's output already showed a credential failure: Pulumi prints
 * the AWS error and then throws a summary that may not repeat it.
 */
export function toOperationError(
  err: unknown,
  opts: { sawCredentialFailure?: boolean } = {},
): OperationError {
  if (err instanceof OperationError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (
    opts.sawCredentialFailure ||
    isCredentialFailureText(message) ||
    isCredentialFailureText(name)
  ) {
    return new OperationError(
      "CREDENTIALS_EXPIRED",
      "AWS rejected the admin's sign-in as expired or invalid. Sign in again, then retry.",
      { cause: err },
    );
  }
  return new OperationError("INSTALL_FAILED", message, { cause: err });
}
