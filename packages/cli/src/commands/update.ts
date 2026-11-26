/**
 * `starkeep update`: get new code for installed apps, then apply it here.
 *
 * Getting new code runs `git pull --ff-only` on each app's repository, under
 * the rules in `git.ts`. Applying it stops a running app, runs the approved
 * dependency install, reinstalls a changed manifest (asking again when the
 * grants grew, as admin-web's update dialog does) and starts the app again.
 *
 * The platform checkout and the cloud targets join this command later.
 */
import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { sameManifest, readRegistry, type RegistryApp } from "@starkeep/operator/apps";
import { consentDiffers, consentLines } from "@starkeep/admin-installer/consent-text";
import {
  MANIFEST_FILE,
  parseManifestText,
  readFolderManifest,
  type FolderManifest,
} from "@starkeep/admin-installer/app-discovery";
import { stopById } from "@starkeep/operator/daemons";
import { acquireLock } from "@starkeep/operator/locks";
import { serviceStatus } from "@starkeep/operator/service-control";
import { flag, type Command } from "../command";
import { CliError, EXIT_USAGE, usageError } from "../errors";
import { requireTerminal, type Io } from "../io";
import {
  installCommandFor,
  registerLocally,
  requireDataServer,
  runDependencyInstall,
  type ResolvedApp,
} from "../app-steps";
import {
  aheadBehind,
  fetchUpstream,
  fileAt,
  headCommit,
  pullFastForward,
  readUpdates,
  repoRootOf,
  resetKeep,
  trackedChanges,
  upstreamOf,
  writeUpdates,
  type RepoUpdate,
} from "../git";
import { startOne } from "./services";
import { PLATFORM_SERVICES, serviceId } from "../names";

type AppManifest = Extract<FolderManifest, { kind: "valid" }>["manifest"];

export interface Target {
  row: RegistryApp & { sourceDir: string };
  repo: string | null;
}

async function installedTargets(names: string[]): Promise<Target[]> {
  const registry = await readRegistry();
  if (registry === null) {
    throw new CliError(
      "The local data server is not answering. Run `starkeep start data-server` first.",
    );
  }
  const withSource = registry.filter(
    (r): r is RegistryApp & { sourceDir: string } => r.sourceDir !== null,
  );
  const chosen = names.length
    ? names.map((n) => {
        if ((PLATFORM_SERVICES as readonly string[]).includes(serviceId(n))) {
          throw new CliError(`${n} is built in and updates with the platform.`);
        }
        const row = withSource.find((r) => r.appId === n);
        if (!row) {
          throw new CliError(
            registry.some((r) => r.appId === n)
              ? `${n} is built in and updates with the platform.`
              : `${n} is not installed on this computer.`,
          );
        }
        return row;
      })
    : withSource;
  return chosen.map((row) => ({ row, repo: repoRootOf(row.sourceDir) }));
}

/**
 * Fetch and check every repository before any pull, so one refusal leaves
 * every repository as it was. Returns the repositories that are behind.
 */
export function checkRepos(io: Io, targets: Target[]): string[] {
  const repos = [...new Set(targets.map((t) => t.repo).filter((r): r is string => r !== null))];
  for (const t of targets) {
    if (t.repo === null) {
      io.event({
        type: "progress",
        message: `${t.row.appId}: ${t.row.sourceDir} is not in a git repository, so there is nothing to fetch.`,
      });
    }
  }
  const behind: string[] = [];
  for (const root of repos) {
    const upstream = upstreamOf(root);
    if (!upstream) {
      io.event({
        type: "progress",
        message: `${root}: the branch has no upstream, so there is nothing to fetch.`,
      });
      continue;
    }
    const changes = trackedChanges(root);
    if (changes.length > 0) {
      throw new CliError(
        `${root} has uncommitted changes to tracked files:\n  ${changes.slice(0, 10).join("\n  ")}\nCommit or stash them, then run the update again.`,
      );
    }
    io.event({ type: "progress", message: `Fetching ${root}…` });
    fetchUpstream(root);
    const counts = aheadBehind(root);
    if (counts.ahead > 0 && counts.behind > 0) {
      throw new CliError(
        `${root} has diverged from ${upstream}: ${counts.ahead} local commit(s) and ${counts.behind} new upstream commit(s). Rebase or merge by hand, then run the update again.`,
      );
    }
    if (counts.behind === 0)
      io.event({ type: "progress", message: `${root} is up to date with ${upstream}.` });
    else behind.push(root);
  }
  return behind;
}

/** Pull each repository, and record the ones that moved for `--undo`. */
export function pullRepos(io: Io, roots: string[]): RepoUpdate[] {
  const moved: RepoUpdate[] = [];
  try {
    for (const root of roots) {
      const before = headCommit(root);
      pullFastForward(root);
      const after = headCommit(root);
      moved.push({ root, before, after });
      io.event({
        type: "progress",
        message: `Pulled ${root}: ${before.slice(0, 8)} → ${after.slice(0, 8)}.`,
      });
    }
  } catch (err) {
    // git can still refuse a pull that the checks passed, such as one that
    // would overwrite an untracked file. The repositories pulled before it
    // stay recorded, so `--undo` can return them.
    if (moved.length === 0) throw err;
    writeUpdates([...readUpdates(), { at: new Date().toISOString(), repos: moved }]);
    throw new CliError(
      `${(err as Error).message}\nThe repositories pulled before it are recorded. Run \`starkeep update --undo\` to return them, or fix the error and run the update again.`,
    );
  }
  if (moved.length > 0) {
    writeUpdates([...readUpdates(), { at: new Date().toISOString(), repos: moved }]);
  }
  return moved;
}

/** Check, then pull, every repository the targets live in. */
export function fetchAll(io: Io, targets: Target[]): RepoUpdate[] {
  return pullRepos(io, checkRepos(io, targets));
}

/**
 * The manifest an app's folder will hold at `rev` (a commit, or `@{u}` for the
 * fetched upstream), or the folder's own manifest when `rev` is null.
 */
function manifestAt(target: Target, rev: string | null): FolderManifest {
  if (rev === null || target.repo === null) return readFolderManifest(target.row.sourceDir);
  // git prints the repository's real path, so compare real paths.
  const path = relative(
    realpathSync(target.repo),
    join(realpathSync(target.row.sourceDir), MANIFEST_FILE),
  );
  const text = fileAt(target.repo, rev, path);
  return text === null ? { kind: "missing" } : parseManifestText(text);
}

/** An app whose next manifest asks for different access, and that next manifest. */
interface ConsentQuestion {
  target: Target;
  next: Extract<FolderManifest, { kind: "valid" }>;
}

/** The apps whose manifest at `revOf(target)` asks for access the install never approved. */
function consentQuestions(
  targets: Target[],
  revOf: (t: Target) => string | null,
): ConsentQuestion[] {
  const out: ConsentQuestion[] = [];
  for (const target of targets) {
    const next = manifestAt(target, revOf(target));
    if (next.kind !== "valid" || next.manifest.id !== target.row.appId) continue;
    if (consentDiffers(target.row.manifest, next.manifest)) out.push({ target, next });
  }
  return out;
}

/**
 * Ask every consent question before anything changes. A run that cannot ask
 * stops with status 3 first. Returns the approved manifests by app id and the
 * ids the person declined.
 */
async function askConsents(
  io: Io,
  questions: ConsentQuestion[],
  yes: boolean,
): Promise<{ approved: Map<string, AppManifest>; declined: Set<string> }> {
  const approved = new Map<string, AppManifest>();
  const declined = new Set<string>();
  if (questions.length > 0 && !yes) {
    requireTerminal(
      io,
      `${questions.map((q) => q.target.row.appId).join(", ")} ask${questions.length === 1 ? "s" : ""} for different access.`,
      "--yes to approve",
    );
  }
  for (const { target, next } of questions) {
    const { appId, sourceDir } = target.row;
    const install = installCommandFor({ appId, appDir: sourceDir, folder: next });
    if (!io.json) {
      io.print();
      io.print(`${appId}'s new version asks for different access:`);
      for (const line of consentLines(next.manifest, install)) io.print(line);
      io.print();
    } else {
      io.event({
        type: "prompt-needed",
        reason: "consent",
        detail: consentLines(next.manifest, install).join("\n"),
      });
    }
    if (await io.confirm(`Approve ${appId}'s new access and update?`, { yes })) {
      approved.set(appId, next.manifest);
    } else {
      declined.add(appId);
    }
  }
  return { approved, declined };
}

/**
 * Apply one app's current folder to this computer. `approved` is the manifest
 * the person approved before the pull, so a folder that still holds it needs
 * no second question.
 */
async function applyLocally(
  io: Io,
  target: Target,
  yes: boolean,
  approved?: AppManifest,
): Promise<"updated" | "declined" | "skipped"> {
  const { row } = target;
  const folder = readFolderManifest(row.sourceDir);
  if (folder.kind !== "valid") {
    io.warn(
      `${row.appId}: ${folder.kind === "missing" ? `${row.sourceDir} no longer holds a manifest` : `its manifest failed validation: ${folder.error}`}. Skipped.`,
    );
    return "skipped";
  }
  if (folder.manifest.id !== row.appId) {
    io.warn(`${row.appId}: ${row.sourceDir} now holds the app "${folder.manifest.id}". Skipped.`);
    return "skipped";
  }
  const app: ResolvedApp = { appId: row.appId, appDir: row.sourceDir, folder };
  const install = installCommandFor(app);
  // The registry holds the validated manifest, so compare like with like.
  const changed = !sameManifest(row.manifest, folder.manifest);
  const preApproved = approved !== undefined && sameManifest(approved, folder.manifest);
  if (changed && !preApproved && consentDiffers(row.manifest, folder.manifest)) {
    const { declined } = await askConsents(io, [{ target, next: folder }], yes);
    if (declined.size > 0) {
      io.print(`Not updated: ${row.appId}.`);
      return "declined";
    }
  }
  const wasRunning = (await serviceStatus(row.appId)).running;
  if (wasRunning) {
    io.event({ type: "progress", message: `Stopping ${row.appId}…` });
    await stopById(row.appId);
  }
  await runDependencyInstall(io, row.appId, install);
  if (changed) {
    await registerLocally(app);
    io.event({ type: "progress", message: `Applied ${row.appId}'s new manifest.` });
  }
  if (wasRunning && !(await startOne(io, row.appId))) {
    throw new CliError(
      `${row.appId} updated but did not start again. Run \`starkeep logs ${row.appId}\`.`,
    );
  }
  io.event({ type: "progress", message: `Updated ${row.appId}.` });
  return "updated";
}

async function applyAll(
  io: Io,
  targets: Target[],
  yes: boolean,
  approved: Map<string, AppManifest> = new Map(),
): Promise<Record<string, string>> {
  const outcome: Record<string, string> = {};
  for (const t of targets) {
    const lock = acquireLock(`app-${t.row.appId}`, `starkeep update ${t.row.appId}`);
    if (!lock.ok) {
      throw new CliError(
        `Another operation on ${t.row.appId} is running (pid ${lock.holder.pid}: ${lock.holder.command}).`,
      );
    }
    try {
      outcome[t.row.appId] = await applyLocally(io, t, yes, approved.get(t.row.appId));
    } finally {
      lock.release();
    }
  }
  return outcome;
}

/**
 * The repositories in `roots` that hold no declined app, and an outcome line
 * for every app that stays put because it shares a repository with one.
 */
function withoutDeclined(
  io: Io,
  roots: string[],
  targets: Target[],
  declined: Set<string>,
): { roots: string[]; held: Record<string, string> } {
  const held: Record<string, string> = {};
  const blocked = new Set(
    targets.filter((t) => t.repo !== null && declined.has(t.row.appId)).map((t) => t.repo!),
  );
  for (const t of targets) {
    if (declined.has(t.row.appId)) {
      io.print(`Not updated: ${t.row.appId}.`);
      held[t.row.appId] = "declined";
    } else if (t.repo !== null && blocked.has(t.repo)) {
      io.print(`Not updated: ${t.row.appId}, which shares a repository with an app you declined.`);
      held[t.row.appId] = "declined";
    }
  }
  return { roots: roots.filter((r) => !blocked.has(r)), held };
}

async function undo(io: Io, yes: boolean): Promise<void> {
  const updates = readUpdates();
  const last = updates.at(-1);
  if (!last) throw new CliError("No recorded update to undo.");
  for (const repo of last.repos) {
    if (headCommit(repo.root) !== repo.after) {
      throw new CliError(
        `${repo.root} moved since the update (it is no longer at ${repo.after.slice(0, 8)}). Undo it by hand with \`git reset --keep ${repo.before}\`.`,
      );
    }
  }
  await requireDataServer();
  const before = new Map(last.repos.map((r) => [r.root, r.before]));
  const targets = (await installedTargets([])).filter((t) => t.repo !== null && before.has(t.repo));
  // An older version can ask for access too, so the questions come before the reset.
  const { approved, declined } = await askConsents(
    io,
    consentQuestions(targets, (t) => before.get(t.repo!) ?? null),
    yes,
  );
  if (declined.size > 0) {
    io.print(`Not undone: ${[...declined].join(", ")} kept the current version.`);
    io.event({ type: "result", ok: true, data: { undone: null, declined: [...declined] } });
    return;
  }
  for (const repo of last.repos) {
    resetKeep(repo.root, repo.before);
    io.event({ type: "progress", message: `Returned ${repo.root} to ${repo.before.slice(0, 8)}.` });
  }
  writeUpdates(updates.slice(0, -1));
  const outcome = await applyAll(io, targets, yes, approved);
  io.event({ type: "result", ok: true, data: { undone: last, apps: outcome } });
}

function manifestChanged(row: RegistryApp & { sourceDir: string }): boolean {
  const folder = readFolderManifest(row.sourceDir);
  return folder.kind !== "valid" || !sameManifest(row.manifest, folder.manifest);
}

export const updateCommand: Command = {
  name: "update",
  summary: "Pull new code for installed apps and apply it",
  usage: "[<app>...] [--local] [--no-fetch] [--yes] | --undo",
  lane: "none",
  flags: {
    local: {
      type: "boolean",
      description: "Update the install on this computer (the only target so far).",
    },
    cloud: { type: "boolean", description: "Not available from the CLI yet." },
    "no-fetch": {
      type: "boolean",
      description: "Apply the folders as they are, without git pull.",
    },
    yes: { type: "boolean", short: "y", description: "Approve changed access without asking." },
    undo: {
      type: "boolean",
      description: "Return the repositories the last update pulled, and apply them.",
    },
  },
  details:
    "With no apps, updates every app installed on this computer. A repository with uncommitted\n" +
    "changes to tracked files, or a branch that has diverged from its upstream, refuses the update.\n" +
    "Each pull records the commit before it, which `starkeep update --undo` returns to.",
  async run(io, args) {
    if (flag(args, "cloud")) {
      throw new CliError(
        "Cloud updates do not run from the CLI yet. Run `starkeep admin` and use the update dialog.",
        EXIT_USAGE,
        "USAGE",
      );
    }
    const yes = flag(args, "yes");
    if (flag(args, "undo")) {
      if (args.positionals.length > 0) throw usageError("--undo takes no app names.");
      await undo(io, yes);
      return;
    }
    await requireDataServer();
    const targets = await installedTargets(args.positionals);
    if (targets.length === 0) {
      io.print("No apps installed from a folder on this computer.");
      io.event({ type: "result", ok: true, data: { apps: {} } });
      return;
    }
    const noFetch = flag(args, "no-fetch");
    const behind = new Set(noFetch ? [] : checkRepos(io, targets));
    // Every question comes before the first pull, so a "no" leaves the
    // folder, the grant and the running app as they were.
    const { approved, declined } = await askConsents(
      io,
      consentQuestions(targets, (t) => (t.repo !== null && behind.has(t.repo) ? "@{u}" : null)),
      yes,
    );
    const kept = withoutDeclined(io, [...behind], targets, declined);
    const moved = pullRepos(io, kept.roots);
    if (moved.length > 0) {
      io.event({
        type: "progress",
        message: "Run `starkeep update --undo` to return to the commits before this pull.",
      });
    }
    const movedRoots = new Set(moved.map((m) => m.root));
    const toApply = targets.filter(
      (t) =>
        !(t.row.appId in kept.held) &&
        (noFetch ||
          t.repo === null ||
          movedRoots.has(t.repo) ||
          upstreamOf(t.repo) === null ||
          manifestChanged(t.row)),
    );
    for (const t of targets) {
      if (!toApply.includes(t) && !(t.row.appId in kept.held))
        io.event({ type: "progress", message: `${t.row.appId} is up to date.` });
    }
    const outcome = { ...kept.held, ...(await applyAll(io, toApply, yes, approved)) };
    io.event({ type: "result", ok: true, data: { pulled: moved, apps: outcome } });
  },
};
