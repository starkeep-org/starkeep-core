/**
 * A cloud run for an app's own browser suite, apart from the journey.
 *
 * The journey proves the platform. An app's own suite proves the app: it
 * walks the app's page in the cloud, the way its local suite walks it on a
 * computer. This module gives that suite a cloud to walk:
 *
 * - `prepare` brings the test stack up to date, installs the cloud data
 *   server and the app, and creates a user for this run alone. It signs that
 *   user in to the app in a real browser, creates a `read` and a `readwrite`
 *   delegation token for the app's MCP route, and writes what the suite needs
 *   to a JSON file ({@link AppCloudRun}).
 * - `finish` takes the run's outcome. A passing run deletes the run's user
 *   and tears the stack down as `STARKEEP_AWS_TEARDOWN` says. A failing run
 *   leaves everything up for debugging, as the journey does.
 *
 * A Playwright suite cannot import this package: Playwright refuses to load
 * twice in one process, and the suite's runner has already loaded the app's
 * own copy. So the suite runs this file as a child process, through core's
 * `tsx`, and reads the JSON file:
 *
 * ```bash
 * pnpm --dir <core>/e2e-aws exec tsx src/app-cloud-run.ts prepare \
 *   --app-dir <app> --out <file> --signed-in-control "Sign out"
 * pnpm --dir <core>/e2e-aws exec tsx src/app-cloud-run.ts finish --out <file> --passed
 * ```
 *
 * The run's user is new each time, so a stack kept up between runs shows the
 * suite an empty library. Every user's records, labels, metadata and app rows
 * are their own (`docs/data-roles-and-permissions.md`, "Both classes belong to
 * one user"), so nothing an earlier run left behind can change a count.
 *
 * Like the journey, the run is inert unless `STARKEEP_AWS_TESTS=1`: `prepare`
 * then writes `{ "enabled": false }` and makes no AWS call.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { regionFromUserPoolId } from "@starkeep/admin-installer";
import { signInTestAdmin } from "./admin-user.js";
import { ensureBootstrapStack, stackConfigFrom } from "./bootstrap-stack.js";
import { chromium, signInWithBrowser, watchPageProblems } from "./browser.js";
import { createDelegationToken } from "./delegation-steps.js";
import { AWS_TESTS_ENABLED, REGION, STACK_PREFIX, TEARDOWN } from "./env.js";
import { runInstallCli, runTeardownScript } from "./installers.js";
import { readConfig, runPaths, writeConfig, type RunPaths } from "./run-state.js";

/** What `prepare` writes for the suite, and `finish` reads back. */
export type AppCloudRun =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly appId: string;
      /** The app's root on the CloudFront distribution, ending in a slash. */
      readonly appUrl: string;
      /** The deployment's execute-api URL, where the consent pages answer. */
      readonly gatewayUrl: string;
      /** Playwright storage state holding the run user's session cookies. */
      readonly storageState: string;
      /** The run's own user. `finish` deletes it after a passing run. */
      readonly user: { readonly email: string; readonly password: string };
      /** Delegation tokens for the app's delegated routes, one per mode. */
      readonly delegationTokens: { readonly read: string; readonly readwrite: string };
      /** The run-state directory, so `finish` tears down the same stack. */
      readonly runStateDir: string;
      readonly userPoolId: string;
    };

export interface PrepareAppCloudRunOptions {
  /** The app's source directory, which holds its `starkeep.manifest.json`. */
  readonly appDir: string;
  /** Where to write the {@link AppCloudRun}. The storage state goes beside it. */
  readonly out: string;
  /**
   * Accessible name of a control the app shows only to a signed-in user, as
   * for {@link signInWithBrowser}.
   */
  readonly signedInControl: string;
  /**
   * The run-state base directory, as for `runPaths`. Defaults to this
   * package, which the journey and the custom-domain suite use too, so a
   * stack one of them kept up serves this run.
   */
  readonly runStateDir?: string;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Bring up the stack, install the app, and sign a fresh user in to it. */
export async function prepareAppCloudRun(options: PrepareAppCloudRunOptions): Promise<AppCloudRun> {
  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  if (!AWS_TESTS_ENABLED) {
    const off: AppCloudRun = { enabled: false };
    writeFileSync(out, JSON.stringify(off));
    console.log("[app-cloud-run] STARKEEP_AWS_TESTS is not 1; the cloud run is skipped.");
    return off;
  }

  const appDir = resolve(options.appDir);
  const appId = manifestId(appDir);
  const runStateDir = resolve(options.runStateDir ?? PACKAGE_ROOT);
  const paths = runPaths(STACK_PREFIX, runStateDir);

  const { outputs, created } = await ensureBootstrapStack({
    stackPrefix: STACK_PREFIX,
    region: REGION,
  });
  console.log(`[app-cloud-run] bootstrap stack ${created ? "created" : "verified"}`);
  writeConfig(paths, stackConfigFrom(readConfig(paths), STACK_PREFIX, outputs, appDir));
  const { session } = await signInTestAdmin(paths, readConfig(paths)!);

  // --ephemeral, as in the journey: the test stack is torn down, so the
  // install skips the production data-protection settings.
  await runInstallCli("cli-install-cloud-data-server", ["--ephemeral"], paths, session);
  await runInstallCli("cli-install-app", [appId], paths, session);
  const config = readConfig(paths)!;
  if (!config.publicBaseUrl || !config.apiGatewayUrl) {
    throw new Error(`${paths.configPath} has no publicBaseUrl or apiGatewayUrl after the install`);
  }

  const user = await createRunUser(config.userPoolId, appId);
  const appUrl = `${config.publicBaseUrl.replace(/\/+$/, "")}/apps/${appId}/`;
  const gatewayUrl = config.apiGatewayUrl.replace(/\/+$/, "");
  const storageState = join(dirname(out), "storage-state.json");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems = watchPageProblems(page);
    await signInWithBrowser({
      page,
      appUrl,
      email: user.email,
      password: user.password,
      signedInControl: options.signedInControl,
      problemReport: problems,
    });
    await context.storageState({ path: storageState });
    // Each consent rides the managed login session the sign-in left.
    const token = (mode: "read" | "readwrite") =>
      createDelegationToken(page, {
        gatewayUrl,
        appId,
        client: `${appId}-suite-${mode}`,
        mode,
        ...user,
      });
    const delegationTokens = { read: await token("read"), readwrite: await token("readwrite") };

    const run: AppCloudRun = {
      enabled: true,
      appId,
      appUrl,
      gatewayUrl,
      storageState,
      user,
      delegationTokens,
      runStateDir,
      userPoolId: config.userPoolId,
    };
    // The file holds a password and session cookies for the disposable test
    // stack only, as `admin.json` does.
    writeFileSync(out, JSON.stringify(run, null, 2), { mode: 0o600 });
    console.log(`[app-cloud-run] ${appId} is ready at ${appUrl} for ${user.email}`);
    return run;
  } finally {
    await browser.close();
  }
}

/**
 * After the suite: on a pass, delete the run's user and tear down as
 * `STARKEEP_AWS_TEARDOWN` says; on a failure, leave everything up.
 */
export async function finishAppCloudRun(options: {
  readonly out: string;
  readonly passed: boolean;
}): Promise<void> {
  const out = resolve(options.out);
  if (!existsSync(out)) {
    console.log(
      "[app-cloud-run] prepare wrote no run file, so it failed or never ran; leaving the stack as it is.",
    );
    return;
  }
  const run = JSON.parse(readFileSync(out, "utf-8")) as AppCloudRun;
  if (!run.enabled) return;
  const paths: RunPaths = runPaths(STACK_PREFIX, run.runStateDir);

  if (!options.passed) {
    console.log(
      `[app-cloud-run] the suite failed; leaving the stack and ${run.user.email} up for debugging ` +
        `(password in ${out}). To tear down by hand, preview the teardown, then run it without --dry-run: ` +
        `STARKEEP_DIR=${paths.dataDir} scripts/teardown-bootstrap.sh --dry-run --prefix ${STACK_PREFIX} --region ${REGION}`,
    );
    return;
  }

  await deleteRunUser(run.userPoolId, run.user.email);
  rmSync(run.storageState, { force: true });
  if (TEARDOWN === "none") {
    console.log("[app-cloud-run] STARKEEP_AWS_TEARDOWN=none; leaving the stack up");
    return;
  }
  runTeardownScript(
    TEARDOWN === "apps" ? "teardown-cloud-data-server.sh" : "teardown-bootstrap.sh",
    paths,
  );
}

function manifestId(appDir: string): string {
  const manifestPath = join(appDir, "starkeep.manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${appDir} holds no starkeep.manifest.json. Pass the app's own source directory.`,
    );
  }
  const id = (JSON.parse(readFileSync(manifestPath, "utf-8")) as { id?: unknown }).id;
  if (typeof id !== "string" || !id) throw new Error(`${manifestPath} declares no id`);
  return id;
}

/**
 * A member of `starkeep-users` for this run alone. Created with the
 * operator's ambient credentials, as the journey creates its members.
 */
async function createRunUser(
  userPoolId: string,
  appId: string,
): Promise<{ email: string; password: string }> {
  const cognito = new CognitoIdentityProviderClient({ region: regionFromUserPoolId(userPoolId) });
  const email = `tier3-${appId}-${randomBytes(4).toString("hex")}@starkeep.test`;
  const password = `Tier3-${randomBytes(12).toString("base64url")}!a1`;
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
    }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: email,
      GroupName: "starkeep-users",
    }),
  );
  return { email, password };
}

async function deleteRunUser(userPoolId: string, email: string): Promise<void> {
  const cognito = new CognitoIdentityProviderClient({ region: regionFromUserPoolId(userPoolId) });
  try {
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
  } catch (err) {
    if ((err as { name?: string }).name !== "UserNotFoundException") throw err;
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      "app-dir": { type: "string" },
      out: { type: "string" },
      "signed-in-control": { type: "string" },
      "run-state-dir": { type: "string" },
      passed: { type: "boolean" },
      failed: { type: "boolean" },
    },
  });
  if (!values.out) throw new Error("--out is required");
  if (command === "prepare") {
    if (!values["app-dir"] || !values["signed-in-control"]) {
      throw new Error("prepare needs --app-dir and --signed-in-control");
    }
    await prepareAppCloudRun({
      appDir: values["app-dir"],
      out: values.out,
      signedInControl: values["signed-in-control"],
      ...(values["run-state-dir"] ? { runStateDir: values["run-state-dir"] } : {}),
    });
    return;
  }
  if (command === "finish") {
    if (values.passed === values.failed) throw new Error("finish needs --passed or --failed");
    await finishAppCloudRun({ out: values.out, passed: values.passed === true });
    return;
  }
  throw new Error(`Unknown command ${command ?? "(none)"}. Use prepare or finish.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
