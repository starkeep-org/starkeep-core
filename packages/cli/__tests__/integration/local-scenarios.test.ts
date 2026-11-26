/**
 * The local CLI's scenarios, end to end: setup, discovery folders, install,
 * start and stop, status, logs, update and uninstall, against a throwaway
 * Starkeep instance and stand-in apps in git repositories.
 *
 * Tests run in order and build on each other's state, as a person's session
 * would. Commands that need a person's answers run in this process with typed
 * answers; the rest run through the wrapper with no terminal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECKOUT,
  answering,
  dataDir,
  git,
  portOf,
  result,
  root,
  served,
  standInRepo,
  starkeep,
  writeStandIn,
  type StandInRepo,
} from "./harness";

const apps = join(root, "apps");
let dice: StandInRepo;
let notes: StandInRepo;
const solo = join(root, "solo");
const holders: ChildProcess[] = [];

beforeAll(() => {
  dice = standInRepo(apps, "dice");
  notes = standInRepo(apps, "notes", { reads: ["video/mp4"] });
  writeStandIn(join(apps, "todo"), "todo");
  writeStandIn(join(apps, "spare"), "spare");
  mkdirSync(join(apps, "broken"));
  writeFileSync(join(apps, "broken", "starkeep.manifest.json"), '{"id": "broken"}');
  writeStandIn(solo, "solo");
});

afterAll(() => {
  for (const h of holders) h.kill();
  starkeep(["stop"]);
  rmSync(root, { recursive: true, force: true });
});

function holdPort(port: number): Promise<Server> {
  return new Promise((done) => {
    const server = createServer().listen(port, "127.0.0.1", () => done(server));
  });
}

describe("setup", () => {
  it("starts the data server and Drive and names the next steps (CLI-010)", () => {
    const run = starkeep(["setup", "--local", "--yes", "--no-link", "--no-install"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Starkeep keeps its data in ${dataDir}.`);
    expect(run.out).toMatch(/Started data-server on http:\/\/localhost:\d+\./);
    expect(run.out).toMatch(/Started drive on http:\/\/localhost:\d+\./);
    expect(run.out).toContain("Starkeep runs on this computer.");
    for (const line of ["starkeep admin", "starkeep list", "starkeep status"])
      expect(run.out).toContain(line);
  });
});

describe("the ~/.local/bin link", () => {
  const home = join(root, "home");
  const link = join(home, ".local", "bin", "starkeep");
  const wrapper = join(CHECKOUT, "scripts", "starkeep.mjs");
  let realHome: string | undefined;
  beforeAll(() => {
    mkdirSync(home, { recursive: true });
    realHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterAll(() => {
    process.env.HOME = realHome;
  });

  it("asks before it links, and names the PATH line when ~/.local/bin is missing from PATH (CLI-011, CLI-012)", async () => {
    const run = await answering(["setup", "--local"], ["y"]);
    expect(run.code, run.err).toBe(0);
    expect(run.err).toContain(
      "Link ~/.local/bin/starkeep, so `starkeep` works from any folder? [y/N]",
    );
    expect(run.out).toContain(`Linked ~/.local/bin/starkeep → ${wrapper}.`);
    expect(readlinkSync(link)).toBe(wrapper);
    expect(run.out).toContain(
      "~/.local/bin is not on your PATH. Add this line to your shell profile:",
    );
    expect(run.out).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it("asks before moving a link that points at another checkout, and a no keeps it (CLI-014)", async () => {
    rmSync(link);
    symlinkSync("/elsewhere/scripts/starkeep.mjs", link);
    const run = await answering(["setup", "--local"], ["n"]);
    expect(run.code, run.err).toBe(0);
    expect(run.err).toContain(
      "~/.local/bin/starkeep points at /elsewhere/scripts/starkeep.mjs. Point it at this checkout instead? [y/N]",
    );
    expect(readlinkSync(link)).toBe("/elsewhere/scripts/starkeep.mjs");
  });

  it("leaves a file of the person's own alone (CLI-013)", async () => {
    rmSync(link);
    writeFileSync(link, "mine\n");
    const run = await answering(["setup", "--local"], []);
    expect(run.code, run.err).toBe(0);
    expect(run.err).toContain("~/.local/bin/starkeep exists and is not a link; leaving it alone.");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf8")).toBe("mine\n");
  });

  it("stops with status 3 at the link question without a terminal, and names the flags", () => {
    rmSync(link);
    const run = starkeep(["setup", "--local", "--no-install"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain(
      "No terminal is attached to answer. Pass --yes or --no-link to approve.",
    );
    expect(existsSync(link)).toBe(false);
  });
});

describe("discovery folders", () => {
  it("says how to add a folder when there is none, and the list says there are no apps (APP-LIFE-216, APP-LIFE-229)", () => {
    const dirs = result(starkeep(["source", "list", "--json"]).out).data!.dirs as Array<{
      dir: string;
    }>;
    for (const d of dirs) expect(starkeep(["source", "remove", d.dir]).code).toBe(0);
    expect(starkeep(["source", "list"]).out).toContain(
      "No discovery folders. Add one with `starkeep source add <dir>`.",
    );
    expect(starkeep(["list"]).out).toContain(
      "No apps. Add a folder with `starkeep source add <dir>`.",
    );
  });

  it("adds a folder and shows its apps and the skipped subfolder (APP-LIFE-213)", () => {
    const run = starkeep(["source", "add", apps]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(apps);
    expect(run.out).toMatch(/ {2}dice +Dice/);
    expect(run.out).toMatch(/ {2}notes +Notes/);
    expect(run.out).toMatch(/skipped: .*broken/);
  });

  it("refuses a path that is not a folder, or a folder it does not list (APP-LIFE-215)", () => {
    const before = starkeep(["source", "list", "--json"]).out;
    const missing = join(root, "nowhere");
    const add = starkeep(["source", "add", missing]);
    expect(add.code).toBe(1);
    expect(add.err).toContain(`${missing} is not a folder.`);
    const remove = starkeep(["source", "remove", solo]);
    expect(remove.code).toBe(1);
    expect(remove.err).toContain(`${solo} is not a discovery folder.`);
    expect(starkeep(["source", "list", "--json"]).out).toBe(before);
  });

  it("lists the folders with their apps (APP-LIFE-214)", () => {
    const run = starkeep(["source", "list"]);
    expect(run.out).toContain(apps);
    expect(run.out).toMatch(/ {2}dice +Dice/);
  });
});

describe("install", () => {
  it("names how to make an unknown app findable (APP-LIFE-219)", () => {
    const run = starkeep(["install", "ghost", "--local", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      'No app "ghost" in the discovery folders. Add its folder with `starkeep source add <dir>`, or install it by path.',
    );
  });

  it("shows the consent words, asks to start the app, and starts it (APP-LIFE-217)", async () => {
    const run = await answering(["install", "dice", "--local"], ["y", "y"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("Install Dice?");
    expect(run.out).toContain("png");
    expect(run.err).toContain("Approve and install? [y/N]");
    expect(run.err).toContain("Start Dice now? [y/N]");
    expect(run.out).toMatch(/Started dice on http:\/\/localhost:\d+\./);
    expect(await served(portOf("dice")!)).toBe("v1");
  });

  it("installs by path, adds the folder to discovery, and starts by id afterward (APP-LIFE-218)", () => {
    const run = starkeep(["install", solo, "--local", "--yes"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Added ${solo} to the discovery folders.`);
    expect(starkeep(["start", "solo"]).code).toBe(0);
    expect(starkeep(["stop", "solo"]).code).toBe(0);
  });

  it("installs the app in the folder the command ran in (CLI-016)", () => {
    const here = join(root, "here");
    writeStandIn(here, "here");
    const run = starkeep(["install", ".", "--local", "--yes", "--json"], { cwd: here });
    expect(run.code, run.err).toBe(0);
    expect(result(run.out).data).toMatchObject({ installed: ["here"] });
  });

  it("names what installed and what did not when a later app fails", () => {
    const run = starkeep(["install", "notes", "ghost", "--local", "--yes", "--json"]);
    expect(run.code).toBe(1);
    const res = result(run.out);
    expect(res.data).toMatchObject({
      installed: ["notes"],
      failed: "ghost",
      notInstalled: ["ghost"],
    });
    expect(res.error!.message).toContain("Installed: notes.");
    expect(res.error!.message).toContain("Not installed: ghost.");
  });

  it("installs several apps, each after its consent words (APP-LIFE-221)", () => {
    const run = starkeep(["install", "todo", "notes", "--local", "--yes"]);
    expect(run.code, run.err).toBe(0);
    const todoAt = run.out.indexOf("Install Todo?");
    const notesAt = run.out.indexOf("Install Notes?");
    expect(todoAt).toBeGreaterThanOrEqual(0);
    expect(notesAt).toBeGreaterThan(todoAt);
    expect(run.out.indexOf("Installed Todo.")).toBeGreaterThan(todoAt);
    expect(run.out.indexOf("Installed Todo.")).toBeLessThan(notesAt);
    expect(run.out).toContain("mp4");
  });

  it("leaves an app whose dependency install fails uninstalled, and names the log (APP-LIFE-222)", () => {
    const failing = join(root, "failing");
    writeStandIn(failing, "failing", {
      packageJson: { scripts: { preinstall: "echo failing-preinstall-ran && exit 7" } },
    });
    const run = starkeep(["install", failing, "--local", "--yes"]);
    expect(run.code).toBe(1);
    const match = /The dependency install failed \(npm install exited \d+\)\. See (\S+)\.\n/.exec(
      run.err,
    );
    expect(match, run.err).not.toBeNull();
    expect(match![1]!.startsWith(join(dataDir, "logs"))).toBe(true);
    expect(readFileSync(match![1]!, "utf8")).toContain("failing-preinstall-ran");
    const list = result(starkeep(["list", "--json"]).out).data!.apps as Array<{
      appId: string;
      local: string;
    }>;
    expect(list.find((a) => a.appId === "failing")?.local).toBe("not installed");
  });

  it("shows a step's own output only with --verbose (CLI-025)", () => {
    const chatty = join(root, "chatty");
    writeStandIn(chatty, "chatty", {
      packageJson: { scripts: { postinstall: "echo chatty-says-hi" } },
    });
    const quiet = starkeep(["install", chatty, "--local", "--yes"]);
    expect(quiet.code, quiet.err).toBe(0);
    expect(quiet.out).toContain(`Installing dependencies (npm install in ${chatty})…`);
    expect(quiet.out).not.toContain("chatty-says-hi");
    const loud = starkeep(["install", "chatty", "--local", "--yes", "--verbose"]);
    expect(loud.code, loud.err).toBe(0);
    expect(loud.out).toMatch(/\n {2}.*chatty-says-hi/);
  });

  it("reinstalls a running app and starts it on the new folder (APP-LIFE-220)", async () => {
    writeFileSync(join(dice.clone, "VERSION"), "v1-edited\n");
    const manifest = JSON.parse(
      readFileSync(join(dice.clone, "starkeep.manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(
      join(dice.clone, "starkeep.manifest.json"),
      JSON.stringify({ ...manifest, version: "0.1.1" }, null, 2),
    );
    try {
      const run = starkeep(["install", "dice", "--local", "--yes"]);
      expect(run.code, run.err).toBe(0);
      expect(run.out.indexOf("Installed Dice.")).toBeLessThan(run.out.indexOf("Started dice on"));
      expect(await served(portOf("dice")!)).toBe("v1-edited");
    } finally {
      git(dice.clone, "checkout", "--", ".");
      expect(starkeep(["install", "dice", "--local", "--yes"]).code).toBe(0);
    }
  });
});

describe("the app lock", () => {
  it("refuses a second operation while a live process holds the app (APP-LIFE-223)", () => {
    const holder = spawn("sleep", ["60"]);
    holders.push(holder);
    mkdirSync(join(dataDir, "locks"), { recursive: true });
    writeFileSync(
      join(dataDir, "locks", "app-dice.lock"),
      JSON.stringify({ pid: holder.pid, command: "starkeep install dice --local", since: "now" }),
    );
    const run = starkeep(["uninstall", "dice", "--local"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      `Another operation on dice is running (pid ${holder.pid}: starkeep install dice --local). Try again once it ends.`,
    );
    const list = result(starkeep(["list", "--json"]).out).data!.apps as Array<{
      appId: string;
      local: string;
    }>;
    expect(list.find((a) => a.appId === "dice")?.local).toBe("running");
  });

  it("takes over a lock whose holder died (APP-LIFE-224)", async () => {
    holders.pop()!.kill();
    await new Promise((r) => setTimeout(r, 200));
    const run = starkeep(["install", "dice", "--local", "--yes"]);
    expect(run.code, run.err).toBe(0);
    expect(run.err).not.toContain("Another operation");
  });
});

describe("list and info", () => {
  it("shows each app's id, folder and local state (APP-LIFE-225)", () => {
    expect(starkeep(["stop", "notes"]).code).toBe(0);
    const run = starkeep(["list"]);
    expect(run.out).toMatch(/^APP +SOURCE +LOCAL/m);
    expect(run.out).toMatch(/^dice +\S+ +running/m);
    expect(run.out).toMatch(/^notes +\S+ +installed/m);
    expect(run.out).toMatch(/^spare +\S+ +not installed/m);
  });

  it("marks an installed app whose folder changed since the install (APP-LIFE-226)", () => {
    const path = join(notes.clone, "starkeep.manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...manifest, version: "0.2.0" }, null, 2));
    try {
      expect(starkeep(["list"]).out).toMatch(/^notes .*\(folder changed\)$/m);
    } finally {
      git(notes.clone, "checkout", "--", ".");
    }
  });

  it("shows one app's description, source, state and consent words (APP-LIFE-230)", () => {
    const run = starkeep(["info", "dice"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("Dice (dice) 0.1.0");
    expect(run.out).toContain("The dice stand-in app.");
    expect(run.out).toMatch(/Source +\S*apps\/dice/);
    expect(run.out).toMatch(/Local +running on http:\/\/localhost:\d+/);
    expect(run.out).toContain("png");
  });
});

describe("start, stop and status", () => {
  it("refuses to start an app this computer has not installed (APP-LIFE-265)", () => {
    const run = starkeep(["start", "spare"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      "spare is not installed on this computer. Run `starkeep install spare --local`.",
    );
    expect(portOf("spare")).toBeNull();
  });

  it("prints JSON progress lines and a result with the started names (CLI-022)", () => {
    const run = starkeep(["start", "dice", "--json"]);
    expect(run.code, run.err).toBe(0);
    const lines = run.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.slice(0, -1).every((l) => l.type === "progress")).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "result", ok: true, data: { started: ["dice"] } });
  });

  it("stops everything in reverse order and brings the same set back (LDS-107, LDS-105, APP-LIFE-227)", () => {
    const stop = starkeep(["stop"]);
    expect(stop.code, stop.err).toBe(0);
    const order = ["Stopped dice.", "Stopped drive.", "Stopped data-server."].map((l) =>
      stop.out.indexOf(l),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const start = starkeep(["start"]);
    expect(start.code, start.err).toBe(0);
    const started = [/Started data-server on/, /Started drive on/, /Started dice on/].map((re) =>
      start.out.search(re),
    );
    expect(started.every((i) => i >= 0)).toBe(true);
    expect([...started].sort((a, b) => a - b)).toEqual(started);
  });

  it("says an app already runs when it does (LDS-106)", () => {
    const run = starkeep(["start", "data-server"]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/data-server was already running on http:\/\/localhost:\d+\./);
  });

  it("clears the mark when an app stops by name (APP-LIFE-227)", () => {
    const stop = starkeep(["stop", "dice"]);
    expect(stop.out).toContain("Stopped dice.");
    starkeep(["stop"]);
    expect(starkeep(["start"]).code).toBe(0);
    expect(portOf("dice")).toBeNull();
  });

  it("says a stopped service was not running, and succeeds (LDS-108)", () => {
    expect(starkeep(["stop", "drive"]).code).toBe(0);
    const run = starkeep(["stop", "drive"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("drive was not running.");
  });

  it("says which service did not start, how many failed, and fails (LDS-110)", async () => {
    const drivePort = Number(process.env.STARKEEP_DRIVE_PORT);
    const blocker = await holdPort(drivePort);
    try {
      const run = starkeep(["start"]);
      expect(run.code).toBe(1);
      expect(run.err).toContain("Could not start drive:");
      expect(run.err).toContain("1 of 2 services did not start.");
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("restarts the data server (LDS-109)", () => {
    const run = starkeep(["restart", "data-server"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out.indexOf("Stopped data-server.")).toBeLessThan(
      run.out.search(/Started data-server on http:\/\/localhost:\d+\./),
    );
  });

  it("restarts the platform and the marked apps with no names, and leaves admin-web alone", () => {
    expect(starkeep(["start", "dice"]).code).toBe(0);
    const run = starkeep(["restart"]);
    expect(run.code, run.err).toBe(0);
    for (const name of ["data-server", "drive", "dice"]) {
      expect(run.out).toMatch(new RegExp(`Started ${name} on`));
    }
    expect(run.out).not.toContain("admin-web");
  });

  it("shows the services, a marked app that is stopped, the cloud and sync (LDS-111)", () => {
    starkeep(["stop"]);
    expect(starkeep(["start", "data-server"]).code).toBe(0);
    expect(starkeep(["start", "drive"]).code).toBe(0);
    const run = starkeep(["status"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toMatch(/data-server +running {2}http:\/\/localhost:\d+/);
    expect(run.out).toMatch(/drive +running {2}http:\/\/localhost:\d+/);
    expect(run.out).toMatch(/dice +stopped {2}\(marked to run\)/);
    expect(run.out).toMatch(/admin-web +stopped/);
    expect(run.out).toContain("CLOUD     not joined");
    expect(run.out).toContain("SYNC      signed out");
  });

  it("prints the last lines of a log, as many as -n asks (LDS-113)", () => {
    const run = starkeep(["logs", "data-server", "-n", "3"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out.trim().split("\n").length).toBeLessThanOrEqual(3);
    expect(run.out.trim().length).toBeGreaterThan(0);
  });
});

describe("update", () => {
  beforeAll(() => {
    expect(starkeep(["start", "dice"]).code).toBe(0);
  });

  it("says each repository and app is up to date, and restarts nothing (APP-LIFE-236)", () => {
    const port = portOf("dice");
    const run = starkeep(["update", "dice", "notes"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`${dice.clone} is up to date with origin/main.`);
    expect(run.out).toContain(`${notes.clone} is up to date with origin/main.`);
    expect(run.out).toContain("dice is up to date.");
    expect(run.out).toContain("notes is up to date.");
    expect(run.out).not.toContain("Stopping");
    expect(portOf("dice")).toBe(port);
  });

  it("pulls, applies, and restarts a running app on the new code (APP-LIFE-235, APP-LIFE-241)", async () => {
    const before = dice.head();
    dice.publish({ version: "v2" });
    const run = starkeep(["update", "dice"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Fetching ${dice.clone}…`);
    expect(run.out).toContain(
      `Pulled ${dice.clone}: ${before.slice(0, 8)} → ${dice.head().slice(0, 8)}.`,
    );
    expect(run.out).toContain(
      "Run `starkeep update --undo` to return to the commits before this pull.",
    );
    expect(run.out.indexOf("Stopping dice…")).toBeLessThan(run.out.search(/Started dice on/));
    expect(run.out.trim().endsWith("Updated dice.")).toBe(true);
    expect(await served(portOf("dice")!)).toBe("v2");
  });

  it("asks before it pulls new access, and a no leaves the folder, the grant and the app (APP-LIFE-240)", async () => {
    const before = dice.head();
    dice.publish({ version: "v3", reads: ["image/png", "video/mp4"] });
    const run = await answering(["update", "dice"], ["n"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("dice's new version asks for different access:");
    expect(run.out).toContain("mp4");
    expect(run.err).toContain("Approve dice's new access and update? [y/N]");
    expect(run.out).toContain("Not updated: dice.");
    expect(dice.head()).toBe(before);
    expect(starkeep(["restart", "dice"]).code).toBe(0);
    expect(await served(portOf("dice")!)).toBe("v2");
    expect(starkeep(["info", "dice"]).out).not.toContain("mp4");
  });

  it("stops with status 3 before the pull when no terminal can answer (CLI-024)", () => {
    const before = dice.head();
    const run = starkeep(["update", "dice"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("Pass --yes to approve.");
    expect(dice.head()).toBe(before);
  });

  it("applies the new access with --yes", async () => {
    const run = starkeep(["update", "dice", "--yes"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("Updated dice.");
    expect(await served(portOf("dice")!)).toBe("v3");
    expect(starkeep(["info", "dice"]).out).toContain("mp4");
  });

  it("undoes the last update, asking again for the old version's access (APP-LIFE-242)", async () => {
    const records = JSON.parse(readFileSync(join(dataDir, "updates.json"), "utf8")) as {
      updates: Array<{ repos: Array<{ before: string }> }>;
    };
    const target = records.updates.at(-1)!.repos[0]!.before;
    const run = await answering(["update", "--undo"], ["y"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Returned ${dice.clone} to ${target.slice(0, 8)}.`);
    expect(dice.head()).toBe(target);
    expect(await served(portOf("dice")!)).toBe("v2");
  });

  it("keeps a repository with uncommitted changes, and moves no repository (APP-LIFE-237)", () => {
    notes.publish({ version: "v2" });
    writeFileSync(join(dice.clone, "VERSION"), "local edit\n");
    const diceHead = dice.head();
    const notesHead = notes.head();
    try {
      // The apps are named: with no names, the update starts with the
      // platform checkout, which here is this worktree.
      const run = starkeep(["update", "dice", "notes"]);
      expect(run.code).toBe(1);
      expect(run.err).toContain(`${dice.clone} has uncommitted changes to tracked files:`);
      expect(run.err).toContain("Commit or stash them, then run the update again.");
      expect(dice.head()).toBe(diceHead);
      expect(notes.head()).toBe(notesHead);
      expect(readFileSync(join(dice.clone, "VERSION"), "utf8")).toBe("local edit\n");
    } finally {
      git(dice.clone, "checkout", "--", ".");
    }
  });

  it("refuses a branch that diverged from its upstream (APP-LIFE-238)", () => {
    writeFileSync(join(notes.clone, "local.txt"), "mine\n");
    git(notes.clone, "add", "local.txt");
    git(notes.clone, "commit", "-q", "-m", "local");
    const head = notes.head();
    const run = starkeep(["update", "notes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      `${notes.clone} has diverged from origin/main: 1 local commit(s) and 1 new upstream commit(s). Rebase or merge by hand, then run the update again.`,
    );
    expect(notes.head()).toBe(head);
    expect(git(notes.clone, "rev-list", "--merges", "--count", "HEAD")).toBe("0");
    git(notes.clone, "reset", "-q", "--hard", "HEAD~1");
  });

  it("updates an app outside git from its folder as it is (APP-LIFE-239)", () => {
    const path = join(solo, "starkeep.manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...manifest, version: "0.2.0" }, null, 2));
    const run = starkeep(["update", "solo"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(
      `solo: ${solo} is not in a git repository, so there is nothing to fetch.`,
    );
    expect(run.out).toContain("Applied solo's new manifest.");
    expect(run.out).toContain("Updated solo.");
  });

  it("applies a repository with no upstream from the folder as it is (APP-LIFE-269)", () => {
    const lone = join(root, "lone");
    writeStandIn(lone, "lone");
    git(root, "init", "-q", "-b", "main", lone);
    git(lone, "add", ".");
    git(lone, "commit", "-q", "-m", "v1");
    expect(starkeep(["install", lone, "--local", "--yes"]).code).toBe(0);
    const path = join(lone, "starkeep.manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...manifest, version: "0.2.0" }, null, 2));
    const run = starkeep(["update", "lone"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`${lone}: the branch has no upstream, so there is nothing to fetch.`);
    expect(run.out).toContain("Applied lone's new manifest.");
  });

  it("skips an app whose folder lost its manifest, and updates the rest (APP-LIFE-270)", () => {
    const here = join(root, "here");
    const path = join(here, "starkeep.manifest.json");
    const text = readFileSync(path, "utf8");
    rmSync(path);
    try {
      const run = starkeep(["update", "here", "solo"]);
      expect(run.code, run.err).toBe(0);
      expect(run.err).toContain(`here: ${here} no longer holds a manifest. Skipped.`);
      expect(result(starkeep(["update", "here", "solo", "--json"]).out).data).toMatchObject({
        apps: { here: { local: "skipped" } },
      });
    } finally {
      writeFileSync(path, text);
    }
  });

  it("keeps every app in a repository on the old version when one declines (APP-LIFE-272)", async () => {
    const pair = standInRepo(apps, "alpha");
    writeStandIn(join(pair.work, "beta"), "beta");
    git(pair.work, "add", ".");
    git(pair.work, "commit", "-q", "-m", "beta");
    git(pair.work, "push", "-q", "origin", "main");
    git(pair.clone, "pull", "-q", "--ff-only");
    expect(
      starkeep(["install", pair.clone, join(pair.clone, "beta"), "--local", "--yes"]).code,
    ).toBe(0);
    const before = pair.head();
    pair.publish({ version: "v2", reads: ["image/png", "video/mp4"] });
    const run = await answering(["update", "alpha", "beta"], ["n"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("Not updated: alpha.");
    expect(run.out).toContain(
      "Not updated: beta, which shares a repository with an app you declined.",
    );
    expect(pair.head()).toBe(before);
  });

  it("says a built-in service updates with the platform", () => {
    const run = starkeep(["update", "drive"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("drive is built in and updates with the platform.");
  });
});

describe("uninstall", () => {
  it("asks for the id before it changes anything, then uninstalls and deletes the data (APP-LIFE-233)", async () => {
    const run = await answering(["uninstall", "todo", "--local", "--delete-data"], ["todo"]);
    expect(run.code, run.err).toBe(0);
    expect(run.err).toContain("Type todo to delete its data on this computer:");
    expect(run.out).toContain("Uninstalled todo.");
    // The stand-in writes no data, so the delete finds none to remove.
    expect(run.out).toContain("todo kept no data on this computer.");
    const list = result(starkeep(["list", "--json"]).out).data!.apps as Array<{
      appId: string;
      local: string;
    }>;
    expect(list.find((a) => a.appId === "todo")?.local).toBe("not installed");
  });

  it("changes nothing when the typed id does not match (APP-LIFE-234)", async () => {
    const run = await answering(["uninstall", "notes", "--local", "--delete-data"], ["nope"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      "Nothing changed: the typed id did not match, so notes stays installed with its data.",
    );
    expect(run.out).not.toContain("Uninstalled");
    const list = result(starkeep(["list", "--json"]).out).data!.apps as Array<{
      appId: string;
      local: string;
    }>;
    expect(list.find((a) => a.appId === "notes")?.local).toBe("installed");
  });

  it("stops with status 3 before the uninstall when no terminal can type the id (CLI-024)", () => {
    const run = starkeep(["uninstall", "notes", "--local", "--delete-data"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("Pass --yes to delete without typing the app id.");
    const list = result(starkeep(["list", "--json"]).out).data!.apps as Array<{
      appId: string;
      local: string;
    }>;
    expect(list.find((a) => a.appId === "notes")?.local).toBe("installed");
  });

  it("keeps the data, shows it as kept, and drops the mark to run (APP-LIFE-231)", () => {
    expect(starkeep(["start", "notes"]).code).toBe(0);
    const run = starkeep(["uninstall", "notes", "--local"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("Uninstalled notes. Its data stays on this computer.");
    starkeep(["stop"]);
    expect(starkeep(["start"]).code).toBe(0);
    expect(portOf("notes")).toBeNull();
  });

  it("says an app is not installed here (APP-LIFE-232)", () => {
    const run = starkeep(["uninstall", "notes", "--local"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("notes is not installed on this computer.");
  });
});

describe("with the data server stopped", () => {
  beforeAll(() => {
    starkeep(["stop"]);
  });

  it("shows each app's local state as unknown (APP-LIFE-228)", () => {
    const run = starkeep(["list"]);
    expect(run.out).toMatch(/^dice +\S+ +unknown/m);
  });

  it("shows the data server stopped and the sync state unknown (LDS-112)", () => {
    const run = starkeep(["status"]);
    expect(run.out).toMatch(/data-server +stopped/);
    expect(run.out).toContain("SYNC      unknown (the data server is not answering)");
  });

  it("says setup could not start a service whose port another program holds (CLI-015)", async () => {
    const blocker = await holdPort(Number(process.env.STARKEEP_PORT));
    try {
      const run = starkeep(["setup", "--local", "--yes", "--no-link", "--no-install"]);
      expect(run.code).toBe(1);
      expect(run.err).toContain("Could not start data-server:");
      expect(run.err).toContain("Setup could not start every service. See the messages above.");
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("removes a discovery folder (APP-LIFE-214)", () => {
    const run = starkeep(["source", "remove", apps]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Removed ${apps} from the discovery folders.`);
    expect(starkeep(["source", "list"]).out).not.toContain(`${apps}\n`);
  });
});

describe("config.json", () => {
  it("names a file that does not parse, and leaves it alone", () => {
    const path = join(dataDir, "config.json");
    const good = readFileSync(path, "utf8");
    writeFileSync(path, "{ not json");
    try {
      const run = starkeep(["source", "add", solo]);
      expect(run.code).toBe(1);
      expect(run.err).toContain(`${path} does not hold a JSON object, so Starkeep left it alone.`);
      expect(readFileSync(path, "utf8")).toBe("{ not json");
    } finally {
      writeFileSync(path, good);
    }
  });
});

describe("reset-local --apply", () => {
  it("stops the data server, deletes the library, and starts it again (LDS-117)", () => {
    expect(starkeep(["start", "data-server"]).code).toBe(0);
    const config = readFileSync(join(dataDir, "config.json"), "utf8");
    const creds = existsSync(join(dataDir, "app-creds"));
    const run = starkeep(["reset-local", "--apply"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out.indexOf("Stopping the data server…")).toBeLessThan(
      run.out.search(/Deleted \d+ item\(s\) in /),
    );
    expect(run.out).toMatch(/Started data-server on http:\/\/localhost:\d+\./);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(config);
    expect(existsSync(join(dataDir, "app-creds"))).toBe(creds);
  });
});

describe("the wrapper's checks", () => {
  it("names how to get pnpm when none is on PATH (CLI-008)", () => {
    const path = process.env.PATH;
    process.env.PATH = join(root, "empty-bin");
    try {
      const run = starkeep(["status"]);
      expect(run.code).toBe(1);
      expect(run.err).toContain("Starkeep needs a `pnpm` command on your PATH.");
      expect(run.err).toContain("npm install -g pnpm@10");
    } finally {
      process.env.PATH = path;
    }
  });
});
