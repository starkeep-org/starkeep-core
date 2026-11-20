/**
 * `starkeep update`: get new code for installed apps, then apply it, to the
 * cloud first and then to this computer.
 *
 * Getting new code runs `git pull --ff-only` on each app's repository, under
 * the rules in `git.ts`. Every consent question comes before the first pull:
 * the command reads each app's next manifest from the fetched upstream, so a
 * "no" leaves the folder, the grants and the running app as they were.
 *
 * Applying it to the cloud redeploys the surfaces the app has there, unless
 * the deployed manifest and web code already match the folder. Applying it
 * here stops a running app, runs the approved dependency install, reinstalls a
 * changed manifest and starts the app again.
 *
 * The cloud goes first because a device that runs a newer version than the
 * cloud can stall its uploads until the cloud catches up
 * (findings-app-table-version-skew-2026-11-13).
 *
 * The platform checkout joins this command later.
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
import type { CloudApp } from "@starkeep/operator/cloud-registry";
import { manifestDigest } from "@starkeep/admin-installer/manifest-approval";
import type { AppSurface } from "@starkeep/admin-installer/operations";
import { cloudInstalled, readCloudApps, runCloud } from "../cloud";
import { flag, type Command } from "../command";
import { CliError, usageError } from "../errors";
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
  for (const n of names) {
    if ((PLATFORM_SERVICES as readonly string[]).includes(serviceId(n))) {
      throw new CliError(`${n} is built in and updates with the platform.`);
    }
  }
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
 * Fetch and check every repository before any pull, so one refusal leaves
 * every repository as it was. Returns the repositories that are behind.
 */
export function checkRepos(io: Io, targets: Target[]): string[] {
  const repos = [...new Set(targets.map((t) => t.repo).filter((r): r is string => r !== null))];
  for (const t of targets) {
    if (t.repo === null) {
      io.event({
        type: "progress",
        message: `${t.appId}: ${t.dir} is not in a git repository, so there is nothing to fetch.`,
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
  if (rev === null || target.repo === null) return readFolderManifest(target.dir);
  // git prints the repository's real path, so compare real paths.
  const path = relative(realpathSync(target.repo), join(realpathSync(target.dir), MANIFEST_FILE));
  const text = fileAt(target.repo, rev, path);
  return text === null ? { kind: "missing" } : parseManifestText(text);
}

/** Where a consent question's new access applies. */
interface ConsentQuestion {
  target: Target;
  next: Extract<FolderManifest, { kind: "valid" }>;
  local: boolean;
  cloud: boolean;
}

/** Whether `next` asks the cloud install for access it never approved. */
function cloudConsentDiffers(cloud: CloudApp, next: AppManifest): boolean {
  return cloud.manifest === null || consentDiffers(cloud.manifest, next);
}

/** The apps whose manifest at `revOf(target)` asks for access an install never approved. */
function consentQuestions(
  targets: Target[],
  revOf: (t: Target) => string | null,
): ConsentQuestion[] {
  const out: ConsentQuestion[] = [];
  for (const target of targets) {
    const next = manifestAt(target, revOf(target));
    if (next.kind !== "valid" || next.manifest.id !== target.appId) continue;
    const local = target.local !== null && consentDiffers(target.local.manifest, next.manifest);
    const cloud = target.cloud !== null && cloudConsentDiffers(target.cloud, next.manifest);
    if (local || cloud) out.push({ target, next, local, cloud });
  }
  return out;
}

/**
 * Ask every consent question before anything changes. A run that cannot ask
 * stops with status 3 first. Returns the approved manifests by app id and the
 * ids the person declined. A decline holds the app back everywhere, so the
 * device never runs ahead of the cloud.
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
      `${questions.map((q) => q.target.appId).join(", ")} ask${questions.length === 1 ? "s" : ""} for different access.`,
      "--yes to approve",
    );
  }
  for (const { target, next, local, cloud } of questions) {
    const { appId, dir } = target;
    const install = installCommandFor({ appId, appDir: dir, folder: next });
    const where = cloud && local ? " here and in the cloud" : cloud ? " in the cloud" : "";
    if (!io.json) {
      io.print();
      io.print(`${appId}'s new version asks for different access${where}:`);
      for (const line of consentLines(next.manifest, install)) io.print(line);
      io.print();
    } else {
      io.event({
        type: "prompt-needed",
        reason: "consent",
        detail: consentLines(next.manifest, install).join("\n"),
      });
    }
    const question = cloud && !local ? "update the cloud" : "update";
    if (await io.confirm(`Approve ${appId}'s new access and ${question}?`, { yes })) {
      approved.set(appId, next.manifest);
    } else {
      declined.add(appId);
    }
  }
  return { approved, declined };
}

/** The surfaces a cloud install has, which a redeploy keeps and never adds to. */
function installedSurfaces(app: CloudApp): AppSurface[] {
  return [
    ...(app.webApp ? (["web"] as const) : []),
    ...(app.mobileApp ? (["mobile"] as const) : []),
  ];
}

/**
 * Apply one app's current folder to the cloud. `moved` says the pull changed
 * the folder after the cloud was compared with it, so the comparison is stale.
 */
async function applyToCloud(
  io: Io,
  target: Target & { cloud: CloudApp },
  yes: boolean,
  approved: AppManifest | undefined,
  moved: boolean,
): Promise<"updated" | "declined" | "skipped" | "up to date"> {
  const { appId, cloud } = target;
  const folder = readFolderManifest(target.dir);
  if (folder.kind !== "valid" || folder.manifest.id !== appId) {
    io.warn(`${appId}: ${target.dir} holds no valid manifest for ${appId}. Cloud skipped.`);
    return "skipped";
  }
  // `codeBehind` is null when the folder has no fingerprint: redeploy then,
  // since nothing says the cloud runs the folder's code.
  if (!moved && cloud.behind === false && cloud.codeBehind === false) {
    io.event({ type: "progress", message: `${appId}: the cloud already runs this folder.` });
    return "up to date";
  }
  const preApproved = approved !== undefined && sameManifest(approved, folder.manifest);
  if (!preApproved && cloudConsentDiffers(cloud, folder.manifest)) {
    const { declined } = await askConsents(
      io,
      [{ target, next: folder, local: false, cloud: true }],
      yes,
    );
    if (declined.size > 0) {
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

/**
 * Apply one app's current folder to this computer. `approved` is the manifest
 * the person approved before the pull, so a folder that still holds it needs
 * no second question.
 */
async function applyLocally(
  io: Io,
  target: Target & { local: RegistryApp & { sourceDir: string } },
  yes: boolean,
  approved?: AppManifest,
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
  const preApproved = approved !== undefined && sameManifest(approved, folder.manifest);
  if (changed && !preApproved && consentDiffers(row.manifest, folder.manifest)) {
    const { declined } = await askConsents(
      io,
      [{ target, next: folder, local: true, cloud: false }],
      yes,
    );
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

type Outcome = { cloud?: string; local?: string };

async function applyAll(
  io: Io,
  targets: Target[],
  yes: boolean,
  approved: Map<string, AppManifest> = new Map(),
  movedRoots: Set<string> = new Set(),
): Promise<Record<string, Outcome>> {
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
      const ok = approved.get(t.appId);
      const moved = t.repo !== null && movedRoots.has(t.repo);
      if (t.cloud) result.cloud = await applyToCloud(io, { ...t, cloud: t.cloud }, yes, ok, moved);
      // A cloud update the person declined leaves this computer alone too, so
      // the device never runs ahead of the cloud.
      if (t.local && result.cloud !== "declined") {
        result.local = await applyLocally(io, { ...t, local: t.local }, yes, ok);
      }
      outcome[t.appId] = result;
    } finally {
      lock.release();
    }
  }
  return outcome;
}

/**
 * The repositories in `roots` that hold no declined app, and an outcome for
 * every app that stays put because it shares a repository with one.
 */
function withoutDeclined(
  io: Io,
  roots: string[],
  targets: Target[],
  declined: Set<string>,
): { roots: string[]; held: Record<string, Outcome> } {
  const held: Record<string, Outcome> = {};
  const blocked = new Set(
    targets.filter((t) => t.repo !== null && declined.has(t.appId)).map((t) => t.repo!),
  );
  const both = (t: Target): Outcome => ({
    ...(t.cloud ? { cloud: "declined" } : {}),
    ...(t.local ? { local: "declined" } : {}),
  });
  for (const t of targets) {
    if (declined.has(t.appId)) {
      io.print(`Not updated: ${t.appId}.`);
      held[t.appId] = both(t);
    } else if (t.repo !== null && blocked.has(t.repo)) {
      io.print(`Not updated: ${t.appId}, which shares a repository with an app you declined.`);
      held[t.appId] = both(t);
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
  const targets = (await installedTargets(io, [], { local: true, cloud: true })).filter(
    (t) => t.repo !== null && before.has(t.repo),
  );
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
  const outcome = await applyAll(io, targets, yes, approved, new Set(before.keys()));
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
    "Every question about new access comes before the first pull.\n" +
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
        !(t.appId in kept.held) &&
        (noFetch ||
          t.repo === null ||
          movedRoots.has(t.repo) ||
          upstreamOf(t.repo) === null ||
          needsApply(t)),
    );
    for (const t of targets) {
      if (!toApply.includes(t) && !(t.appId in kept.held))
        io.event({ type: "progress", message: `${t.appId} is up to date.` });
    }
    const outcome = {
      ...kept.held,
      ...(await applyAll(io, toApply, yes, approved, movedRoots)),
    };
    io.event({ type: "result", ok: true, data: { pulled: moved, apps: outcome } });
  },
};
