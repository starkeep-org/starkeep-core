/**
 * The `cloud` commands: `cloud bootstrap-update` and `cloud status`.
 *
 * `cloud bootstrap-update` is the owner-lane update of the bootstrap stack
 * that `scripts/update-bootstrap.sh` used to do itself; the script now runs
 * this command. Its messages stay the script's, word for word.
 *
 * `cloud status` reads the bootstrap stack in the owner lane, when this
 * terminal has AWS credentials for the account, and everything else in the
 * admin lane.
 */
import {
  applyChangeSet,
  bootstrapStackName,
  callerIdentity,
  deleteChangeSet,
  describeBootstrapStack,
  previewBootstrapUpdate,
  type BootstrapPreview,
  type BootstrapUpdateTarget,
  type ResourceChangeRow,
  type UpdateClients,
} from "@starkeep/operator/bootstrap";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readConfig, regionFromUserPoolId } from "@starkeep/operator/config";
import {
  comparePlatform,
  driveCurrent,
  platformLine,
  readPlatformRecord,
  DRIVE_APP_ID,
  type PlatformComparison,
} from "@starkeep/operator/deployment-state";
import { repoRoot } from "@starkeep/operator/repo-root";
import { compareWithDeployed } from "@starkeep/admin-installer/operations/deploy-guard";
import type { CloudApp } from "@starkeep/operator/cloud-registry";
import { adminCredentialsOrSignIn, cloudInstalled, readCloudAppsAs } from "../cloud";
import { flag, stringFlag, type Command } from "../command";
import { CliError, usageError } from "../errors";
import type { Io } from "../io";

/**
 * The CLI renders the template from `@starkeep/aws-bootstrap`'s build. A
 * source edit without a rebuild would preview an old template, so refuse it.
 */
export function assertTemplateBuildFresh(root = repoRoot()): void {
  const pkg = join(root, "packages", "aws-bootstrap");
  const built = join(pkg, "dist", "index.js");
  if (!existsSync(built)) {
    throw new CliError(
      "@starkeep/aws-bootstrap is not built. Run `pnpm -F @starkeep/aws-bootstrap build`, then run the command again.",
    );
  }
  const newest = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((max, entry) => {
      const path = join(dir, entry.name);
      return Math.max(max, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
    }, 0);
  if (newest(join(pkg, "src")) > statSync(built).mtimeMs) {
    throw new CliError(
      "The built @starkeep/aws-bootstrap is older than its source, so the preview would use an old template.\n" +
        "Run `pnpm -F @starkeep/aws-bootstrap build`, then run the command again.",
    );
  }
}

const configFile = () => `${process.env.STARKEEP_DIR ?? "~/.starkeep"}/config.json`;

/** The stack an update targets: the flags, else `config.json`. */
export function updateTarget(flags: {
  prefix?: string;
  region?: string;
  deploymentName?: string;
}): BootstrapUpdateTarget {
  const config = readConfig() ?? {};
  const stackPrefix =
    flags.prefix ?? (typeof config.stackPrefix === "string" ? config.stackPrefix : undefined);
  const deploymentName =
    flags.deploymentName ??
    (typeof config.deploymentName === "string" ? config.deploymentName : undefined);
  const region =
    flags.region ??
    (typeof config.userPoolId === "string" ? regionFromUserPoolId(config.userPoolId) : undefined);
  if (!stackPrefix || !region || !deploymentName) {
    throw usageError(
      "Error: need a stack prefix, a region and a deployment name.\n" +
        `${configFile()} does not supply all three; pass --prefix, --region and --deployment-name.`,
    );
  }
  return { stackPrefix, region, deploymentName };
}

/**
 * The terminal's AWS account, checked against `config.json` for the
 * configured stack. Throws when the credentials belong to another account.
 */
async function checkedAccount(
  target: BootstrapUpdateTarget,
  clients: UpdateClients,
): Promise<string> {
  const identity = await callerIdentity(target.region, clients).catch((err: Error) => {
    throw new CliError(err.message);
  });
  const config = readConfig() ?? {};
  if (
    typeof config.accountId === "string" &&
    config.stackPrefix === target.stackPrefix &&
    identity.account !== config.accountId
  ) {
    throw new CliError(
      `Error: these credentials belong to account ${identity.account}, but ${configFile()} names ${config.accountId}.\n` +
        `Set AWS_PROFILE to a profile for ${config.accountId}.`,
    );
  }
  return identity.account;
}

function changeTable(rows: ResourceChangeRow[]): string[] {
  const head: ResourceChangeRow = {
    action: "Action",
    resource: "Resource",
    type: "Type",
    replacement: "Replacement",
    scope: "Scope",
  };
  const all = [head, ...rows];
  const keys = ["action", "resource", "type", "replacement", "scope"] as const;
  const widths = keys.map((k) => Math.max(...all.map((r) => r[k].length)) + 2);
  return all.map((r) =>
    keys
      .map((k, i) => r[k].padEnd(widths[i]!))
      .join("")
      .trimEnd(),
  );
}

/**
 * The change set removes or replaces a resource, and the caller did not
 * allow it. A caller without `--allow-replacement`, such as `starkeep update
 * --platform`, names its own remedy with {@link ReplacementRefused.risky}.
 */
export class ReplacementRefused extends CliError {
  constructor(readonly risky: number) {
    super(
      `Error: the change set removes or replaces ${risky} resource(s). Nothing was applied.\n` +
        "Review the table above, then rerun with --allow-replacement if the change is intended.",
    );
    this.name = "ReplacementRefused";
  }
}

export type BootstrapUpdateOutcome = "no-changes" | "previewed" | "declined" | "applied";

export interface BootstrapUpdateOptions {
  target: BootstrapUpdateTarget;
  apply: boolean;
  yes: boolean;
  allowReplacement: boolean;
  verbose: boolean;
}

/** Preview the bootstrap update, and apply it when asked and confirmed. */
export async function runBootstrapUpdate(
  io: Io,
  options: BootstrapUpdateOptions,
  clients: UpdateClients = {},
): Promise<BootstrapUpdateOutcome> {
  const { target } = options;
  const stackName = bootstrapStackName(target.stackPrefix);
  if (!clients.cloudFormation) assertTemplateBuildFresh();
  const account = await checkedAccount(target, clients);
  io.print(`Stack:           ${stackName}`);
  io.print(`Account:         ${account}`);
  io.print(`Region:          ${target.region}`);
  io.print(`Deployment name: ${target.deploymentName}`);
  io.print();
  io.event({ type: "progress", message: "Creating a change set…" });
  let preview: BootstrapPreview;
  try {
    preview = await previewBootstrapUpdate(target, { verbose: options.verbose }, clients);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  if (preview.kind === "no-changes") {
    io.event({
      type: "progress",
      message: "The stack already matches this template. Nothing to do.",
    });
    return "no-changes";
  }
  io.print();
  for (const line of changeTable(preview.changes)) io.print(line);
  for (const line of preview.details ?? []) io.print(line);
  if (io.json) {
    io.event({
      type: "progress",
      message: `The change set holds ${preview.changes.length} change(s).`,
    });
  }
  const discard = () => deleteChangeSet(target, preview.changeSetName, clients);
  if (preview.risky > 0 && !options.allowReplacement) {
    await discard();
    throw new ReplacementRefused(preview.risky);
  }
  if (!options.apply) {
    await discard();
    io.print();
    io.event({
      type: "progress",
      message: "Preview only: deleted the change set. Nothing was applied.",
    });
    io.event({ type: "progress", message: "Rerun with --apply to apply this update." });
    return "previewed";
  }
  if (!(await io.confirm(`Apply this change set to ${stackName}?`, { yes: options.yes }))) {
    await discard();
    io.event({ type: "progress", message: "Deleted the change set. Nothing was applied." });
    return "declined";
  }
  io.event({ type: "progress", message: `Applying ${preview.changeSetName}…` });
  try {
    await applyChangeSet(target, preview.changeSetName, clients);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  io.event({ type: "progress", message: "The stack reached UPDATE_COMPLETE." });
  return "applied";
}

export const cloudBootstrapUpdateCommand: Command = {
  name: "cloud bootstrap-update",
  summary: "Preview or apply an update of the bootstrap stack",
  usage:
    "[--apply] [--yes] [--allow-replacement] [--verbose] [--prefix <p>] [--region <r>] [--deployment-name <n>]",
  lane: "owner",
  flags: {
    apply: { type: "boolean", description: "Apply the previewed change set, after confirmation." },
    yes: { type: "boolean", short: "y", description: "Apply without asking." },
    "allow-replacement": {
      type: "boolean",
      description: "Allow a change set that removes or replaces a resource.",
    },
    prefix: { type: "string", description: "The stack prefix (default: config.json)." },
    region: {
      type: "string",
      description: "The region (default: the region of config.json's userPoolId).",
    },
    "deployment-name": {
      type: "string",
      description: "The deployment name (default: config.json).",
    },
  },
  details:
    "Renders the bootstrap template this checkout holds and previews the update as a\n" +
    "CloudFormation change set. Without --apply, deletes the change set and changes nothing.\n" +
    "Every parameter the stack has keeps its previous value, so the update never replaces the\n" +
    "first admin. A change set that removes or replaces a resource needs --allow-replacement.\n" +
    "--verbose prints each changed property with a diff, and the template diff.\n" +
    "scripts/update-bootstrap.sh runs this command.",
  async run(io, args) {
    const target = updateTarget({
      prefix: stringFlag(args, "prefix"),
      region: stringFlag(args, "region"),
      deploymentName: stringFlag(args, "deployment-name"),
    });
    const outcome = await runBootstrapUpdate(io, {
      target,
      apply: flag(args, "apply"),
      yes: flag(args, "yes"),
      allowReplacement: flag(args, "allow-replacement"),
      verbose: flag(args, "verbose"),
    });
    io.event({ type: "result", ok: true, data: { outcome } });
  },
};

/** The bootstrap stack as the owner lane sees it, or why it cannot. */
export async function bootstrapState(
  clients: UpdateClients = {},
): Promise<
  | { kind: "unknown"; reason: string }
  | { kind: "read"; status: string; changes: number | "no-changes"; risky: number }
> {
  let target: BootstrapUpdateTarget;
  try {
    target = updateTarget({});
  } catch {
    return { kind: "unknown", reason: "config.json names no stack" };
  }
  try {
    if (!clients.cloudFormation) assertTemplateBuildFresh();
    await checkedAccount(target, clients);
  } catch (err) {
    return {
      kind: "unknown",
      reason: `${(err as Error).message.split("\n")[0]} The bootstrap stack needs the account's AWS credentials.`,
    };
  }
  const stack = await describeBootstrapStack(target.stackPrefix, target.region, clients);
  if (!stack)
    return { kind: "unknown", reason: `no stack named ${bootstrapStackName(target.stackPrefix)}` };
  const preview = await previewBootstrapUpdate(target, {}, clients);
  if (preview.kind === "changes") await deleteChangeSet(target, preview.changeSetName, clients);
  return {
    kind: "read",
    status: stack.StackStatus ?? "?",
    changes: preview.kind === "no-changes" ? "no-changes" : preview.changes.length,
    risky: preview.kind === "changes" ? preview.risky : 0,
  };
}

function bootstrapLine(state: Awaited<ReturnType<typeof bootstrapState>>): string {
  if (state.kind === "unknown") return `unknown: ${state.reason}`;
  if (state.changes === "no-changes") return `${state.status}, matches this checkout's template`;
  return (
    `${state.status}, ${state.changes} change(s) from this checkout's template` +
    `${state.risky > 0 ? `, ${state.risky} of them removing or replacing a resource` : ""}; ` +
    "run `starkeep cloud bootstrap-update` to preview"
  );
}

/** One cloud app's commit against its folder, for `cloud status`. */
function appLine(app: CloudApp): string {
  const commit = app.sourceCommit
    ? `${app.sourceCommit.slice(0, 8)}${app.sourceDirty ? " with uncommitted changes" : ""}`
    : "no recorded commit";
  if (!app.folder) return `${commit}; no discovery folder holds it`;
  const behind = app.behind === true || app.codeBehind === true;
  const comparison = compareWithDeployed(
    app.folder,
    app.sourceCommit ? { commit: app.sourceCommit, dirty: app.sourceDirty, branch: null } : null,
    { fetch: false },
  );
  const notes = [
    ...(comparison.kind === "backward"
      ? [`runs ${comparison.missing.length} commit(s) the folder lacks`]
      : []),
    ...(comparison.kind === "unknown-commit"
      ? ["its commit is not in the folder's repository"]
      : []),
    ...(behind ? ["behind the folder"] : []),
  ];
  return `${commit}${notes.length > 0 ? `; ${notes.join(", ")}` : ", current"}`;
}

export interface CloudState {
  platform: PlatformComparison;
  drive: boolean | null;
  apps: CloudApp[];
}

/** The cloud data server, Drive and the cloud apps, compared with this computer. */
export async function readCloudState(
  io: Io,
  options: { signIn: boolean },
): Promise<CloudState | null> {
  const config = readConfig() ?? {};
  const read = await readCloudAppsAs(io, options);
  if (read === null) return null;
  const record = await readPlatformRecord(config, read.admin);
  return {
    platform: comparePlatform(repoRoot(), record),
    drive: driveCurrent(read.apps),
    apps: read.apps,
  };
}

export const cloudStatusCommand: Command = {
  name: "cloud status",
  summary: "Show what the cloud runs, compared with this checkout",
  usage: "",
  lane: "admin",
  flags: {},
  details:
    "Shows the bootstrap stack against this checkout's template (with this terminal's AWS\n" +
    "credentials, when it has them for the account), the commit the cloud data server and each\n" +
    "cloud app were deployed from, and whether a redeploy would add or remove commits.",
  async run(io) {
    if (!cloudInstalled()) {
      throw new CliError("This computer has no cloud. Run `starkeep setup --cloud` first.");
    }
    // Sign in first, so the browser opens before any slow read.
    await adminCredentialsOrSignIn(io);
    const [bootstrap, cloud] = await Promise.all([
      bootstrapState().catch((err: Error) => ({ kind: "unknown", reason: err.message }) as const),
      readCloudState(io, { signIn: false }),
    ]);
    if (!cloud) throw new CliError("Could not read the cloud. Run `starkeep login --admin`.");
    const apps = cloud.apps.filter((a) => a.appId !== DRIVE_APP_ID);
    if (io.json) {
      io.event({
        type: "result",
        ok: true,
        data: {
          bootstrap,
          cloudDataServer: { ...cloud.platform, line: platformLine(cloud.platform) },
          drive: cloud.drive,
          apps: apps.map((a) => ({
            appId: a.appId,
            sourceCommit: a.sourceCommit,
            sourceDirty: a.sourceDirty,
            behind: a.behind,
            codeBehind: a.codeBehind,
            line: appLine(a),
          })),
        },
      });
      return;
    }
    io.print(`BOOTSTRAP          ${bootstrapLine(bootstrap)}`);
    io.print(`CLOUD DATA SERVER  ${platformLine(cloud.platform)}`);
    io.print(
      `DRIVE              ${cloud.drive === null ? "not installed" : cloud.drive ? "current" : "behind this checkout"}`,
    );
    if (apps.length > 0) {
      io.print();
      io.print("APPS");
      const width = Math.max(...apps.map((a) => a.appId.length)) + 2;
      for (const a of apps) io.print(`  ${a.appId.padEnd(width)}${appLine(a)}`);
    }
    const kind = cloud.platform.kind;
    if (kind === "ahead" || kind === "diverged" || kind === "unknown-commit") {
      io.print();
      io.print(
        "The cloud runs commits this checkout lacks. Check out the branch the cloud runs before you redeploy.",
      );
    } else if (
      kind === "behind" ||
      kind === "changes" ||
      kind === "no-record" ||
      cloud.drive === false
    ) {
      io.print();
      io.print("Run `starkeep update --platform` to redeploy the cloud data server and Drive.");
    }
  },
};
