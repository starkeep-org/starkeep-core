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
import { sameManifest, readRegistry, type RegistryApp } from "@starkeep/operator/apps";
import { consentDiffers, consentLines } from "@starkeep/admin-installer/consent-text";
import { readFolderManifest } from "@starkeep/admin-installer/app-discovery";
import { stopById } from "@starkeep/operator/daemons";
import { acquireLock } from "@starkeep/operator/locks";
import { serviceStatus } from "@starkeep/operator/service-control";
import { flag, type Command } from "../command";
import { CliError, EXIT_USAGE, usageError } from "../errors";
import type { Io } from "../io";
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
 * Check every repository first, then pull, so one refusal leaves every
 * repository as it was. Returns the repositories that moved.
 */
export function fetchAll(io: Io, targets: Target[]): RepoUpdate[] {
  const repos = [...new Set(targets.map((t) => t.repo).filter((r): r is string => r !== null))];
  for (const t of targets) {
    if (t.repo === null) {
      io.event({
        type: "progress",
        message: `${t.row.appId}: ${t.row.sourceDir} is not in a git repository, so there is nothing to fetch.`,
      });
    }
  }
  const toPull: string[] = [];
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
    const { ahead, behind } = aheadBehind(root);
    if (ahead > 0 && behind > 0) {
      throw new CliError(
        `${root} has diverged from ${upstream}: ${ahead} local commit(s) and ${behind} new upstream commit(s). Rebase or merge by hand, then run the update again.`,
      );
    }
    if (behind === 0)
      io.event({ type: "progress", message: `${root} is up to date with ${upstream}.` });
    else toPull.push(root);
  }
  const moved: RepoUpdate[] = [];
  for (const root of toPull) {
    const before = headCommit(root);
    pullFastForward(root);
    const after = headCommit(root);
    moved.push({ root, before, after });
    io.event({
      type: "progress",
      message: `Pulled ${root}: ${before.slice(0, 8)} → ${after.slice(0, 8)}.`,
    });
  }
  return moved;
}

/** Apply one app's current folder to this computer. */
async function applyLocally(
  io: Io,
  target: Target,
  yes: boolean,
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
  if (changed && consentDiffers(row.manifest, folder.manifest)) {
    if (!io.json) {
      io.print();
      io.print(`${row.appId}'s new version asks for different access:`);
      for (const line of consentLines(folder.manifest, install)) io.print(line);
      io.print();
    } else {
      io.event({
        type: "prompt-needed",
        reason: "consent",
        detail: consentLines(folder.manifest, install).join("\n"),
      });
    }
    if (!(await io.confirm(`Approve ${row.appId}'s new access and update?`, { yes }))) {
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

async function applyAll(io: Io, targets: Target[], yes: boolean): Promise<Record<string, string>> {
  const outcome: Record<string, string> = {};
  for (const t of targets) {
    const lock = acquireLock(`app-${t.row.appId}`, `starkeep update ${t.row.appId}`);
    if (!lock.ok) {
      throw new CliError(
        `Another operation on ${t.row.appId} is running (pid ${lock.holder.pid}: ${lock.holder.command}).`,
      );
    }
    try {
      outcome[t.row.appId] = await applyLocally(io, t, yes);
    } finally {
      lock.release();
    }
  }
  return outcome;
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
  for (const repo of last.repos) {
    resetKeep(repo.root, repo.before);
    io.event({ type: "progress", message: `Returned ${repo.root} to ${repo.before.slice(0, 8)}.` });
  }
  writeUpdates(updates.slice(0, -1));
  await requireDataServer();
  const roots = new Set(last.repos.map((r) => r.root));
  const targets = (await installedTargets([])).filter((t) => t.repo !== null && roots.has(t.repo));
  const outcome = await applyAll(io, targets, yes);
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
    const moved = noFetch ? [] : fetchAll(io, targets);
    if (moved.length > 0) {
      writeUpdates([...readUpdates(), { at: new Date().toISOString(), repos: moved }]);
      io.event({
        type: "progress",
        message: "Run `starkeep update --undo` to return to the commits before this pull.",
      });
    }
    const movedRoots = new Set(moved.map((m) => m.root));
    const toApply = targets.filter(
      (t) =>
        noFetch ||
        t.repo === null ||
        movedRoots.has(t.repo) ||
        upstreamOf(t.repo) === null ||
        manifestChanged(t.row),
    );
    for (const t of targets) {
      if (!toApply.includes(t))
        io.event({ type: "progress", message: `${t.row.appId} is up to date.` });
    }
    const outcome = await applyAll(io, toApply, yes);
    io.event({ type: "result", ok: true, data: { pulled: moved, apps: outcome } });
  },
};
