/**
 * The admin's AWS credentials for an operation, and the swap that makes them
 * the only ones this process uses.
 *
 * Every cloud operation starts its role chain from the admin role: it assumes
 * Manager, then the install-DDL role or an app's role. Manager trusts the
 * admin role alone, so an IAM user's own credentials cannot start the chain,
 * however broad. The admin role's credentials come from the identity pool,
 * for an admin's Cognito sign-in.
 *
 * The credentials come from the environment when admin-web, the CLI or the e2e
 * harness passes them, and otherwise from the admin session that `starkeep
 * login --admin` or admin-web's sign-in keeps (`admin-session.ts`). Nothing
 * asks for a password: people sign in on the managed login page.
 */
import { adminCredentials, SignInRequired } from "../admin-session";
import { useOnlyAwsCredentials, type InstallerAwsCredentials } from "../aws-env";
import { OperationError } from "./errors";

/** The admin's credentials, from the environment or the session file. */
export async function adminLaneCredentials(
  options: { environmentOnly?: boolean } = {},
): Promise<InstallerAwsCredentials> {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_SESSION_TOKEN) {
    return {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN,
    };
  }
  if (options.environmentOnly) {
    throw new OperationError(
      "NOT_SIGNED_IN",
      "--non-interactive requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN env vars",
    );
  }
  try {
    return (await adminCredentials()).stsCredentials;
  } catch (err) {
    if (err instanceof SignInRequired) {
      throw new OperationError(
        "NOT_SIGNED_IN",
        `${err.message.replace(/\.$/, "")}. Run \`starkeep login --admin\` first.`,
      );
    }
    throw err;
  }
}

/**
 * An `adminLane` for an operation's context: resolve the credentials once,
 * and make them and `region` this process's whole AWS environment. A region
 * the caller already set in `AWS_REGION` wins, as the scripts always allowed.
 */
export function processAdminLane(
  options: { environmentOnly?: boolean } = {},
): (region: string) => Promise<InstallerAwsCredentials> {
  let resolved: InstallerAwsCredentials | null = null;
  return async (region) => {
    if (!resolved) {
      resolved = await adminLaneCredentials(options);
      useOnlyAwsCredentials(resolved, process.env.AWS_REGION ?? region);
    }
    return resolved;
  };
}
