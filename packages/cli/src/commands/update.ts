/**
 * `starkeep update`: get new code for installed apps, then apply it, to the
 * cloud first and then to this computer.
 *
 * Getting new code runs `git pull --ff-only` on each app's repository, under
 * the rules in `git.ts`.
 *
 * Applying it to the cloud redeploys the surfaces the app has there, unless
 * the deployed manifest and web code already match the folder. Applying it
 * here stops a running app, runs the approved dependency install, reinstalls a
 * changed manifest and starts the app again. Either asks again when the
 * access grew, as admin-web's update dialog does.
 *
 * The cloud goes first because a device that runs a newer version than the
 * cloud can stall its uploads until the cloud catches up
 * (findings-app-table-version-skew-2026-11-13).
 *
 * The platform checkout joins this command later.
 */
import { sameManifest, readRegistry, type RegistryApp } from "@starkeep/operator/apps";
import { consentDiffers, consentLines } from "@starkeep/admin-installer/consent-text";
import { readFolderManifest } from "@starkeep/admin-installer/app-discovery";
import { stopById } from "@starkeep/operator/daemons";
import { acquireLock } from "@starkeep/operator/locks";
import { serviceStatus } from "@starkeep/operator/service-control";
import type { CloudApp } from "@starkeep/operator/cloud-registry";
import { manifestDigest } from "@starkeep/admin-installer/manifest-approval";
import type { AppSurface } from "@starkeep/admin-installer/operations";
import { cloudInstalled, readCloudApps, runCloud } from "../cloud";
import { flag, type Command } from "../command";
import { CliError, usageError } from "../errors";
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
  appId: string;
  /** The folder the update pulls and applies. */
  dir: string;
  repo: string | null;
  /** The install on this computer, or null when the update leaves this computer alone. */
  local: (RegistryApp & { sourceDir: string }) | null;
  /** The cloud install, or null when the update leaves the cloud alone. */
  cloud: CloudApp | null;
}

interface Scope {
  local: boolean;
  cloud: boolean;
}

async function installedTargets(io: Io, names: string[], scope: Scope): Promise<Target[]> {
  const byId = new Map<string, Target>();
  const builtIn = new Set<string>();
  if (scope.local) {
    const registry = await readRegistry();
    if (registry === null) {
      throw new CliError(
        "The local data server is not answering. Run `starkeep start data-server` first, or pass --cloud.",
      );
    }
    for (const row of registry) {
      if (row.sourceDir === null) {
        builtIn.add(row.appId);
        continue;
      }
      const local = row as RegistryApp & { sourceDir: string };
      byId.set(row.appId, {
        appId: row.appId,
        dir: local.sourceDir,
        repo: null,
        local,
        cloud: null,
      });
    }
  }
  if (scope.cloud && cloudInstalled()) {
    for (const app of (await readCloudApps(io, { signIn: true })) ?? []) {
      const existing = byId.get(app.appId);
      if (existing) existing.cloud = app;
      else if (app.folder) {
        byId.set(app.appId, {
          appId: app.appId,
          dir: app.folder,
          repo: null,
          local: null,
          cloud: app,
        });
      } else if (names.includes(app.appId)) {
        throw new CliError(
          `${app.appId} is installed in the cloud, but no discovery folder holds it. Add its folder with \`starkeep source add <dir>\`.`,
        );
      }
    }
  }
  const chosen = names.length
    ? names.map((n) => {
        const target = byId.get(n);
        if (!target) {
          throw new CliError(
            builtIn.has(n)
              ? `${n} is built in and updates with the platform.`
              : `${n} is not installed ${scope.cloud && !scope.local ? "in the cloud" : scope.local && !scope.cloud ? "on this computer" : "here or in the cloud"}.`,
          );
        }
        return target;
      })
    : [...byId.values()];
  return chosen.map((t) => ({ ...t, repo: repoRootOf(t.dir) }));
}

/**
 * Check every repository first, then pull, so one refusal leaves every
 * repository as it was. Records and returns the repositories that moved.
 */
export function fetchAll(io: Io, targets: Target[]): RepoUpdate[] {
  const repos = [...new Set(targets.map((t) => t.repo).filter((r): r is string => r !== null))];
  for (const t of targets) {
    if (t.repo === null) {
      io.event({
        type: "progress",
        message: `${t.appId}: ${t.dir} is not in a git repository, so there is nothing to fetch.`,
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
  try {
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

/** The surfaces a cloud install has, which a redeploy keeps and never adds to. */
function installedSurfaces(app: CloudApp): AppSurface[] {
  return [
    ...(app.webApp ? (["web"] as const) : []),
    ...(app.mobileApp ? (["mobile"] as const) : []),
  ];
}

/** Apply one app's current folder to the cloud. */
async function applyToCloud(
  io: Io,
  target: Target & { cloud: CloudApp },
  yes: boolean,
): Promise<"updated" | "declined" | "skipped" | "up to date"> {
  const { appId, cloud } = target;
  const folder = readFolderManifest(target.dir);
  if (folder.kind !== "valid" || folder.manifest.id !== appId) {
    io.warn(`${appId}: ${target.dir} holds no valid manifest for ${appId}. Cloud skipped.`);
    return "skipped";
  }
  // `codeBehind` is null when the folder has no fingerprint: redeploy then,
  // since nothing says the cloud runs the folder's code.
  if (cloud.behind === false && cloud.codeBehind === false) {
    io.event({ type: "progress", message: `${appId}: the cloud already runs this folder.` });
    return "up to date";
  }
  const install = installCommandFor({ appId, appDir: target.dir, folder });
  if (
    cloud.behind &&
    (cloud.manifest === null || consentDiffers(cloud.manifest, folder.manifest))
  ) {
    if (!io.json) {
      io.print();
      io.print(`${appId}'s new version asks the cloud for different access:`);
      for (const line of consentLines(folder.manifest, install)) io.print(line);
      io.print();
    } else {
      io.event({
        type: "prompt-needed",
        reason: "consent",
        detail: consentLines(folder.manifest, install).join("\n"),
      });
    }
    if (!(await io.confirm(`Approve ${appId}'s new access and update the cloud?`, { yes }))) {
      io.print(`Not updated in the cloud: ${appId}.`);
      return "declined";
    }
  }
  const surfaces = installedSurfaces(cloud);
  io.event({
    type: "progress",
    message: `Updating ${appId} in the cloud (${surfaces.length > 0 ? surfaces.join(", ") : "data side"})…`,
  });
  await runCloud(io, {
    name: "install-cloud-app",
    input: { appId, appDir: target.dir, surfaces, manifestDigest: manifestDigest(folder.manifest) },
    owner: `${appId} (${surfaces.length > 0 ? surfaces.join(", ") : "data side only"})`,
    lock: `app-${appId}`,
    command: `starkeep update ${appId}`,
  });
  return "updated";
}

/** Apply one app's current folder to this computer. */
async function applyLocally(
  io: Io,
  target: Target & { local: RegistryApp & { sourceDir: string } },
  yes: boolean,
): Promise<"updated" | "declined" | "skipped"> {
  const row = target.local;
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

type Outcome = { cloud?: string; local?: string };

async function applyAll(io: Io, targets: Target[], yes: boolean): Promise<Record<string, Outcome>> {
  const outcome: Record<string, Outcome> = {};
  for (const t of targets) {
    const lock = acquireLock(`app-${t.appId}`, `starkeep update ${t.appId}`);
    if (!lock.ok) {
      throw new CliError(
        `Another operation on ${t.appId} is running (pid ${lock.holder.pid}: ${lock.holder.command}).`,
      );
    }
    try {
      const result: Outcome = {};
      if (t.cloud) result.cloud = await applyToCloud(io, { ...t, cloud: t.cloud }, yes);
      // A cloud update the person declined leaves this computer alone too, so
      // the device never runs ahead of the cloud.
      if (t.local && result.cloud !== "declined") {
        result.local = await applyLocally(io, { ...t, local: t.local }, yes);
      }
      outcome[t.appId] = result;
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
  const targets = (await installedTargets(io, [], { local: true, cloud: true })).filter(
    (t) => t.repo !== null && roots.has(t.repo),
  );
  const outcome = await applyAll(io, targets, yes);
  io.event({ type: "result", ok: true, data: { undone: last, apps: outcome } });
}

/** Whether the folder holds something a target's installs do not run yet. */
function needsApply(t: Target): boolean {
  if (t.cloud && (t.cloud.behind !== false || t.cloud.codeBehind !== false)) return true;
  if (!t.local) return false;
  const folder = readFolderManifest(t.local.sourceDir);
  return folder.kind !== "valid" || !sameManifest(t.local.manifest, folder.manifest);
}

export const updateCommand: Command = {
  name: "update",
  summary: "Pull new code for installed apps and apply it",
  usage: "[<app>...] [--local | --cloud] [--no-fetch] [--yes] | --undo",
  lane: "target",
  flags: {
    local: { type: "boolean", description: "Update only the installs on this computer." },
    cloud: { type: "boolean", description: "Update only the cloud installs." },
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
    "With no apps, updates every app installed here or in the cloud, the cloud first. An update\n" +
    "never adds a target: it redeploys the surfaces an app already has. A cloud install whose\n" +
    "manifest and web code match the folder is skipped. A repository with uncommitted\n" +
    "changes to tracked files, or a branch that has diverged from its upstream, refuses the update.\n" +
    "Each pull records the commit before it, which `starkeep update --undo` returns to.",
  async run(io, args) {
    const only = { local: flag(args, "local"), cloud: flag(args, "cloud") };
    const scope: Scope = only.local || only.cloud ? only : { local: true, cloud: true };
    const yes = flag(args, "yes");
    if (flag(args, "undo")) {
      if (args.positionals.length > 0) throw usageError("--undo takes no app names.");
      await undo(io, yes);
      return;
    }
    if (scope.local) await requireDataServer();
    const targets = await installedTargets(io, args.positionals, scope);
    if (targets.length === 0) {
      io.print("No apps installed from a folder, here or in the cloud.");
      io.event({ type: "result", ok: true, data: { apps: {} } });
      return;
    }
    const noFetch = flag(args, "no-fetch");
    const moved = noFetch ? [] : fetchAll(io, targets);
    if (moved.length > 0) {
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
        needsApply(t),
    );
    for (const t of targets) {
      if (!toApply.includes(t))
        io.event({ type: "progress", message: `${t.appId} is up to date.` });
    }
    const outcome = await applyAll(io, toApply, yes);
    io.event({ type: "result", ok: true, data: { pulled: moved, apps: outcome } });
  },
};
