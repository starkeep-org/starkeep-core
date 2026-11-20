/**
 * Local services: `start`, `stop`, `restart`, `status`, `logs` and `admin`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRegistry } from "@starkeep/operator/apps";
import { daemonPort } from "@starkeep/operator/commands";
import { readConfig } from "@starkeep/operator/config";
import { PIDS_DIR, spawnDaemon, stopById } from "@starkeep/operator/daemons";
import { repoRoot } from "@starkeep/operator/repo-root";
import { serviceStatus, startService } from "@starkeep/operator/service-control";
import { recordWanted, wantedServices } from "@starkeep/operator/services";
import { localDataServerUrlFromEnv } from "@starkeep/operator/urls";
import { adminSessionStatus } from "@starkeep/operator/admin-session";
import { flag, type Command } from "../command";
import { adminStatusLine } from "./account";
import { CliError, usageError } from "../errors";
import type { Io } from "../io";
import { PLATFORM_SERVICES, displayName, serviceId, startOrder } from "../names";

/** The ids `start` with no names brings up: what the person left running, or the platform. */
function defaultStartSet(): string[] {
  const wanted = wantedServices();
  return startOrder([...PLATFORM_SERVICES, ...wanted]);
}

/**
 * Every id with a pid record, so `stop` with no names finds apps admin-web
 * started. admin-web itself has a record when `starkeep admin` started it.
 */
function recordedIds(options: { includeAdmin: boolean }): string[] {
  if (!existsSync(PIDS_DIR)) return [];
  return readdirSync(PIDS_DIR)
    .filter((f) => f.endsWith(".pid"))
    .map((f) => f.slice(0, -".pid".length))
    .filter((id) => options.includeAdmin || id !== "admin-web");
}

/** Why an app cannot start because this computer has not installed it, or null. */
async function notInstalled(id: string): Promise<string | null> {
  if ((PLATFORM_SERVICES as readonly string[]).includes(id)) return null;
  const registry = await readRegistry();
  if (registry === null) {
    return `The local data server is not answering, so ${id} cannot start. Run \`starkeep start data-server\` first.`;
  }
  return registry.some((r) => r.appId === id)
    ? null
    : `${id} is not installed on this computer. Run \`starkeep install ${id} --local\`.`;
}

export async function startOne(io: Io, id: string): Promise<boolean> {
  const name = displayName(id);
  const missing = await notInstalled(id);
  if (missing) {
    io.warn(missing);
    return false;
  }
  io.event({ type: "progress", message: `Starting ${name}…` });
  const outcome = await startService(id);
  if (outcome.ok) {
    recordWanted(id, true);
    const where = outcome.port ? ` on http://localhost:${outcome.port}` : "";
    io.event({
      type: "progress",
      message: outcome.adopted
        ? `${name} was already running${where}.`
        : `Started ${name}${where}.`,
    });
    return true;
  }
  // An app that already runs is what the person asked for.
  if (outcome.status === 409 && /already running/.test(outcome.error)) {
    recordWanted(id, true);
    io.event({ type: "progress", message: outcome.error });
    return true;
  }
  io.warn(`Could not start ${name}: ${outcome.error}`);
  return false;
}

async function stopOne(io: Io, id: string, record: boolean): Promise<void> {
  const name = displayName(id);
  const result = await stopById(id);
  if (record) recordWanted(id, false);
  if (result.stopped) io.event({ type: "progress", message: `Stopped ${name}.` });
  else if (result.error && !/^Not running/.test(result.error)) {
    throw new CliError(`Could not stop ${name}: ${result.error}`);
  } else io.event({ type: "progress", message: `${name} was not running.` });
}

export const startCommand: Command = {
  name: "start",
  summary: "Start the data server, Drive and apps",
  usage: "[<name>...]",
  lane: "none",
  flags: {},
  details:
    "Names are data-server, drive, or an installed app's id. With no names, starts the data\n" +
    "server, Drive and every app marked to run. Starting an app marks it to run.",
  async run(io, args) {
    const ids = args.positionals.length
      ? startOrder(args.positionals.map(serviceId))
      : defaultStartSet();
    let failed = 0;
    for (const id of ids) if (!(await startOne(io, id))) failed++;
    if (failed > 0) throw new CliError(`${failed} of ${ids.length} services did not start.`);
    io.event({ type: "result", ok: true, data: { started: ids } });
  },
};

export const stopCommand: Command = {
  name: "stop",
  summary: "Stop services and apps",
  usage: "[<name>...]",
  lane: "none",
  flags: {},
  details:
    "Stopping a named app clears its mark to run. With no names, stops everything running\n" +
    "and keeps the marks, so `starkeep start` brings the same set back.",
  async run(io, args) {
    const named = args.positionals.length > 0;
    const ids = named
      ? args.positionals.map(serviceId)
      : startOrder([
          ...recordedIds({ includeAdmin: false }),
          ...wantedServices(),
          ...PLATFORM_SERVICES,
        ]);
    // admin-web first, then apps, the data server last, so nothing loses its
    // server mid-request.
    const order = [...ids].reverse();
    if (!named && recordedIds({ includeAdmin: true }).includes("admin-web"))
      order.unshift("admin-web");
    for (const id of order) await stopOne(io, id, named);
    io.event({ type: "result", ok: true, data: { stopped: ids } });
  },
};

export const restartCommand: Command = {
  name: "restart",
  summary: "Stop and start services and apps",
  usage: "[<name>...]",
  lane: "none",
  flags: {},
  async run(io, args) {
    const ids = args.positionals.length
      ? startOrder(args.positionals.map(serviceId))
      : defaultStartSet();
    for (const id of [...ids].reverse()) await stopOne(io, id, false);
    let failed = 0;
    for (const id of ids) if (!(await startOne(io, id))) failed++;
    if (failed > 0) throw new CliError(`${failed} of ${ids.length} services did not start.`);
    io.event({ type: "result", ok: true, data: { restarted: ids } });
  },
};

interface SyncStatus {
  cloudUrl: string | null;
  state: string;
  email: string | null;
}

async function syncStatus(): Promise<SyncStatus | null> {
  try {
    const res = await fetch(`${localDataServerUrlFromEnv()}/auth/status`);
    return res.ok ? ((await res.json()) as SyncStatus) : null;
  } catch {
    return null;
  }
}

export const statusCommand: Command = {
  name: "status",
  summary: "Show what runs on this computer and its sync sign-in",
  usage: "",
  lane: "none",
  flags: {},
  async run(io) {
    const ids = startOrder([
      ...PLATFORM_SERVICES,
      ...wantedServices(),
      ...recordedIds({ includeAdmin: false }),
    ]);
    const wanted = new Set(wantedServices());
    const services = [];
    for (const id of ids) {
      const status = await serviceStatus(id);
      services.push({ name: displayName(id), wanted: wanted.has(id), ...status });
    }
    const admin = await serviceStatus("admin-web");
    const sync = await syncStatus();
    const config = readConfig();
    const cloudUrl =
      sync?.cloudUrl ?? (typeof config?.cloudUrl === "string" ? config.cloudUrl : null);

    if (io.json) {
      io.event({
        type: "result",
        ok: true,
        data: { services, adminWeb: admin, sync, cloudUrl, adminSession: adminSessionStatus() },
      });
      return;
    }
    const width = Math.max(...services.map((s) => s.name.length), "admin-web".length) + 2;
    io.print("SERVICES");
    for (const s of services) {
      const state = s.running
        ? `running${s.port ? `  http://localhost:${s.port}` : ""}`
        : "stopped";
      const mark = !s.running && s.wanted ? "  (marked to run)" : "";
      io.print(`  ${s.name.padEnd(width)}${state}${mark}`);
    }
    io.print(
      `  ${"admin-web".padEnd(width)}${admin.running ? `running  http://localhost:${admin.port ?? adminPort()}` : "stopped"}`,
    );
    io.print();
    io.print(`CLOUD     ${cloudUrl ?? "not joined"}`);
    if (!sync) io.print("SYNC      unknown (the data server is not answering)");
    else if (sync.state === "signed-in") io.print(`SYNC      signed in as ${sync.email}`);
    else if (sync.state === "connecting") io.print(`SYNC      connecting as ${sync.email}`);
    else if (sync.state === "bound-elsewhere")
      io.print(`SYNC      this library belongs to another account (${sync.email})`);
    else io.print("SYNC      signed out");
    if (cloudUrl) io.print(`ADMIN     ${adminStatusLine()}`);
  },
};

export const logsCommand: Command = {
  name: "logs",
  summary: "Print a service's or app's log",
  usage: "<name> [-f]",
  lane: "none",
  flags: {
    follow: { type: "boolean", short: "f", description: "Keep printing new lines." },
    lines: {
      type: "string",
      short: "n",
      description: "How many lines to print first (default 50).",
    },
  },
  async run(io, args) {
    if (args.positionals.length !== 1)
      throw usageError("Name one service or app: starkeep logs <name>");
    const id = serviceId(args.positionals[0]!);
    const path = join(PIDS_DIR, `${id}.log`);
    if (io.json) {
      throw usageError(`starkeep logs prints text only. A script can read the log file: ${path}`);
    }
    if (!existsSync(path)) {
      throw new CliError(`No log for ${displayName(id)} at ${path}. It has not been started here.`);
    }
    const lines = typeof args.flags.lines === "string" ? args.flags.lines : "50";
    if (!/^\d+$/.test(lines)) throw usageError("--lines takes a number");
    const tailArgs = ["-n", lines, ...(flag(args, "follow") ? ["-f"] : []), path];
    await new Promise<void>((done, fail) => {
      const child = spawn("tail", tailArgs, { stdio: "inherit" });
      child.on("error", fail);
      child.on("exit", () => done());
      // Ctrl-C ends `tail -f`; the CLI then exits with it.
    });
  },
};

function adminPort(): number {
  return daemonPort("STARKEEP_ADMIN_PORT", 3000);
}

function openInBrowser(url: string): boolean {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const result = spawnSync(opener, [url], { stdio: "ignore" });
  return result.status === 0;
}

export const adminCommand: Command = {
  name: "admin",
  summary: "Start admin-web and open it in the browser",
  usage: "[--no-open]",
  lane: "none",
  flags: {
    "no-open": { type: "boolean", description: "Start admin-web without opening a browser." },
  },
  async run(io, args) {
    const port = adminPort();
    const url = `http://localhost:${port}`;
    const status = await serviceStatus("admin-web");
    if (!status.running) {
      io.event({ type: "progress", message: "Starting admin-web…" });
      const outcome = await spawnDaemon({
        id: "admin-web",
        command: "pnpm",
        args: ["--filter", "admin-web", "start"],
        cwd: repoRoot(),
        port,
      });
      if (!outcome.ok)
        throw new CliError(
          `admin-web did not start: ${outcome.error}`,
          1,
          undefined,
          outcome.logPath,
        );
    }
    io.event({ type: "progress", message: `admin-web runs at ${url}` });
    if (!flag(args, "no-open") && !io.json && !openInBrowser(url)) {
      io.print(`Open ${url} in your browser.`);
    }
    io.event({ type: "result", ok: true, data: { url } });
  },
};
