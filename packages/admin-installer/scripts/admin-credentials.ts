/**
 * The admin's AWS credentials for an operator-only maintenance script.
 *
 * Every script here starts its role chain from the admin role: it assumes
 * Manager, then the install-DDL role or an app's role. Manager trusts the admin
 * role alone, so an IAM user's own credentials cannot start the chain, however
 * broad. The admin role's credentials come from the identity pool, for an
 * admin's Cognito sign-in — the same sign-in the install CLIs ask for.
 *
 * `AWS_*` environment variables holding admin-role credentials skip the
 * prompt, as `--non-interactive` does for the install CLIs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { cognitoPasswordAuth, getIdentityPoolCredentials } from "../src/cognito-auth";
import { prompt } from "../src/cli-prompt";

export interface BaseCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export async function adminBaseCredentials(): Promise<BaseCredentials> {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  const config = JSON.parse(readFileSync(join(starkeepDir(), "config.json"), "utf8")) as {
    userPoolId?: string;
    userPoolClientId?: string;
    identityPoolId?: string;
  };
  if (!config.userPoolId || !config.userPoolClientId || !config.identityPoolId) {
    throw new Error("~/.starkeep/config.json names no Cognito pool. Finish cloud setup in admin-web first.");
  }
  const pool = {
    userPoolId: config.userPoolId,
    userPoolClientId: config.userPoolClientId,
    identityPoolId: config.identityPoolId,
  };
  console.log("Sign in as an admin of this deployment.");
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);
  const idToken = await cognitoPasswordAuth(pool, email, password, async () => {
    console.log("\nThis account requires a new password (first sign-in).");
    const next = await prompt("New password: ", true);
    if (next !== (await prompt("Confirm new password: ", true))) throw new Error("Passwords do not match.");
    return next;
  });
  return getIdentityPoolCredentials(pool, idToken);
}
