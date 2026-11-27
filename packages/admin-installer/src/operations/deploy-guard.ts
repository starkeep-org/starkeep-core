/**
 * The guard against a deploy that goes backward.
 *
 * On 2026-11-16 a deploy from `main` removed infrastructure that the live
 * cloud's feature branch had created. With the commit each deploy recorded
 * (`deployed-source.ts`), a deploy can first ask whether the cloud runs
 * patches the checkout lacks.
 *
 * Both Starkeep repositories rebase-merge, so a commit gets a new SHA when it
 * lands, and SHA ancestry would call a merged feature branch "ahead". The
 * guard compares patches, as `git cherry` does: a `+` line names a commit
 * whose change no commit on the checkout's side carries.
 */
import { execFileSync } from "node:child_process";
import type { SourceCommit } from "../deployed-source";
import { OperationError } from "./errors";

export type DeployComparison =
  /** Nothing recorded, or the record holds no commit: nothing to compare. */
  | { kind: "no-record" }
  /** The checkout is outside git, so nothing can be compared. */
  | { kind: "outside-git" }
  /** The checkout holds every patch the cloud runs. */
  | { kind: "ok"; recorded: string; dirty: boolean }
  /** The cloud runs patches the checkout lacks. */
  | {
      kind: "backward";
      recorded: string;
      dirty: boolean;
      missing: { commit: string; subject: string }[];
    }
  /** The recorded commit is in no repository this computer can fetch. */
  | { kind: "unknown-commit"; recorded: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasCommit(dir: string, commit: string): boolean {
  try {
    git(dir, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare a recorded deploy with the checkout that holds `dir`. A recorded
 * commit missing from the repository triggers one fetch of every remote,
 * since it usually sits on a branch this computer has not fetched yet.
 */
export function compareWithDeployed(
  dir: string,
  recorded: SourceCommit | null,
  options: { fetch?: boolean } = {},
): DeployComparison {
  if (!recorded?.commit) return { kind: "no-record" };
  try {
    git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return { kind: "outside-git" };
  }
  const commit = recorded.commit;
  if (!hasCommit(dir, commit)) {
    if (options.fetch !== false) {
      try {
        git(dir, ["fetch", "--all", "--quiet"]);
      } catch {
        // An unreachable remote leaves the commit missing, which the next
        // check reports.
      }
    }
    if (!hasCommit(dir, commit)) return { kind: "unknown-commit", recorded: commit };
  }
  const missing = patchesMissing(dir, "HEAD", commit);
  if (missing.length === 0) return { kind: "ok", recorded: commit, dirty: recorded.dirty };
  return { kind: "backward", recorded: commit, dirty: recorded.dirty, missing };
}

/** The commits on `head`'s side whose patch no commit on `upstream`'s side carries. */
function patchesMissing(
  dir: string,
  upstream: string,
  head: string,
): { commit: string; subject: string }[] {
  return git(dir, ["cherry", upstream, head])
    .split("\n")
    .filter((l) => l.startsWith("+ "))
    .map((l) => {
      const sha = l.slice(2).trim();
      return { commit: sha, subject: git(dir, ["log", "-1", "--format=%s", sha]) };
    });
}

/**
 * The patches between a recorded deploy and the checkout, both ways:
 * `checkoutLacks` are the cloud's patches the checkout lacks (a deploy would
 * remove them), and `cloudLacks` are the checkout's patches the cloud lacks
 * (a deploy would add them). Null when the commit is not in the repository.
 */
export function patchDifference(
  dir: string,
  commit: string,
): {
  checkoutLacks: { commit: string; subject: string }[];
  cloudLacks: { commit: string; subject: string }[];
} | null {
  if (!hasCommit(dir, commit)) return null;
  return {
    checkoutLacks: patchesMissing(dir, "HEAD", commit),
    cloudLacks: patchesMissing(dir, commit, "HEAD"),
  };
}

/** Whether `commit` changes a file under `dir`, the folder an app deploys from. */
function changesFolder(dir: string, commit: string): boolean {
  try {
    return (
      git(dir, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        commit,
        "--",
        ".",
      ]) !== ""
    );
  } catch {
    return true;
  }
}

/**
 * Refuse a deploy that would remove patches the cloud runs. `what` names the
 * deployed thing, such as "The cloud data server" or "photos in the cloud".
 * `forceHint` names the flag that deploys anyway.
 *
 * The check counts every commit of the repository, because nothing maps an
 * app to the packages its build uses. With `folder`, the refusal marks the
 * commits that change the app's own folder, so the person can judge the
 * forced deploy: a repository can hold several apps and the platform.
 */
export function assertNotBackward(
  comparison: DeployComparison,
  what: string,
  forceHint: string,
  folder?: { dir: string; name: string },
): void {
  if (comparison.kind === "backward") {
    const shown = comparison.missing.slice(0, 10);
    const more = comparison.missing.length - shown.length;
    const own = folder
      ? comparison.missing.filter((m) => changesFolder(folder.dir, m.commit)).length
      : 0;
    const mark = (commit: string) =>
      folder && changesFolder(folder.dir, commit) ? `  (changes ${folder.name})` : "";
    throw new OperationError(
      "DEPLOY_BACKWARD",
      [
        `${what} runs ${comparison.missing.length} commit(s) that this checkout lacks:`,
        ...shown.map((m) => `  ${m.commit.slice(0, 8)} ${m.subject}${mark(m.commit)}`),
        ...(more > 0 ? [`  …and ${more} more`] : []),
        ...(folder
          ? [
              own === 0
                ? `None of them change ${folder.name}'s folder. They change other parts of this repository.`
                : `${own} of them change ${folder.name}'s folder.`,
            ]
          : []),
        "Deploying this checkout would remove them. Check out or rebase onto the branch the cloud runs,",
        `or deploy anyway with ${forceHint}.`,
      ].join("\n"),
    );
  }
  if (comparison.kind === "unknown-commit") {
    throw new OperationError(
      "DEPLOY_BACKWARD",
      `${what} runs commit ${comparison.recorded.slice(0, 12)}, which no remote of this checkout holds, ` +
        `so nothing can say whether deploying would remove its changes. Fetch the branch that holds it, ` +
        `or deploy anyway with ${forceHint}.`,
    );
  }
}

/** A line for the progress log about the comparison, or null when there is nothing to say. */
export function comparisonNote(comparison: DeployComparison, what: string): string | null {
  if (comparison.kind === "no-record")
    return `${what} has no recorded commit yet, so the backward-deploy check has nothing to compare.`;
  if (comparison.kind === "outside-git")
    return `This folder is outside git, so the backward-deploy check for ${what} cannot run.`;
  if (comparison.kind === "ok" && comparison.dirty)
    return `Warning: ${what} was last deployed from ${comparison.recorded.slice(0, 8)} with uncommitted changes, which no check can compare.`;
  return null;
}
