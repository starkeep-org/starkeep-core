/**
 * App commands: `source`, `list`, `info`, `install` and `uninstall`.
 *
 * `--local` acts on this computer, through the local data server. `--cloud`,
 * `--web` and `--mobile` act on the cloud, through the installer's operations
 * in a detached run as the signed-in admin (`../cloud.ts`).
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expandHome } from "@starkeep/admin-installer/app-discovery";
import { manifestDigest } from "@starkeep/admin-installer/manifest-approval";
import type { AppSurface } from "@starkeep/admin-installer/operations";
import { consentLines } from "@starkeep/admin-installer/consent-text";
import {
  appParentDirs,
  pinnedSourceState,
  pinsOf,
  readKeptData,
  readRegistry,
  scanApps,
} from "@starkeep/operator/apps";
import { patchConfig, readConfigSeeded } from "@starkeep/operator/config";
import { stopById } from "@starkeep/operator/daemons";
import { acquireLock } from "@starkeep/operator/locks";
import { deleteKeptAppData, uninstallLocalApp } from "@starkeep/operator/local-apps";
import { serviceStatus } from "@starkeep/operator/service-control";
import { flag, type Command, type ParsedArgs } from "../command";
import { CliError, usageError } from "../errors";
import { requireTerminal, type Io } from "../io";
import {
  installCommandFor,
  registerLocally,
  requireDataServer,
  resolveAppReference,
  runDependencyInstall,
  type ResolvedApp,
} from "../app-steps";
import { startOne } from "./services";
import { cloudInstalled, readCloudApps, runCloud } from "../cloud";
import type { CloudApp } from "@starkeep/operator/cloud-registry";

const TARGET_FLAGS = {
  local: { type: "boolean", description: "This computer." },
  cloud: {
    type: "boolean",
    description: "The cloud: the data side and every surface the manifest offers.",
  },
  web: { type: "boolean", description: "The cloud web app only." },
  mobile: { type: "boolean", description: "The mobile app only." },
} as const;

export interface Targets {
  local: boolean;
  /**
   * The cloud surfaces: `all` for `--cloud` (the data side and every surface
   * the manifest offers), the named ones for `--web` and `--mobile`, or null
   * for no cloud target.
   */
  cloud: "all" | AppSurface[] | null;
}

/** The explicit target `install` and `uninstall` require (decision 2 of the design). */
export function targetsOf(args: ParsedArgs, verb: string): Targets {
  const surfaces = (["web", "mobile"] as const).filter((f) => flag(args, f));
  const targets: Targets = {
    local: flag(args, "local"),
    cloud: flag(args, "cloud") ? "all" : surfaces.length > 0 ? [...surfaces] : null,
  };
  if (!targets.local && targets.cloud === null) {
    throw usageError(
      `Name where to ${verb}: --local (this computer), --cloud (the cloud, every surface), --web or --mobile. Flags combine.`,
    );
  }
  return targets;
}

/** How a run's owner names the cloud surfaces, the words admin-web uses too. */
function surfaceOwner(appId: string, cloud: "all" | AppSurface[]): string {
  return `${appId} (${cloud === "all" ? "every surface" : cloud.join(", ")})`;
}

function requireCloud(): void {
  if (!cloudInstalled()) {
    throw new CliError(
      "This computer has no cloud with a data server yet. Run `starkeep setup --cloud` first.",
    );
  }
}

const TYPE_BACK_HINT = "--yes to delete without typing the app id";

/** Take an app's lock for the length of `body`. */
async function withAppLock<T>(appId: string, command: string, body: () => Promise<T>): Promise<T> {
  const lock = acquireLock(`app-${appId}`, command);
  if (!lock.ok) {
    throw new CliError(
      `Another operation on ${appId} is running (pid ${lock.holder.pid}: ${lock.holder.command}). Try again once it ends.`,
    );
  }
  try {
    return await body();
  } finally {
    lock.release();
  }
}

export const sourceCommand: Command = {
  name: "source",
  summary: "Manage the folders app discovery scans",
  usage: "add <dir> | list | remove <dir>",
  lane: "none",
  flags: {},
  details:
    "A folder is one app (it holds starkeep.manifest.json) or a folder of apps. `add` prints the\n" +
    "apps the folder contributed and why any folder in it was skipped.",
  async run(io, args) {
    const [verb, dir, ...rest] = args.positionals;
    if (rest.length > 0) throw usageError("source takes one folder");
    readConfigSeeded();
    const dirs = appParentDirs();
    if (verb === "list" || verb === undefined) {
      const scan = scanApps();
      if (io.json) {
        io.event({ type: "result", ok: true, data: { dirs: scan.dirs } });
        return;
      }
      if (scan.dirs.length === 0)
        io.print("No discovery folders. Add one with `starkeep source add <dir>`.");
      for (const d of scan.dirs) printScannedDir(io, d);
      return;
    }
    if (!dir) throw usageError(`source ${verb} needs a folder`);
    const typed = dir.startsWith("~") ? dir : resolve(io.cwd, dir);
    const absolute = resolve(expandHome(typed));
    if (verb === "add") {
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        throw new CliError(`${absolute} is not a folder.`);
      }
      if (!dirs.some((d) => resolve(expandHome(d)) === absolute)) {
        patchConfig({ appParentDirs: [...dirs, typed] });
      }
      const entry = scanApps().dirs.find((d) => resolve(expandHome(d.dir)) === absolute);
      if (io.json) {
        io.event({ type: "result", ok: true, data: { dir: entry } });
        return;
      }
      if (entry) printScannedDir(io, entry);
      return;
    }
    if (verb === "remove") {
      const kept = dirs.filter((d) => resolve(expandHome(d)) !== absolute);
      if (kept.length === dirs.length) throw new CliError(`${dir} is not a discovery folder.`);
      patchConfig({ appParentDirs: kept });
      io.event({ type: "progress", message: `Removed ${dir} from the discovery folders.` });
      io.event({ type: "result", ok: true });
      return;
    }
    throw usageError(`Unknown source command "${verb}". Use add, list or remove.`);
  },
};

/**
 * Ask for `appId` typed back before an uninstall that deletes data changes
 * anything. A preview of what the cloud deletion removes comes first when the
 * app is already gone from the cloud; the cloud cannot count an installed
 * app's data.
 */
async function confirmDeletion(
  io: Io,
  appId: string,
  targets: Targets,
  installedHere: boolean,
): Promise<void> {
  const where = [
    ...(targets.local ? ["on this computer"] : []),
    ...(targets.cloud ? ["in the cloud"] : []),
  ].join(" and ");
  let inCloud = false;
  if (targets.cloud) {
    inCloud = (await readCloudApps(io, { signIn: true }))?.some((a) => a.appId === appId) ?? false;
    if (!inCloud) {
      await runCloud(io, {
        name: "delete-app-data",
        input: { appId, preview: true },
        owner: `${appId} (preview data deletion)`,
        lock: `app-${appId}`,
        command: `starkeep uninstall ${appId} --cloud --delete-data`,
      });
    }
  }
  const typed = await io.ask(`Type ${appId} to delete its data ${where}:`, {
    flagHint: TYPE_BACK_HINT,
  });
  if (typed !== appId) {
    throw new CliError(
      `Nothing changed: the typed id did not match, so ${appId} ${installedHere || inCloud ? "stays installed with its data" : "keeps its data"}.`,
    );
  }
}

/** Remove `appId`'s cloud surfaces, or the whole app, and with `deleteData` its cloud data. */
async function uninstallFromCloud(
  io: Io,
  appId: string,
  cloud: "all" | AppSurface[],
  deleteData: boolean,
): Promise<void> {
  const installed = await readCloudApps(io, { signIn: true });
  const row = installed?.find((a) => a.appId === appId);
  if (!row && !deleteData) throw new CliError(`${appId} is not installed in the cloud.`);
  if (row) {
    await runCloud(io, {
      name: "uninstall-cloud-app",
      input: {
        appId,
        ...(row.folder ? { appDir: row.folder } : {}),
        ...(cloud === "all" ? {} : { surfaces: cloud }),
      },
      owner: `${appId} (uninstall ${cloud === "all" ? "every surface" : cloud.join(", ")})`,
      lock: `app-${appId}`,
      command: `starkeep uninstall ${appId} --cloud`,
    });
  }
  if (!deleteData) return;
  await runCloud(io, {
    name: "delete-app-data",
    input: { appId, confirm: appId },
    owner: `${appId} (delete data)`,
    lock: `app-${appId}`,
    command: `starkeep uninstall ${appId} --cloud --delete-data`,
  });
}

function printScannedDir(
  io: Io,
  d: {
    dir: string;
    apps: Array<{ appId: string; name: string }>;
    problems: Array<{ reason: string }>;
  },
): void {
  io.print(d.dir);
  if (d.apps.length === 0 && d.problems.length === 0) io.print("  (no apps)");
  for (const a of d.apps) io.print(`  ${a.appId.padEnd(20)} ${a.name}`);
  for (const p of d.problems) io.print(`  skipped: ${p.reason}`);
}

interface ListRow {
  appId: string;
  name: string;
  source: string | null;
  local: "running" | "installed" | "not installed" | "unknown" | "kept data";
  sourceState?: string;
  /** The cloud surfaces, or null when the cloud was not read. */
  cloud?: {
    web: boolean;
    mobile: boolean;
    behind: boolean | null;
    codeBehind: boolean | null;
  } | null;
}

/** The cloud column: the data side and the surfaces, and whether a redeploy would change them. */
function cloudCell(row: ListRow): string {
  if (row.cloud === undefined) return "—";
  if (row.cloud === null) return "?";
  const surfaces = [row.cloud.web ? "web" : null, row.cloud.mobile ? "mobile" : null].filter(
    Boolean,
  );
  const behind = row.cloud.behind || row.cloud.codeBehind ? "  (behind)" : "";
  return `${surfaces.length > 0 ? surfaces.join("+") : "data"}${behind}`;
}

async function listRows(): Promise<{ rows: ListRow[]; localKnown: boolean }> {
  readConfigSeeded();
  const registry = await readRegistry();
  const pins = pinsOf(registry);
  const scan = scanApps({ pinned: pins });
  const kept = await readKeptData();
  const rows = new Map<string, ListRow>();
  for (const app of scan.apps) {
    rows.set(app.appId, {
      appId: app.appId,
      name: String(app.manifest.name ?? app.appId),
      source: app.appDir,
      local: registry === null ? "unknown" : "not installed",
    });
  }
  for (const row of registry ?? []) {
    const existing = rows.get(row.appId);
    // Built-in apps, such as Drive's, install with the platform and have no folder.
    if (row.sourceDir === null && !existing) continue;
    const status = await serviceStatus(row.appId);
    const state = row.sourceDir ? pinnedSourceState(row.sourceDir, row.manifest) : null;
    rows.set(row.appId, {
      appId: row.appId,
      name: String(row.manifest.name ?? existing?.name ?? row.appId),
      source: row.sourceDir ?? existing?.source ?? null,
      local: status.running ? "running" : "installed",
      ...(state ? { sourceState: state.sourceState } : {}),
    });
  }
  for (const k of kept) {
    if (!rows.has(k.appId)) {
      rows.set(k.appId, { appId: k.appId, name: k.name, source: null, local: "kept data" });
    } else if (rows.get(k.appId)!.local === "not installed") {
      rows.get(k.appId)!.local = "kept data";
    }
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.appId.localeCompare(b.appId)),
    localKnown: registry !== null,
  };
}

/** Add the cloud column to `rows`, and rows for apps only the cloud has. */
function addCloud(rows: ListRow[], cloud: CloudApp[] | null, localKnown: boolean): ListRow[] {
  if (cloud === null) return rows.map((r) => ({ ...r, cloud: null }));
  const byId = new Map(rows.map((r) => [r.appId, r]));
  for (const c of cloud) {
    const cell = { web: c.webApp, mobile: c.mobileApp, behind: c.behind, codeBehind: c.codeBehind };
    const row = byId.get(c.appId);
    if (row) row.cloud = cell;
    else
      byId.set(c.appId, {
        appId: c.appId,
        name: c.name ?? c.appId,
        source: c.folder,
        // Unknown, not "not installed", while the data server is not answering.
        local: localKnown ? "not installed" : "unknown",
        cloud: cell,
      });
  }
  return [...byId.values()].sort((a, b) => a.appId.localeCompare(b.appId));
}

function tildePath(path: string | null): string {
  if (!path) return "—";
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export const listCommand: Command = {
  name: "list",
  summary: "List the apps discovery finds and the apps installed here",
  usage: "",
  lane: "none",
  flags: {},
  details:
    "The CLOUD column needs an open admin session (starkeep login --admin); without one it shows ?.\n" +
    "(behind) marks a cloud install whose manifest or web code differs from the folder here.",
  async run(io) {
    let { rows, localKnown } = await listRows();
    if (cloudInstalled()) {
      let cloud: CloudApp[] | null = null;
      try {
        cloud = await readCloudApps(io, { signIn: false });
      } catch (err) {
        io.warn(
          `Could not read the cloud's apps: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      rows = addCloud(rows, cloud, localKnown);
      if (cloud === null && !io.json)
        io.warn("Sign in with `starkeep login --admin` to see the CLOUD column.");
    }
    if (io.json) {
      io.event({ type: "result", ok: true, data: { apps: rows } });
      return;
    }
    if (rows.length === 0) {
      io.print("No apps. Add a folder with `starkeep source add <dir>`.");
      return;
    }
    const idWidth = Math.max(4, ...rows.map((r) => r.appId.length)) + 2;
    const srcWidth = Math.max(7, ...rows.map((r) => tildePath(r.source).length)) + 2;
    const withCloud = rows.some((r) => r.cloud !== undefined);
    const localWidth = Math.max(5, ...rows.map((r) => r.local.length)) + 2;
    io.print(
      `${"APP".padEnd(idWidth)}${"SOURCE".padEnd(srcWidth)}${withCloud ? "LOCAL".padEnd(localWidth) + "CLOUD" : "LOCAL"}`,
    );
    for (const r of rows) {
      const note = r.sourceState ? `  (folder ${r.sourceState})` : "";
      const local = withCloud ? r.local.padEnd(localWidth) + cloudCell(r) : r.local;
      io.print(`${r.appId.padEnd(idWidth)}${tildePath(r.source).padEnd(srcWidth)}${local}${note}`);
    }
  },
};

export const infoCommand: Command = {
  name: "info",
  summary: "Show one app's manifest, source and state",
  usage: "<app>",
  lane: "none",
  flags: {},
  async run(io, args) {
    if (args.positionals.length !== 1) throw usageError("Name one app: starkeep info <app>");
    const ref = args.positionals[0]!;
    const app = await resolveAppReference(io, ref);
    const registry = await readRegistry();
    const row = registry?.find((r) => r.appId === app.appId);
    const status = await serviceStatus(app.appId);
    const manifest = app.folder.manifest;
    const state = row?.sourceDir ? pinnedSourceState(row.sourceDir, row.manifest) : null;
    const data = {
      appId: app.appId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source: app.appDir,
      installed: registry === null ? null : row !== undefined,
      installedAt: row?.installedAt ?? null,
      running: status.running,
      port: status.port ?? null,
      sourceState: state?.sourceState ?? null,
    };
    if (io.json) {
      io.event({ type: "result", ok: true, data });
      return;
    }
    io.print(`${manifest.name ?? app.appId} (${app.appId}) ${manifest.version ?? ""}`.trim());
    if (manifest.description) io.print(manifest.description);
    io.print();
    io.print(`Source     ${tildePath(app.appDir)}`);
    io.print(
      `Local      ${data.installed === null ? "unknown (the data server is not answering)" : data.installed ? (status.running ? `running${status.port ? ` on http://localhost:${status.port}` : ""}` : "installed") : "not installed"}`,
    );
    if (state) io.print(`Folder     ${state.sourceState} since the install was approved`);
    io.print();
    for (const line of consentLines(row?.manifest ?? manifest, installCommandFor(app)))
      io.print(line);
  },
};

export const installCommand: Command = {
  name: "install",
  summary: "Install apps on this computer or in the cloud",
  usage: "<app>... (--local | --cloud | --web | --mobile)... [--yes] [--start]",
  lane: "target",
  flags: {
    ...TARGET_FLAGS,
    yes: { type: "boolean", short: "y", description: "Approve the consent text without asking." },
    start: { type: "boolean", description: "Start each app after it installs." },
  },
  details:
    "An app is an id from the discovery folders or a path to an app folder. Installing by path\n" +
    "adds the folder to discovery. A target flag is required, and flags combine: --local --cloud\n" +
    "installs in the cloud, then on this computer. A cloud install builds the bundle from the\n" +
    "folder here and needs no local install. Only cloud targets sign in as the admin.\n" +
    "A run without a terminal needs --yes.",
  async run(io, args) {
    const targets = targetsOf(args, "install");
    if (args.positionals.length === 0) throw usageError("Name at least one app to install.");
    if (targets.cloud) requireCloud();
    if (!flag(args, "yes")) requireTerminal(io, "Approve and install?", "--yes to approve");
    if (targets.local) await requireDataServer();
    const installed: string[] = [];
    const declined: string[] = [];
    const at = { ref: "", appId: "" };
    try {
      for (const ref of args.positionals) {
        at.ref = at.appId = ref;
        await installOne(io, args, targets, at, installed, declined);
      }
    } catch (err) {
      if (args.positionals.length === 1) throw err;
      const current = at.appId;
      const rest = args.positionals.slice(args.positionals.indexOf(at.ref) + 1);
      const message = err instanceof Error ? err.message : String(err);
      // An app that installed and then failed to start counts as installed.
      const notInstalled = [
        ...declined,
        ...(installed.includes(current) ? [] : [current]),
        ...rest,
      ];
      throw new CliError(
        [
          `${current}: ${message}`,
          `Installed: ${installed.length ? installed.join(", ") : "none"}.`,
          `Not installed: ${notInstalled.length ? notInstalled.join(", ") : "none"}.`,
        ].join("\n"),
        err instanceof CliError ? err.exitCode : 1,
        err instanceof CliError ? err.code : undefined,
        err instanceof CliError ? err.logPath : undefined,
        { installed, failed: current, notInstalled },
      );
    }
    io.event({ type: "result", ok: true, data: { installed, declined } });
  },
};

/** The target flags as one command line shows them, for the lock's holder record. */
function targetWords(targets: Targets): string {
  return [
    ...(targets.local ? ["--local"] : []),
    ...(targets.cloud === "all" ? ["--cloud"] : (targets.cloud ?? []).map((t) => `--${t}`)),
  ].join(" ");
}

async function installOne(
  io: Io,
  args: ParsedArgs,
  targets: Targets,
  at: { ref: string; appId: string },
  installed: string[],
  declined: string[],
): Promise<void> {
  const ref = at.ref;
  const app = await resolveAppReference(io, ref);
  at.appId = app.appId;
  if (!targets.local) {
    if (await approveCloudInstall(io, app, flag(args, "yes"))) {
      await installInCloud(io, app, targets.cloud!);
      installed.push(app.appId);
    } else {
      declined.push(app.appId);
    }
    return;
  }
  await withAppLock(app.appId, `starkeep install ${ref} ${targetWords(targets)}`, async () => {
    const manifest = app.folder.manifest;
    const name = manifest.name ?? app.appId;
    const install = installCommandFor(app);
    if (!io.json) {
      io.print();
      io.print(`Install ${name}?`);
      io.print();
      for (const line of consentLines(manifest, install)) io.print(line);
      io.print();
    } else {
      io.event({
        type: "prompt-needed",
        reason: "consent",
        detail: consentLines(manifest, install).join("\n"),
      });
    }
    if (!(await io.confirm("Approve and install?", { yes: flag(args, "yes") }))) {
      io.print(`Not installed: ${name}.`);
      declined.push(app.appId);
      return;
    }
    await runDependencyInstall(io, app.appId, install);
    // The cloud goes first, so this computer never runs a version the cloud
    // lacks, and a failed cloud step leaves this computer as it was.
    if (targets.cloud) await installInCloud(io, app, targets.cloud);
    io.event({ type: "progress", message: `Installing ${name} on this computer…` });
    const secretPath = await registerLocally(app);
    // A running app keeps the old manifest's behavior until it restarts.
    const wasRunning = (await serviceStatus(app.appId)).running;
    await stopById(app.appId);
    io.event({
      type: "progress",
      message: `Installed ${name}. Its credentials are in ${secretPath}.`,
    });
    installed.push(app.appId);
    const start =
      flag(args, "start") ||
      wasRunning ||
      (!io.json &&
        io.interactive() &&
        !flag(args, "yes") &&
        (await io.confirm(`Start ${name} now?`, { yes: false })));
    if (start && !(await startOne(io, app.appId))) {
      throw new CliError(
        `${name} installed but did not start. Run \`starkeep logs ${app.appId}\`.`,
      );
    }
  });
}

/** Show the consent words once for a cloud-only install, and ask. */
export async function approveCloudInstall(
  io: Io,
  app: ResolvedApp,
  yes: boolean,
): Promise<boolean> {
  const manifest = app.folder.manifest;
  const name = manifest.name ?? app.appId;
  const lines = consentLines(manifest, installCommandFor(app));
  if (!io.json) {
    io.print();
    io.print(`Install ${name} in the cloud?`);
    io.print();
    for (const line of lines) io.print(line);
    io.print();
  } else {
    io.event({ type: "prompt-needed", reason: "consent", detail: lines.join("\n") });
  }
  if (!(await io.confirm("Approve and install?", { yes }))) {
    io.print(`Not installed: ${name}.`);
    return false;
  }
  return true;
}

/**
 * Install `app`'s cloud surfaces. The operation deploys only the manifest the
 * person approved, so it receives that manifest's digest and refuses a folder
 * that changed since.
 */
export async function installInCloud(
  io: Io,
  app: ResolvedApp,
  cloud: "all" | AppSurface[],
): Promise<void> {
  await runCloud(io, {
    name: "install-cloud-app",
    input: {
      appId: app.appId,
      appDir: app.appDir,
      ...(cloud === "all" ? {} : { surfaces: cloud }),
      manifestDigest: manifestDigest(app.folder.manifest),
    },
    owner: surfaceOwner(app.appId, cloud),
    lock: `app-${app.appId}`,
    command: `starkeep install ${app.appId} --cloud`,
  });
}

export const uninstallCommand: Command = {
  name: "uninstall",
  summary: "Uninstall apps, keeping their data unless --delete-data",
  usage: "<app>... (--local | --cloud | --web | --mobile)... [--delete-data] [--yes]",
  lane: "target",
  flags: {
    ...TARGET_FLAGS,
    "delete-data": {
      type: "boolean",
      description:
        "Also delete the app's data (here with --local, in the cloud with --cloud). Asks for the app id typed back.",
    },
    yes: {
      type: "boolean",
      short: "y",
      description: "Skip the typed-back app id. Needed without a terminal.",
    },
  },
  details:
    "--cloud removes the app from the cloud entirely; --web or --mobile removes one surface and\n" +
    "keeps the data side. Uninstalling keeps the app's data, and a reinstall gets it back.\n" +
    "--delete-data deletes it too, after the app id is typed back (or --yes). In the cloud it\n" +
    "needs --cloud: the data side stays while any surface does.",
  async run(io, args) {
    const targets = targetsOf(args, "uninstall");
    if (args.positionals.length === 0) throw usageError("Name at least one app to uninstall.");
    const deleteData = flag(args, "delete-data");
    const typeBack = deleteData && !flag(args, "yes");
    if (deleteData && targets.cloud !== null && targets.cloud !== "all") {
      throw usageError(
        "--delete-data in the cloud needs --cloud: --web and --mobile keep the data side.",
      );
    }
    // The typed id guards the whole command, so a run that cannot ask stops
    // before the first change.
    if (targets.cloud) requireCloud();
    if (typeBack) requireTerminal(io, "Type the app id to delete its data.", TYPE_BACK_HINT);
    if (targets.local) await requireDataServer();
    const registry = targets.local ? await readRegistry() : null;
    for (const appId of args.positionals) {
      if (targets.local && registry && !deleteData && !registry.some((r) => r.appId === appId))
        throw new CliError(`${appId} is not installed on this computer.`);
      if (typeBack) {
        const here = targets.local && (!registry || registry.some((r) => r.appId === appId));
        await confirmDeletion(io, appId, targets, here);
      }
    }
    if (targets.cloud) {
      for (const appId of args.positionals)
        await uninstallFromCloud(io, appId, targets.cloud, deleteData);
    }
    if (!targets.local) {
      io.event({ type: "result", ok: true, data: { uninstalled: args.positionals } });
      return;
    }
    for (const appId of args.positionals) {
      await withAppLock(appId, `starkeep uninstall ${appId} --local`, async () => {
        const installed = !registry || registry.some((r) => r.appId === appId);
        if (installed) {
          io.event({ type: "progress", message: `Uninstalling ${appId}…` });
          const result = await uninstallLocalApp(appId);
          if (!result.ok) {
            throw new CliError(
              `Could not uninstall ${appId}: ${result.error}${result.detail ? ` (${result.detail})` : ""}`,
            );
          }
          io.event({
            type: "progress",
            message: deleteData
              ? `Uninstalled ${appId}.`
              : `Uninstalled ${appId}. Its data stays on this computer.`,
          });
        }
        if (deleteData) {
          const deleted = await deleteKeptAppData(appId, appId);
          if (!deleted.ok && /NoRetainedData/.test(deleted.error)) {
            io.event({ type: "progress", message: `${appId} kept no data on this computer.` });
          } else if (!deleted.ok) {
            throw new CliError(`Could not delete ${appId}'s data: ${deleted.error}`);
          } else {
            io.event({ type: "progress", message: `Deleted ${appId}'s data on this computer.` });
          }
        }
      });
    }
    io.event({ type: "result", ok: true, data: { uninstalled: args.positionals } });
  },
};
