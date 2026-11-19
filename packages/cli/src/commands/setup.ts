/**
 * `starkeep setup` and `starkeep reset-local`.
 *
 * Setup on this computer: the wrapper has already run `pnpm install`, so setup
 * seeds the config, offers the bare `starkeep` command, and starts the data
 * server and Drive. Cloud setup and joining an existing cloud run from
 * admin-web until the cloud CLI arrives.
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
import { flag, type Command } from "../command";
import { CliError, EXIT_USAGE } from "../errors";
import type { Io } from "../io";
import { PLATFORM_SERVICES } from "../names";
import { startOne } from "./services";

function wrapperPath(): string {
  return join(repoRoot(), "scripts", "starkeep.mjs");
}

/** Offer `~/.local/bin/starkeep`, so `starkeep …` works from any folder. */
async function offerLink(io: Io, yes: boolean): Promise<void> {
  const binDir = join(homedir(), ".local", "bin");
  const link = join(binDir, "starkeep");
  const target = wrapperPath();
  let current: string | null = null;
  try {
    if (lstatSync(link).isSymbolicLink()) current = readlinkSync(link);
    else {
      io.warn(`${link} exists and is not a link; leaving it alone.`);
      return;
    }
  } catch {
    current = null;
  }
  if (current === target) {
    io.event({ type: "progress", message: `${link} already runs this checkout's starkeep.` });
  } else {
    const question = current
      ? `${link} points at ${current}. Point it at this checkout instead?`
      : `Link ${link}, so \`starkeep\` works from any folder?`;
    if (!(await io.confirm(question, { yes, flagHint: "--yes or --no-link" }))) return;
    mkdirSync(binDir, { recursive: true });
    if (current !== null) spawnSync("rm", ["-f", link]);
    symlinkSync(target, link);
    io.event({ type: "progress", message: `Linked ${link} → ${target}.` });
  }
  const onPath = (process.env.PATH ?? "").split(delimiter).includes(binDir);
  if (!onPath) {
    io.print(`${binDir} is not on your PATH. Add this line to your shell profile:`);
    io.print(`  export PATH="$HOME/.local/bin:$PATH"`);
  }
}

export const setupCommand: Command = {
  name: "setup",
  summary: "Set Starkeep up on this computer",
  usage: "[--local] [--yes] [--no-link]",
  lane: "none",
  flags: {
    local: { type: "boolean", description: "Set up the local services (the default)." },
    cloud: { type: "boolean", description: "Deploy a new cloud. Runs from admin-web for now." },
    join: { type: "string", description: "Join an existing cloud. Runs from admin-web for now." },
    yes: { type: "boolean", short: "y", description: "Answer yes to every question." },
    "no-link": { type: "boolean", description: "Do not offer the ~/.local/bin/starkeep link." },
  },
  details:
    "Installs the workspace (the wrapper runs pnpm install first), starts the data server and Drive,\n" +
    "and offers a ~/.local/bin/starkeep link so the command works from any folder.",
  async run(io, args) {
    if (flag(args, "cloud") || args.flags.join !== undefined) {
      throw new CliError(
        "Cloud setup and joining a cloud run from admin-web for now. Run `starkeep setup --local`, then `starkeep admin`, and open Cloud setup.",
        EXIT_USAGE,
        "USAGE",
      );
    }
    const yes = flag(args, "yes");
    readConfigSeeded();
    io.event({ type: "progress", message: `Starkeep keeps its data in ${starkeepDir()}.` });
    if (!flag(args, "no-link")) await offerLink(io, yes);
    let failed = 0;
    for (const id of PLATFORM_SERVICES) if (!(await startOne(io, id))) failed++;
    if (failed > 0)
      throw new CliError("Setup could not start every service. See the messages above.");
    const adminUrl = `http://localhost:${daemonPort("STARKEEP_ADMIN_PORT", 3000)}`;
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
