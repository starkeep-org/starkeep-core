/**
 * App commands on this computer: `source`, `list`, `info`, `install --local`
 * and `uninstall --local`. The cloud targets arrive with the cloud CLI; until
 * then the commands name admin-web for them.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expandHome } from "@starkeep/admin-installer/app-discovery";
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
import { CliError, EXIT_USAGE, usageError } from "../errors";
import type { Io } from "../io";
import {
  installCommandFor,
  registerLocally,
  requireDataServer,
  resolveAppReference,
  runDependencyInstall,
} from "../app-steps";
import { startOne } from "./services";

const TARGET_FLAGS = {
  local: { type: "boolean", description: "This computer." },
  cloud: {
    type: "boolean",
    description: "The cloud: the data side and every surface the manifest offers.",
  },
  web: { type: "boolean", description: "The cloud web app only." },
  mobile: { type: "boolean", description: "The mobile app only." },
} as const;

/**
 * The explicit target `install` and `uninstall` require. Only `--local` runs
 * from the CLI so far.
 */
function requireLocalTarget(args: ParsedArgs, verb: string): void {
  const cloud = ["cloud", "web", "mobile"].filter((f) => flag(args, f));
  if (cloud.length > 0) {
    throw new CliError(
      `Cloud ${verb}s do not run from the CLI yet. Run \`starkeep admin\` and use the Cloud apps section, or drop --${cloud.join(" --")}.`,
      EXIT_USAGE,
      "USAGE",
    );
  }
  if (!flag(args, "local")) {
    throw usageError(
      `Name where to ${verb}: --local (this computer). --cloud, --web and --mobile come later.`,
    );
  }
}

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
}

async function listRows(): Promise<ListRow[]> {
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
  return [...rows.values()].sort((a, b) => a.appId.localeCompare(b.appId));
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
  async run(io) {
    const rows = await listRows();
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
    io.print(`${"APP".padEnd(idWidth)}${"SOURCE".padEnd(srcWidth)}LOCAL`);
    for (const r of rows) {
      const note = r.sourceState ? `  (folder ${r.sourceState})` : "";
      io.print(
        `${r.appId.padEnd(idWidth)}${tildePath(r.source).padEnd(srcWidth)}${r.local}${note}`,
      );
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
  summary: "Install apps",
  usage: "<app>... --local [--yes] [--start]",
  lane: "none",
  flags: {
    ...TARGET_FLAGS,
    yes: { type: "boolean", short: "y", description: "Approve the consent text without asking." },
    start: { type: "boolean", description: "Start each app after it installs." },
  },
  details:
    "An app is an id from the discovery folders or a path to an app folder. Installing by path\n" +
    "adds the folder to discovery. A target flag is required. A run without a terminal needs --yes.",
  async run(io, args) {
    requireLocalTarget(args, "install");
    if (args.positionals.length === 0) throw usageError("Name at least one app to install.");
    await requireDataServer();
    const installed: string[] = [];
    for (const ref of args.positionals) {
      const app = await resolveAppReference(io, ref);
      await withAppLock(app.appId, `starkeep install ${ref} --local`, async () => {
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
          return;
        }
        await runDependencyInstall(io, app.appId, install);
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
    io.event({ type: "result", ok: true, data: { installed } });
  },
};

export const uninstallCommand: Command = {
  name: "uninstall",
  summary: "Uninstall apps, keeping their data unless --delete-data",
  usage: "<app>... --local [--delete-data] [--yes]",
  lane: "none",
  flags: {
    ...TARGET_FLAGS,
    "delete-data": {
      type: "boolean",
      description: "Also delete the app's data on this computer. Asks for the app id typed back.",
    },
    yes: {
      type: "boolean",
      short: "y",
      description: "Skip the typed-back app id. Needed without a terminal.",
    },
  },
  async run(io, args) {
    requireLocalTarget(args, "uninstall");
    if (args.positionals.length === 0) throw usageError("Name at least one app to uninstall.");
    await requireDataServer();
    const registry = await readRegistry();
    for (const appId of args.positionals) {
      await withAppLock(appId, `starkeep uninstall ${appId} --local`, async () => {
        if (registry && !registry.some((r) => r.appId === appId)) {
          if (!flag(args, "delete-data"))
            throw new CliError(`${appId} is not installed on this computer.`);
        } else {
          io.event({ type: "progress", message: `Uninstalling ${appId}…` });
          const result = await uninstallLocalApp(appId);
          if (!result.ok) {
            throw new CliError(
              `Could not uninstall ${appId}: ${result.error}${result.detail ? ` (${result.detail})` : ""}`,
            );
          }
          io.event({
            type: "progress",
            message: `Uninstalled ${appId}. Its data stays on this computer.`,
          });
        }
        if (flag(args, "delete-data")) {
          let confirm = appId;
          if (!flag(args, "yes")) {
            confirm = await io.ask(`Type ${appId} to delete its data on this computer:`, {
              flagHint: "--yes to delete without typing the app id",
            });
          }
          if (confirm !== appId)
            throw new CliError(`Kept ${appId}'s data: the typed id did not match.`);
          const deleted = await deleteKeptAppData(appId, confirm);
          if (!deleted.ok) throw new CliError(`Could not delete ${appId}'s data: ${deleted.error}`);
          io.event({ type: "progress", message: `Deleted ${appId}'s data on this computer.` });
        }
      });
    }
    io.event({ type: "result", ok: true, data: { uninstalled: args.positionals } });
  },
};
