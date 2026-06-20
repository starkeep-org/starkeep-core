/**
 * Drives the real admin-installer CLIs as child processes — the same
 * commands an operator runs. The runner authenticates through Cognito itself
 * (the production auth chain) and hands the resulting temporary AWS
 * credentials to the CLIs via `--non-interactive`, which is exactly what the
 * CLIs' interactive mode does internally after prompting.
 *
 * STARKEEP_DIR is always the run-state dir — the single root for this "machine":
 * the CLIs read and rewrite `$STARKEEP_DIR/config.json` and read the local
 * registry `$STARKEEP_DIR/data.db`, and must never touch ~/.starkeep. The booted
 * LDS shares the same dir (see journey.test.ts), so config.json and data.db
 * co-locate exactly as they do under ~/.starkeep in production.
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cognitoPasswordAuthTokens,
  getIdentityPoolCredentials,
  regionFromUserPoolId,
  type IdentityPoolCredentials,
} from "@starkeep/admin-installer";
import type { AdminCredentials, RunPaths, TestStackConfig } from "./run-state.js";
import { HMAC_CACHE_TTL_MS } from "./env.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER_DIR = resolve(REPO_ROOT, "packages/admin-installer");

export interface AdminSession {
  idToken: string;
  // The refresh token from the same Cognito sign-in. The install CLIs only
  // need the idToken-derived AWS creds, but the LDS `/auth/tokens` handoff
  // (journey step 4) needs the refresh token to seed the daemon's credential
  // refresh timer — see the journey's sign-in handoff step.
  refreshToken: string;
  awsCredentials: IdentityPoolCredentials;
  region: string;
}

/** Cognito USER_PASSWORD_AUTH → Identity Pool: the §11 admin-auth leg. */
export async function signInAdmin(
  config: TestStackConfig,
  admin: AdminCredentials,
): Promise<AdminSession> {
  const { idToken, refreshToken } = await cognitoPasswordAuthTokens(
    config,
    admin.email,
    admin.password,
  );
  const awsCredentials = await getIdentityPoolCredentials(config, idToken);
  return { idToken, refreshToken, awsCredentials, region: regionFromUserPoolId(config.userPoolId) };
}

export async function runInstallCli(
  script:
    | "cli-install-cloud-data-server"
    | "cli-install-drive"
    | "cli-install-app"
    | "cli-uninstall-app",
  args: string[],
  paths: RunPaths,
  session: AdminSession,
): Promise<void> {
  const pnpmArgs = ["tsx", `scripts/${script}.ts`, ...args, "--non-interactive"];
  const label = `${script} ${args.join(" ")}`.trim();
  console.log(`\n[e2e-aws] pnpm ${pnpmArgs.join(" ")}`);

  await new Promise<void>((resolveDone, rejectDone) => {
    const child = spawn("pnpm", pnpmArgs, {
      cwd: INSTALLER_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        STARKEEP_DIR: paths.dataDir,
        AWS_ACCESS_KEY_ID: session.awsCredentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: session.awsCredentials.secretAccessKey,
        AWS_SESSION_TOKEN: session.awsCredentials.sessionToken,
        AWS_REGION: session.region,
        // Baked into the broker Lambda by the cloud-data-server install (the
        // pulumi program forwards it); shortens the HMAC secret cache so signed
        // calls right after an install/uninstall aren't served a stale secret.
        HMAC_CACHE_TTL_MS,
      },
    });
    child.once("error", rejectDone);
    child.once("exit", (code) => {
      if (code === 0) resolveDone();
      else rejectDone(new Error(`${label} exited with code ${code}`));
    });
  });
}
