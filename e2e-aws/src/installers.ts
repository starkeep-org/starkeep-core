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

import { spawn, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cognitoPasswordAuthTokens,
  getIdentityPoolCredentials,
  regionFromUserPoolId,
  type IdentityPoolCredentials,
} from "@starkeep/admin-installer";
import type { AdminCredentials, RunPaths, TestStackConfig } from "./run-state.js";
import { HMAC_CACHE_TTL_MS, REGION, STACK_PREFIX } from "./env.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER_DIR = resolve(REPO_ROOT, "packages/admin-installer");

export interface AdminSession {
  idToken: string;
  // The refresh token from the same Cognito sign-in. The install CLIs only
  // need the idToken-derived AWS creds; kept for callers that refresh.
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

/** A CLI run that exited non-zero, with what it printed. */
export class CliFailure extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

/**
 * Run one installer CLI and resolve with everything it printed, which also
 * streams to this process as it arrives. A non-zero exit rejects with a
 * {@link CliFailure} carrying the same output, so a step can assert on the
 * message a refusal printed.
 */
export async function runInstallCli(
  script:
    | "cli-install-cloud-data-server"
    | "cli-install-drive"
    | "cli-install-app"
    | "cli-uninstall-app",
  args: string[],
  paths: RunPaths,
  session: AdminSession,
): Promise<string> {
  const pnpmArgs = ["tsx", `scripts/${script}.ts`, ...args, "--non-interactive"];
  const label = `${script} ${args.join(" ")}`.trim();
  console.log(`\n[e2e-aws] pnpm ${pnpmArgs.join(" ")}`);

  return new Promise<string>((resolveDone, rejectDone) => {
    const chunks: Buffer[] = [];
    const child = spawn("pnpm", pnpmArgs, {
      cwd: INSTALLER_DIR,
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        STARKEEP_DIR: paths.dataDir,
        AWS_ACCESS_KEY_ID: session.awsCredentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: session.awsCredentials.secretAccessKey,
        AWS_SESSION_TOKEN: session.awsCredentials.sessionToken,
        AWS_REGION: session.region,
        // Note: ephemerality is signalled by the explicit `--ephemeral` CLI
        // flag on the cloud-data-server install (see journey.test.ts), NOT an
        // env var — an env var would leak through admin-web's inherited
        // process.env on real installs. Don't reintroduce one here.
        //
        // Baked into the broker Lambda by the cloud-data-server install (the
        // pulumi program forwards it); shortens the HMAC secret cache so signed
        // calls right after an install/uninstall aren't served a stale secret.
        HMAC_CACHE_TTL_MS,
      },
    });
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.once("error", rejectDone);
    child.once("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf-8");
      if (code === 0) resolveDone(output);
      else rejectDone(new CliFailure(`${label} exited with code ${code}`, output));
    });
  });
}

/**
 * Run one of the repository's teardown scripts against the test stack, as the
 * operator would, with this run's state dir as STARKEEP_DIR.
 */
export function runTeardownScript(
  script: "teardown-cloud-data-server.sh" | "teardown-bootstrap.sh",
  paths: RunPaths,
): void {
  const result = spawnSync(
    "bash",
    [join(REPO_ROOT, "scripts", script), "--yes", "--prefix", STACK_PREFIX, "--region", REGION],
    {
      stdio: "inherit",
      env: { ...process.env, STARKEEP_DIR: paths.dataDir, AWS_REGION: REGION },
    },
  );
  if (result.status !== 0) {
    throw new Error(`${script} exited with code ${result.status}`);
  }
}

/**
 * "Sign in to sync", as admin-web's "This machine" section does it: the local
 * data server signs in through the pool's device client with the person's own
 * email and password, binds its library to the token's user and starts sync.
 * Resolves with the daemon's sign-in state.
 */
export async function signInThisMachine(
  ldsUrl: string,
  admin: AdminCredentials,
): Promise<{ state: string; userId?: string | null }> {
  const res = await fetch(`${ldsUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const status = await fetch(`${ldsUrl}/auth/status`);
  return (await status.json()) as { state: string; userId?: string | null };
}
