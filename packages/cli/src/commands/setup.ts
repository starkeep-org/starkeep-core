/**
 * `starkeep setup` and `starkeep reset-local`.
 *
 * Setup on this computer: the wrapper has already run `pnpm install`, so setup
 * seeds the config, offers the bare `starkeep` command, and starts the data
 * server and Drive. `--cloud` then deploys a new cloud and `--join` joins one
 * that exists (`../setup/cloud.ts`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { daemonPort } from "@starkeep/operator/commands";
import { readConfigSeeded } from "@starkeep/operator/config";
import { stopById } from "@starkeep/operator/daemons";
import { repoRoot } from "@starkeep/operator/repo-root";
import { serviceStatus } from "@starkeep/operator/service-control";
import { adminSessionStatus } from "@starkeep/operator/admin-session";
import { localDataServerUrlFromEnv } from "@starkeep/operator/urls";
import { flag, type Command } from "../command";
import { CliError, usageError } from "../errors";
import type { Io } from "../io";
import { PLATFORM_SERVICES } from "../names";
import { startOne } from "./services";
import { loginAdmin, loginSync } from "./account";
import { approveCloudInstall, installInCloud } from "./apps";
import { readCloudApps, runCloud } from "../cloud";
import { resolveAppReference } from "../app-steps";
import { setupCloud, setupJoin, type CloudSetupDeps } from "../setup/cloud";
import { stringFlag } from "../command";

function wrapperPath(): string {
  return join(repoRoot(), "scripts", "starkeep.mjs");
}

/** Offer `~/.local/bin/starkeep`, so `starkeep …` works from any folder. */
async function offerLink(io: Io, yes: boolean): Promise<void> {
  const binDir = join(homedir(), ".local", "bin");
  const link = join(binDir, "starkeep");
  const shown = "~/.local/bin/starkeep";
  const target = wrapperPath();
  let current: string | null = null;
  try {
    if (lstatSync(link).isSymbolicLink()) current = readlinkSync(link);
    else {
      io.warn(`${shown} exists and is not a link; leaving it alone.`);
      return;
    }
  } catch {
    current = null;
  }
  if (current === target) {
    io.event({ type: "progress", message: `${shown} already runs this checkout's starkeep.` });
  } else {
    const question = current
      ? `${shown} points at ${current}. Point it at this checkout instead?`
      : `Link ${shown}, so \`starkeep\` works from any folder?`;
    if (!(await io.confirm(question, { yes, flagHint: "--yes or --no-link" }))) return;
    mkdirSync(binDir, { recursive: true });
    if (current !== null) spawnSync("rm", ["-f", link]);
    symlinkSync(target, link);
    io.event({ type: "progress", message: `Linked ${shown} → ${target}.` });
  }
  const onPath = (process.env.PATH ?? "").split(delimiter).includes(binDir);
  if (!onPath) {
    io.print("~/.local/bin is not on your PATH. Add this line to your shell profile:");
    io.print(`  export PATH="$HOME/.local/bin:$PATH"`);
  }
}

/** Restart the data server so it reads the cloud's address, or start it, and start Drive. */
async function startLocalServices(io: Io, restartDataServer: boolean): Promise<void> {
  const running = (await serviceStatus("local-data-server")).running;
  if (running && restartDataServer) {
    io.event({
      type: "progress",
      message: "Restarting the data server so it reads the new cloud…",
    });
    await stopById("local-data-server");
  }
  for (const id of PLATFORM_SERVICES) {
    if ((await serviceStatus(id)).running) continue;
    if (!(await startOne(io, id))) {
      throw new CliError(`${id} did not start. Run \`starkeep logs ${id}\`.`);
    }
  }
}

async function syncState(): Promise<string | null> {
  try {
    const res = await fetch(`${localDataServerUrlFromEnv()}/auth/status`);
    return res.ok ? (((await res.json()) as { state?: string }).state ?? null) : null;
  } catch {
    return null;
  }
}

async function dataServerCloudUrl(): Promise<string | null | undefined> {
  try {
    const res = await fetch(`${localDataServerUrlFromEnv()}/auth/status`);
    if (!res.ok) return undefined;
    return ((await res.json()) as { cloudUrl?: string | null }).cloudUrl ?? null;
  } catch {
    return undefined;
  }
}

const CLOUD_SETUP_DEPS: CloudSetupDeps = {
  owner: {},
  adminSignedIn: () => adminSessionStatus().signedIn,
  loginAdmin,
  loginSync,
  runCloud,
  cloudAppIds: async (io) =>
    (await readCloudApps(io, { signIn: true }))?.map((a) => a.appId) ?? null,
  syncState,
  dataServerCloudUrl,
  startLocalServices,
  installApps: async (io, refs, yes) => {
    for (const ref of refs) {
      const app = await resolveAppReference(io, ref);
      if (await approveCloudInstall(io, app, yes)) await installInCloud(io, app, "all");
    }
  },
};

/** Setup on this computer: the config, the link, and the data server and Drive. */
async function setupLocal(io: Io, yes: boolean, offer: boolean): Promise<string> {
  readConfigSeeded();
  io.event({ type: "progress", message: `Starkeep keeps its data in ${starkeepDir()}.` });
  if (offer) await offerLink(io, yes);
  let failed = 0;
  for (const id of PLATFORM_SERVICES) if (!(await startOne(io, id))) failed++;
  if (failed > 0)
    throw new CliError("Setup could not start every service. See the messages above.");
  return `http://localhost:${daemonPort("STARKEEP_ADMIN_PORT", 3000)}`;
}

export const setupCommand: Command = {
  name: "setup",
  summary: "Set Starkeep up on this computer, deploy a cloud, or join one",
  usage:
    "[--local] [--cloud --region <r> --name <n> --admin-email <e> [--prefix <p>] [--domain <d>] [--apps <a,b>]] [--join <address>] [--yes]",
  lane: "setup",
  flags: {
    local: { type: "boolean", description: "Set up the local services (the default)." },
    cloud: { type: "boolean", description: "Deploy a new cloud, or resume a setup that stopped." },
    join: { type: "string", description: "Join the cloud at this https address." },
    region: { type: "string", description: "The AWS region for a new cloud, such as us-east-2." },
    prefix: {
      type: "string",
      description: "The stack prefix every resource name starts with (default starkeep).",
    },
    name: {
      type: "string",
      description: "The deployment's name, under the star on the sign-in page.",
    },
    "admin-email": {
      type: "string",
      description: "The first admin's email. Cognito sends it a temporary password.",
    },
    domain: {
      type: "string",
      description: "A custom domain for the cloud, such as photos.example.com.",
    },
    apps: { type: "string", description: "Install these apps in the cloud too, comma-separated." },
    yes: { type: "boolean", short: "y", description: "Answer yes to every question." },
    "no-link": { type: "boolean", description: "Do not offer the ~/.local/bin/starkeep link." },
    "no-browser": {
      type: "boolean",
      description: "Print the sign-in addresses without opening a browser.",
    },
  },
  details:
    "Installs the workspace (the wrapper runs pnpm install first), starts the data server and Drive,\n" +
    "and offers a ~/.local/bin/starkeep link so the command works from any folder.\n\n" +
    "--cloud creates the bootstrap stack, signs the first admin in on the managed login page,\n" +
    "installs the cloud data server and Drive, and signs this computer in to sync. Each phase\n" +
    "checks whether it is done first, so running the command again resumes after a failure.\n\n" +
    "--join records an existing cloud's address and signs this computer in to sync.",
  async run(io, args) {
    const cloud = flag(args, "cloud");
    const join = stringFlag(args, "join");
    if (cloud && join !== undefined) throw usageError("Choose --cloud or --join, not both.");
    const yes = flag(args, "yes");
    const noBrowser = flag(args, "no-browser");
    const local = flag(args, "local") || (!cloud && join === undefined);
    let adminUrl: string | undefined;
    if (local) adminUrl = await setupLocal(io, yes, !flag(args, "no-link"));
    if (cloud) {
      const apps = (stringFlag(args, "apps") ?? "")
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const result = await setupCloud(
        io,
        {
          ...(stringFlag(args, "region") ? { region: stringFlag(args, "region")! } : {}),
          ...(stringFlag(args, "prefix") ? { prefix: stringFlag(args, "prefix")! } : {}),
          ...(stringFlag(args, "name") ? { name: stringFlag(args, "name")! } : {}),
          ...(stringFlag(args, "admin-email")
            ? { adminEmail: stringFlag(args, "admin-email")! }
            : {}),
          ...(stringFlag(args, "domain") !== undefined
            ? { domain: stringFlag(args, "domain")! }
            : {}),
          apps,
          yes,
          noBrowser,
        },
        CLOUD_SETUP_DEPS,
      );
      io.print();
      io.print("The cloud is set up, and this computer syncs with it.");
      io.print("  starkeep install <app> --cloud   installs an app in the cloud");
      io.print("  starkeep status                  shows what runs");
      io.event({ type: "result", ok: true, data: result });
      return;
    }
    if (join !== undefined) {
      const result = await setupJoin(io, join, CLOUD_SETUP_DEPS, { noBrowser });
      io.print();
      io.print(`This computer syncs with ${result.cloudUrl}.`);
      io.event({ type: "result", ok: true, data: result });
      return;
    }
    io.print();
    io.print("Starkeep runs on this computer.");
    io.print(`  starkeep admin     opens admin-web at ${adminUrl}`);
    io.print("  starkeep list      shows the apps you can install");
    io.print("  starkeep status    shows what runs");
    io.event({ type: "result", ok: true, data: { starkeepDir: starkeepDir(), adminUrl } });
  },
};

export const resetLocalCommand: Command = {
  name: "reset-local",
  summary: "Delete this computer's local data (files, database, watches)",
  usage: "[--apply]",
  lane: "none",
  flags: {
    apply: {
      type: "boolean",
      description: "Delete. Without it, the command only lists what it would delete.",
    },
  },
  details:
    "Keeps the config, credentials and the cloud. Stops the data server first and starts it again\n" +
    "afterward when it was running.",
  async run(io, args) {
    const dir = starkeepDir();
    const targets = [
      join(dir, "objects"),
      join(dir, "data.db"),
      join(dir, "data.db-wal"),
      join(dir, "data.db-shm"),
      join(dir, "watches.json"),
    ].filter((p) => existsSync(p));
    if (!flag(args, "apply")) {
      if (io.json) {
        io.event({ type: "result", ok: true, data: { wouldDelete: targets, applied: false } });
        return;
      }
      if (targets.length === 0) io.print(`Nothing to delete in ${dir}.`);
      else {
        io.print("Would delete:");
        for (const t of targets) io.print(`  ${t}`);
        io.print("Run `starkeep reset-local --apply` to delete them.");
      }
      return;
    }
    const wasRunning = (await serviceStatus("local-data-server")).running;
    if (wasRunning) {
      io.event({ type: "progress", message: "Stopping the data server…" });
      await stopById("local-data-server");
    }
    const result = spawnSync(
      "bash",
      [join(repoRoot(), "scripts", "reset-local-data.sh"), "--yes"],
      {
        env: { ...process.env, STARKEEP_DIR: dir },
        encoding: "utf8",
      },
    );
    for (const line of (result.stdout ?? "").split("\n"))
      if (line.trim()) io.event({ type: "log", line });
    if (result.status !== 0) {
      throw new CliError(`reset-local-data.sh failed: ${(result.stderr ?? "").trim()}`);
    }
    io.event({ type: "progress", message: `Deleted ${targets.length} item(s) in ${dir}.` });
    if (wasRunning && !(await startOne(io, "local-data-server"))) {
      throw new CliError("The data server did not start again. Run `starkeep logs data-server`.");
    }
    io.event({ type: "result", ok: true, data: { deleted: targets, applied: true } });
  },
};
