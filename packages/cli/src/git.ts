/**
 * The fetch step of `starkeep update`, with the rules that keep a person's own
 * work safe:
 *
 * - Tracked changes, staged or not, refuse the update. Untracked files stay;
 *   git itself refuses a pull that would overwrite one.
 * - `--ff-only` never makes a merge commit and never rewrites a local commit.
 *   A branch with commits on both sides has diverged, and the update refuses.
 * - The commit before each pull goes into `~/.starkeep/updates.json`, so
 *   `starkeep update --undo` can return to it with `git reset --keep`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim() || (result.error?.message ?? ""),
  };
}

/** The working tree's root that holds `dir`, or null outside git. */
export function repoRootOf(dir: string): string | null {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok && r.out ? r.out : null;
}

export function headCommit(root: string): string {
  const r = git(root, ["rev-parse", "HEAD"]);
  if (!r.ok) throw new Error(`git rev-parse HEAD failed in ${root}: ${r.err}`);
  return r.out;
}

/** The branch's upstream, such as `origin/main`, or null when it has none. */
export function upstreamOf(root: string): string | null {
  const r = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  return r.ok && r.out ? r.out : null;
}

/** Tracked files with changes, staged or not, as `git status --porcelain` lists them. */
export function trackedChanges(root: string): string[] {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  });
  // Not trimmed at the start: the first column is the staged state.
  return (result.stdout ?? "").split("\n").filter((line) => line.trim().length > 0);
}

export function fetchUpstream(root: string): void {
  const r = git(root, ["fetch", "--quiet"]);
  if (!r.ok) throw new Error(`git fetch failed in ${root}: ${r.err}`);
}

/** Commits on this branch the upstream lacks, and commits upstream this branch lacks. */
export function aheadBehind(root: string): { ahead: number; behind: number } {
  const r = git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  if (!r.ok) throw new Error(`git rev-list failed in ${root}: ${r.err}`);
  const [ahead, behind] = r.out.split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export function pullFastForward(root: string): void {
  const r = git(root, ["pull", "--ff-only", "--quiet"]);
  if (!r.ok) throw new Error(`git pull --ff-only failed in ${root}: ${r.err}`);
}

/** Return to `commit`, refusing rather than discarding a change made since. */
export function resetKeep(root: string, commit: string): void {
  const r = git(root, ["reset", "--keep", commit]);
  if (!r.ok) throw new Error(`git reset --keep ${commit} failed in ${root}: ${r.err}`);
}

export interface RepoUpdate {
  root: string;
  before: string;
  after: string;
}

export interface UpdateRecord {
  at: string;
  repos: RepoUpdate[];
}

function updatesFile(): string {
  return join(starkeepDir(), "updates.json");
}

export function readUpdates(): UpdateRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(updatesFile(), "utf8")) as { updates?: UpdateRecord[] };
    return Array.isArray(parsed.updates) ? parsed.updates : [];
  } catch {
    return [];
  }
}

export function writeUpdates(updates: UpdateRecord[]): void {
  mkdirSync(starkeepDir(), { recursive: true });
  const path = updatesFile();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updates }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
