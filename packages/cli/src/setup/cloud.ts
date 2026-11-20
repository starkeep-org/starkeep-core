/**
 * `starkeep setup --cloud`: deploy a new cloud in one command, and
 * `starkeep setup --join`: join a cloud that exists.
 *
 * Setup runs in phases. Each phase checks first whether its work is done, so
 * running the command again after a failure or an interruption resumes where
 * it stopped:
 *
 * 1. Check the terminal's AWS credentials (owner lane).
 * 2. Create the bootstrap stack, unless one with the prefix exists (owner lane).
 * 3. Record the stack's outputs in `config.json`.
 * 4. Sign the first admin in on the managed login page.
 * 5. Install the cloud data server (admin lane, detached run).
 * 6. Install Drive (admin lane, detached run).
 * 7. Restart the data server so it reads the new cloud, and start Drive.
 * 8. Sign this computer in to sync. The managed login page keeps its session
 *    from phase 4, so this sign-in usually needs no second password.
 * 9. Install the cloud surfaces of the apps `--apps` names.
 *
 * Only phases 1 and 2 use the terminal's AWS credentials. Everything after
 * them runs as the Starkeep admin.
 */
import {
  isDeploymentName,
  MAX_STACK_PREFIX_LENGTH,
  normalizeDeploymentName,
} from "@starkeep/aws-bootstrap";
import {
  bootstrapOutputs,
  bootstrapStackName,
  callerIdentity,
  createBootstrapStack,
  describeBootstrapStack,
  isUsableStack,
  type OwnerClients,
} from "@starkeep/operator/bootstrap";
import { patchConfig, readConfigSeeded, regionFromUserPoolId } from "@starkeep/operator/config";
import { PLATFORM_RUN_OWNERS } from "@starkeep/operator/operation-runs";
import { localDataServerUrlFromEnv } from "@starkeep/operator/urls";
import { CliError, usageError } from "../errors";
import type { Io } from "../io";

export interface CloudSetupOptions {
  region?: string;
  prefix?: string;
  name?: string;
  adminEmail?: string;
  domain?: string;
  apps: string[];
  yes: boolean;
  noBrowser: boolean;
}

/** What the phases call, so a test can stand in for AWS, the browser and the services. */
export interface CloudSetupDeps {
  owner: OwnerClients;
  /** Whether an admin session is open, so phase 4 can be skipped. */
  adminSignedIn(): boolean;
  loginAdmin(io: Io, noBrowser: boolean): Promise<unknown>;
  loginSync(io: Io, noBrowser: boolean): Promise<unknown>;
  runCloud(io: Io, run: import("../cloud").CloudRun): Promise<unknown>;
  /** The apps the cloud registry lists, or null when it cannot be read. */
  cloudAppIds(io: Io): Promise<string[] | null>;
  /** This computer's sync state, as the data server reports it, or null when it is down. */
  syncState(): Promise<string | null>;
  /** Restart the data server, or start it, and start Drive. */
  startLocalServices(io: Io, restartDataServer: boolean): Promise<void>;
  installApps(io: Io, apps: string[], yes: boolean): Promise<void>;
}

export const DRIVE_APP_ID = "starkeep-drive";

/** The phases that ran, in order, for the result and for tests. */
export type Phase =
  | "bootstrap-created"
  | "bootstrap-found"
  | "outputs-recorded"
  | "admin-signed-in"
  | "cloud-data-server"
  | "drive"
  | "local-services"
  | "sync-signed-in"
  | "apps";

const PREFIX_PATTERN = /^[a-z][a-z0-9-]*$/;

function checkPrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix) || prefix.length > MAX_STACK_PREFIX_LENGTH) {
    throw usageError(
      `--prefix must start with a lowercase letter, hold only lowercase letters, digits and hyphens, and be at most ${MAX_STACK_PREFIX_LENGTH} long.`,
    );
  }
}

/** Phases 1 to 3: the bootstrap stack and its outputs. */
async function ensureBootstrap(
  io: Io,
  options: CloudSetupOptions,
  deps: CloudSetupDeps,
  done: Phase[],
): Promise<void> {
  const config = readConfigSeeded();
  if (typeof config.userPoolId === "string" && typeof config.deviceUserPoolClientId === "string") {
    io.event({
      type: "progress",
      message: `The bootstrap stack's outputs are recorded (${String(config.stackPrefix)}, ${regionFromUserPoolId(config.userPoolId)}).`,
    });
    return;
  }
  const region = options.region;
  if (!region)
    throw usageError("Name the AWS region for the new cloud: --region, such as us-east-2.");
  const prefix =
    options.prefix ?? (typeof config.stackPrefix === "string" ? config.stackPrefix : "starkeep");
  checkPrefix(prefix);

  const identity = await callerIdentity(region, deps.owner).catch((err: Error) => {
    throw new CliError(err.message);
  });
  io.event({
    type: "progress",
    message: [
      "The bootstrap stack uses this terminal's AWS credentials:",
      `  Account: ${identity.account}`,
      `  Caller : ${identity.arn}`,
      `  Region : ${region}`,
    ].join("\n"),
  });
  if (typeof config.accountId === "string" && config.accountId !== identity.account) {
    throw new CliError(
      `config.json names account ${config.accountId}, but these credentials belong to ${identity.account}. Sign in to the right account, then run setup again.`,
    );
  }
  if (identity.isRoot) {
    io.warn(
      "Warning: these are the account's root user credentials. An IAM user or SSO role is safer.",
    );
  }

  let stack = await describeBootstrapStack(prefix, region, deps.owner);
  let deploymentName =
    typeof config.deploymentName === "string" ? config.deploymentName : undefined;
  if (stack) {
    if (!isUsableStack(stack)) {
      throw new CliError(
        `The stack ${bootstrapStackName(prefix)} exists but is ${stack.StackStatus}. Preview its teardown with ` +
          `scripts/teardown-bootstrap.sh --dry-run --prefix ${prefix} --region ${region}, tear it down, and run setup again.`,
      );
    }
    io.event({
      type: "progress",
      message: `The stack ${bootstrapStackName(prefix)} exists; setup uses its outputs. If it is out of date, run scripts/update-bootstrap.sh.`,
    });
    done.push("bootstrap-found");
  } else {
    const name = options.name ? normalizeDeploymentName(options.name) : deploymentName;
    if (!name) throw usageError('Name the deployment: --name "Home". The sign-in page shows it.');
    if (!isDeploymentName(name)) {
      throw usageError(
        "--name takes 1 to 32 letters, digits, spaces, hyphens and underscores, with single spaces between words.",
      );
    }
    if (!options.adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.adminEmail)) {
      throw usageError(
        "Name the first admin's email: --admin-email. Cognito sends it a temporary password.",
      );
    }
    deploymentName = name;
    const go = await io.confirm(
      `Create the stack ${bootstrapStackName(prefix)} in account ${identity.account}, ${region}?`,
      { yes: options.yes },
    );
    if (!go) throw new CliError("Setup stopped before creating the bootstrap stack.");
    io.event({
      type: "progress",
      message: `Creating ${bootstrapStackName(prefix)}. This takes a few minutes. Cognito then emails ${options.adminEmail} a temporary password.`,
    });
    try {
      stack = await createBootstrapStack(
        { stackPrefix: prefix, region, deploymentName: name, adminEmail: options.adminEmail },
        deps.owner,
      );
    } catch (err) {
      throw new CliError(
        `Creating the bootstrap stack failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    done.push("bootstrap-created");
  }
  let outputs;
  try {
    outputs = bootstrapOutputs(stack);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  patchConfig({
    stackPrefix: prefix,
    stage: prefix,
    accountId: identity.account,
    ...(deploymentName ? { deploymentName } : {}),
    ...outputs,
  });
  io.event({ type: "progress", message: "Recorded the stack's outputs in config.json." });
  done.push("outputs-recorded");
}

export async function setupCloud(
  io: Io,
  options: CloudSetupOptions,
  deps: CloudSetupDeps,
): Promise<{ phases: Phase[] }> {
  const done: Phase[] = [];
  await ensureBootstrap(io, options, deps, done);
  const config = readConfigSeeded();
  if (typeof config.deploymentName !== "string") {
    if (!options.name)
      throw usageError('Name the deployment: --name "Home". The sign-in page shows it.');
    const name = normalizeDeploymentName(options.name);
    if (!isDeploymentName(name)) throw usageError("--name is not a valid deployment name.");
    patchConfig({ deploymentName: name });
  }

  // Phase 4: the admin's first sign-in sets a permanent password on the page.
  if (!deps.adminSignedIn()) {
    io.event({
      type: "progress",
      message:
        "Sign in as the admin. The first time, use the temporary password Cognito emailed; the page then asks for a new one.",
    });
    await deps.loginAdmin(io, options.noBrowser);
    done.push("admin-signed-in");
  }

  if (options.domain !== undefined) patchConfig({ customDomain: options.domain || null });

  // Phase 5. A recorded install is done, unless the domain changed.
  const now = readConfigSeeded();
  const cdsDone =
    typeof now.apiGatewayUrl === "string" &&
    typeof now.auroraEndpoint === "string" &&
    typeof now.cloudAppsUserPoolClientId === "string" &&
    options.domain === undefined;
  if (cdsDone) {
    io.event({
      type: "progress",
      message: `The cloud data server is installed (${String(now.apiGatewayUrl)}).`,
    });
  } else {
    io.event({
      type: "progress",
      message: "Installing the cloud data server. This takes 10 to 20 minutes.",
    });
    await deps.runCloud(io, {
      name: "install-cloud-data-server",
      input: {},
      owner: PLATFORM_RUN_OWNERS.installCloudDataServer,
      lock: "platform",
      command: "starkeep setup --cloud",
    });
    done.push("cloud-data-server");
  }

  // Phase 6. The cloud registry lists Drive once it is installed.
  const installed = await deps.cloudAppIds(io);
  if (installed?.includes(DRIVE_APP_ID)) {
    io.event({ type: "progress", message: "Drive is installed." });
  } else {
    io.event({ type: "progress", message: "Installing Drive…" });
    await deps.runCloud(io, {
      name: "install-drive",
      input: {},
      owner: PLATFORM_RUN_OWNERS.installDrive,
      lock: "platform",
      command: "starkeep setup --cloud",
    });
    done.push("drive");
  }

  // Phase 7. The data server reads the cloud's address only at start.
  await deps.startLocalServices(io, done.includes("cloud-data-server") || done.includes("drive"));
  done.push("local-services");

  // Phase 8.
  const sync = await deps.syncState();
  if (sync === "signed-in" || sync === "connecting") {
    io.event({ type: "progress", message: "This computer already syncs." });
  } else {
    io.event({
      type: "progress",
      message: "Sign this computer in to sync, with the same account.",
    });
    await deps.loginSync(io, options.noBrowser);
    done.push("sync-signed-in");
  }

  // Phase 9.
  if (options.apps.length > 0) {
    await deps.installApps(io, options.apps, options.yes);
    done.push("apps");
  }
  return { phases: done };
}

/** Wait for the data server to answer again, after a restart it started itself. */
export async function waitForDataServer(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Give the old process a moment to exit, so the first answer is the new one.
  await new Promise((r) => setTimeout(r, 500));
  while (Date.now() < deadline) {
    const res = await fetch(`${localDataServerUrlFromEnv()}/health`).catch(() => null);
    if (res?.ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * `setup --join <address>`: record the cloud this computer joins, which
 * restarts the data server, then sign in to sync. The data server must run.
 */
export async function setupJoin(
  io: Io,
  address: string,
  deps: Pick<CloudSetupDeps, "loginSync" | "startLocalServices">,
  options: { noBrowser: boolean },
): Promise<{ cloudUrl: string }> {
  const url = address.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/\S*)?$/.test(url)) {
    throw usageError(
      "--join takes the cloud's https address, such as https://d123.cloudfront.net.",
    );
  }
  await deps.startLocalServices(io, false);
  let res: Response;
  try {
    res = await fetch(`${localDataServerUrlFromEnv()}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiGatewayUrl: url }),
    });
  } catch {
    throw new CliError(
      "The local data server is not answering. Run `starkeep start data-server` first.",
    );
  }
  if (!res.ok) throw new CliError(`The data server refused the cloud address (${res.status}).`);
  io.event({
    type: "progress",
    message: `This computer joins ${url}. Restarting the data server…`,
  });
  if (!(await waitForDataServer())) {
    throw new CliError(
      "The data server did not come back after the restart. Run `starkeep logs data-server`.",
    );
  }
  await deps.loginSync(io, options.noBrowser);
  return { cloudUrl: url };
}
