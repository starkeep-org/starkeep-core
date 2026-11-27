/**
 * The admin's AWS credentials for a script in this folder.
 *
 * Every script here starts its role chain from the admin role: it assumes
 * Manager, then the install-DDL role or an app's role. Manager trusts the admin
 * role alone, so an IAM user's own credentials cannot start the chain, however
 * broad. The admin role's credentials come from the identity pool, for an
 * admin's Cognito sign-in.
 *
 * The credentials come from the environment when admin-web or the e2e harness
 * passes them, and otherwise from the admin session that `starkeep login
 * --admin` or admin-web's sign-in keeps (`src/admin-session.ts`). No script
 * asks for a password: people sign in on the managed login page.
 */

import { adminCredentials, SignInRequired } from "../src/admin-session";

export interface BaseCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export async function adminScriptCredentials(
  options: { nonInteractive?: boolean } = {},
): Promise<BaseCredentials> {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_SESSION_TOKEN) {
    return {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN,
    };
  }
  if (options.nonInteractive) {
    throw new Error(
      "--non-interactive requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN env vars",
    );
  }
  try {
    return (await adminCredentials()).stsCredentials;
  } catch (err) {
    if (err instanceof SignInRequired) {
      throw new Error(`${err.message.replace(/\.$/, "")}. Run \`starkeep login --admin\` first.`);
    }
    throw err;
  }
}

/** The same credentials, for the maintenance scripts that name them so. */
export const adminBaseCredentials = (): Promise<BaseCredentials> => adminScriptCredentials();

/** Exit with the reason when no credentials can be had. */
export async function adminScriptCredentialsOrExit(
  nonInteractive: boolean,
): Promise<BaseCredentials> {
  try {
    return await adminScriptCredentials({ nonInteractive });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
