/**
 * What a cloud install deployed: the commit of the folder it built from, and
 * for the cloud data server, a fingerprint of the platform's code.
 *
 * Every cloud app install records its repository's commit in
 * `shared.app_registry` (`source_commit`, `source_dirty`). The cloud data
 * server has no registry row, so its install writes the record to the SSM
 * parameter `/<prefix>/platform/deployed/cloud-data-server`, through Manager,
 * which alone may write `platform/*`.
 *
 * Readers use the records two ways. `starkeep cloud status` and `starkeep
 * update` compare them with the checkout to say what is behind. The deploy
 * guard (`operations/deploy-guard.ts`) refuses a deploy whose checkout lacks
 * patches the cloud already runs.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { platformParameterPrefix, type AwsCredentials } from "./app-creds";
import { treeFingerprint } from "./app-discovery";

/** The commit a deploy built from. */
export interface SourceCommit {
  /** The repository's `HEAD`, or null for a folder outside git. */
  commit: string | null;
  /** Whether tracked files under the folder had uncommitted changes. */
  dirty: boolean;
  /** The checked-out branch, or null when detached or outside git. */
  branch: string | null;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The commit `dir` sits at, and whether its tracked files changed since. */
export function sourceCommitOf(dir: string): SourceCommit {
  const commit = git(dir, ["rev-parse", "HEAD"]);
  if (!commit) return { commit: null, dirty: false, branch: null };
  const status = git(dir, ["status", "--porcelain", "--untracked-files=no", "--", "."]);
  const branch = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return { commit, dirty: (status ?? "").length > 0, branch: branch || null };
}

/**
 * Packages the cloud never runs. A change under them does not call for a
 * cloud data server redeploy. The list excludes rather than includes, so a
 * package that a later change makes part of the cloud counts by default: an
 * extra redeploy costs minutes, a missed one leaves the cloud stale.
 */
export const PLATFORM_PACKAGES_NOT_DEPLOYED = [
  "cli",
  "operator",
  "testkit",
  "iam-permission-tests",
];

/** The paths, relative to the checkout, whose code the cloud data server deploys. */
export function platformSourcePaths(checkout: string): string[] {
  const packages = readdirSync(join(checkout, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !PLATFORM_PACKAGES_NOT_DEPLOYED.includes(d.name))
    .map((d) => `packages/${d.name}`)
    .sort();
  return ["pnpm-lock.yaml", ...packages];
}

/**
 * A fingerprint of the platform code in `checkout`, uncommitted changes
 * included. Two checkouts with the same fingerprint deploy the same cloud
 * data server. Null outside git.
 */
export function platformFingerprint(checkout: string): string | null {
  const top = git(checkout, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  try {
    return treeFingerprint(realpathSync(top), platformSourcePaths(realpathSync(top)));
  } catch {
    return null;
  }
}

/** The cloud data server's deployed record, as its parameter holds it. */
export interface PlatformDeployRecord extends SourceCommit {
  /** {@link platformFingerprint} of the checkout the install ran from. */
  fingerprint: string | null;
  deployedAt: string;
}

export function platformDeployRecordName(stackPrefix: string): string {
  return `${platformParameterPrefix(stackPrefix)}/deployed/cloud-data-server`;
}

export interface PlatformRecordOptions {
  stackPrefix: string;
  region: string;
  /** Manager's credentials. Only Manager may read and write `platform/*`. */
  awsCreds: AwsCredentials;
  /** For tests. */
  ssm?: Pick<SSMClient, "send">;
}

function ssmClient(opts: PlatformRecordOptions): Pick<SSMClient, "send"> {
  return (
    opts.ssm ??
    new SSMClient({
      region: opts.region,
      credentials: {
        accessKeyId: opts.awsCreds.accessKeyId,
        secretAccessKey: opts.awsCreds.secretAccessKey,
        sessionToken: opts.awsCreds.sessionToken,
      },
    })
  );
}

/** The record the last cloud data server install wrote, or null when none did. */
export async function readPlatformDeployRecord(
  opts: PlatformRecordOptions,
): Promise<PlatformDeployRecord | null> {
  try {
    const res = await ssmClient(opts).send(
      new GetParameterCommand({ Name: platformDeployRecordName(opts.stackPrefix) }),
    );
    const raw = res.Parameter?.Value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlatformDeployRecord>;
    return {
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      dirty: parsed.dirty === true,
      branch: typeof parsed.branch === "string" ? parsed.branch : null,
      fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : null,
      deployedAt: typeof parsed.deployedAt === "string" ? parsed.deployedAt : "",
    };
  } catch (err) {
    if (err instanceof ParameterNotFound || (err as { name?: string }).name === "ParameterNotFound")
      return null;
    throw err;
  }
}

export async function writePlatformDeployRecord(
  opts: PlatformRecordOptions & { record: PlatformDeployRecord },
): Promise<void> {
  await ssmClient(opts).send(
    new PutParameterCommand({
      Name: platformDeployRecordName(opts.stackPrefix),
      Type: "String",
      Value: JSON.stringify(opts.record),
      Overwrite: true,
      Description:
        "The commit and code fingerprint the cloud data server was last deployed from. Written by the install through Manager.",
    }),
  );
}
