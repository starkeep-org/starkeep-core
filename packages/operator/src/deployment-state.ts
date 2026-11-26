/**
 * What the cloud runs, compared with this checkout: the cloud data server's
 * deployed record, Drive's registry row, and each cloud app's recorded
 * commit. `starkeep cloud status`, `starkeep status`, `starkeep update
 * --platform` and `starkeep doctor` read it.
 *
 * Every read runs in the admin lane. The cloud data server's record lives
 * under `platform/*`, which only Manager reads, so the read hops from the
 * admin's credentials to Manager, as the deployment settings do.
 */
import {
  platformFingerprint,
  readPlatformDeployRecord,
  type PlatformDeployRecord,
} from "@starkeep/admin-installer/deployed-source";
import { patchDifference } from "@starkeep/admin-installer/operations/deploy-guard";
import { loadDriveManifest } from "@starkeep/admin-installer/drive-manifest";
import type { AdminCredentials } from "./admin-session";
import { sameManifest } from "./apps";
import type { CloudApp } from "./cloud-registry";
import type { StarkeepConfig } from "./config";
import { managerCredentials } from "./manager-credentials";

export type Commit = { commit: string; subject: string };

export type PlatformComparison =
  /** The cloud data server was deployed before the record existed, or never. */
  | { kind: "no-record" }
  /** This checkout is outside git. */
  | { kind: "outside-git"; record: PlatformDeployRecord }
  /** The cloud runs this checkout's platform code. */
  | { kind: "current"; record: PlatformDeployRecord }
  /** The same commits, but uncommitted changes on one side make the code differ. */
  | { kind: "changes"; record: PlatformDeployRecord }
  /** The cloud lacks patches this checkout has: a redeploy adds them. */
  | { kind: "behind"; record: PlatformDeployRecord; cloudLacks: Commit[] }
  /** The cloud runs patches this checkout lacks: a redeploy would remove them. */
  | { kind: "ahead"; record: PlatformDeployRecord; checkoutLacks: Commit[] }
  /** Both. */
  | {
      kind: "diverged";
      record: PlatformDeployRecord;
      cloudLacks: Commit[];
      checkoutLacks: Commit[];
    }
  /** The recorded commit is not in this repository. */
  | { kind: "unknown-commit"; record: PlatformDeployRecord };

/** Compare the cloud data server's record with the platform checkout. */
export function comparePlatform(
  checkout: string,
  record: PlatformDeployRecord | null,
): PlatformComparison {
  if (!record?.commit) return { kind: "no-record" };
  const fingerprint = platformFingerprint(checkout);
  if (fingerprint === null) return { kind: "outside-git", record };
  if (fingerprint === record.fingerprint) return { kind: "current", record };
  const diff = patchDifference(checkout, record.commit);
  if (!diff) return { kind: "unknown-commit", record };
  const { cloudLacks, checkoutLacks } = diff;
  if (cloudLacks.length > 0 && checkoutLacks.length > 0)
    return { kind: "diverged", record, cloudLacks, checkoutLacks };
  if (checkoutLacks.length > 0) return { kind: "ahead", record, checkoutLacks };
  if (cloudLacks.length > 0) return { kind: "behind", record, cloudLacks };
  return { kind: "changes", record };
}

/** Whether a redeploy of the cloud data server from this checkout would change what it runs. */
export function platformNeedsDeploy(c: PlatformComparison): boolean {
  return c.kind !== "current" && c.kind !== "outside-git";
}

const short = (commit: string | null) => (commit ? commit.slice(0, 8) : "?");

function deployedFrom(record: PlatformDeployRecord): string {
  return `${short(record.commit)}${record.branch ? ` (${record.branch})` : ""}${record.dirty ? " with uncommitted changes" : ""}`;
}

/** One line about the cloud data server for `cloud status` and `status`. */
export function platformLine(c: PlatformComparison): string {
  switch (c.kind) {
    case "no-record":
      return "no deployed commit recorded; the next deploy records one";
    case "outside-git":
      return `runs ${deployedFrom(c.record)}; this checkout is outside git`;
    case "current":
      return `current, ${deployedFrom(c.record)}`;
    case "changes":
      return `runs ${deployedFrom(c.record)}, whose code differs from this checkout's uncommitted changes`;
    case "behind":
      return `behind this checkout by ${c.cloudLacks.length} commit(s); runs ${deployedFrom(c.record)}`;
    case "ahead":
      return `runs ${c.checkoutLacks.length} commit(s) this checkout lacks; runs ${deployedFrom(c.record)}`;
    case "diverged":
      return `diverged: runs ${c.checkoutLacks.length} commit(s) this checkout lacks and lacks ${c.cloudLacks.length} of its; runs ${deployedFrom(c.record)}`;
    case "unknown-commit":
      return `runs ${deployedFrom(c.record)}, which this checkout does not have; run git fetch`;
  }
}

/** The cloud data server's deployed record, through Manager. */
export async function readPlatformRecord(
  config: StarkeepConfig,
  admin: AdminCredentials,
): Promise<PlatformDeployRecord | null> {
  if (typeof config.stackPrefix !== "string") return null;
  const manager = await managerCredentials(
    config,
    admin.stsCredentials,
    admin.region,
    "starkeep-cloud-status",
  );
  return readPlatformDeployRecord({
    stackPrefix: config.stackPrefix,
    region: admin.region,
    awsCreds: manager,
  });
}

export const DRIVE_APP_ID = "starkeep-drive";

/**
 * Whether the cloud's Drive runs this checkout's Drive manifest. Null when
 * the cloud has no Drive.
 */
export function driveCurrent(cloudApps: CloudApp[]): boolean | null {
  const drive = cloudApps.find((a) => a.appId === DRIVE_APP_ID);
  if (!drive) return null;
  return drive.manifest !== null && sameManifest(drive.manifest, loadDriveManifest());
}
