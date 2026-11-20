/**
 * The command table and the argument parsing around it: help, exit codes for
 * bad usage, and the explicit install target.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Modules read STARKEEP_DIR when they load, so it is set before any import.
process.env.STARKEEP_DIR = mkdtempSync(join(tmpdir(), "cli-main-"));
// Nothing listens here, so no test reaches a real data server.
process.env.STARKEEP_PORT = "1";

let main: typeof import("../src/main").main;
let COMMANDS: typeof import("../src/commands").COMMANDS;
beforeAll(async () => {
  ({ main } = await import("../src/main"));
  ({ COMMANDS } = await import("../src/commands"));
});

/** The last line of a `--json` run, parsed. */
function lastResult(out: string): {
  type: string;
  ok: boolean;
  error?: { code?: string; message: string };
} {
  return JSON.parse(out.trim().split("\n").at(-1)!) as {
    type: string;
    ok: boolean;
    error?: { code?: string; message: string };
  };
}

async function run(argv: string[], answers?: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    cwd: process.cwd(),
    interactive: answers !== undefined,
    ...(answers ? { answers } : {}),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

describe("the command table", () => {
  it("names each command once, with a summary", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) expect(c.summary.length).toBeGreaterThan(0);
  });

  it("lists every command in the general help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    for (const c of COMMANDS) expect(out).toContain(c.name);
  });

  it("names the shared flags and the exit codes in the general help (CLI-017)", async () => {
    const { code, out } = await run(["help"]);
    expect(code).toBe(0);
    expect(out).toContain(
      "Every command accepts --json and --help. Run `starkeep help <command>` for one command's help.",
    );
    expect(out).toContain(
      "Exit codes: 0 success, 1 failure, 2 bad usage, 3 needs input a run without a terminal cannot give.",
    );
  });

  it("prints one command's usage, lane and flags, the same for --help (CLI-018)", async () => {
    const help = await run(["help", "start"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage: starkeep start [<name>...]");
    expect(help.out).toContain("Credentials: This computer only. Needs no cloud credentials.");
    for (const f of ["--json", "--verbose", "--help"]) expect(help.out).toContain(f);
    expect((await run(["start", "--help"])).out).toBe(help.out);
  });

  it("prints a command's credential lane in its help", async () => {
    const { code, out } = await run(["help", "install"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage: starkeep install");
    expect(out).toContain("Credentials: --local needs no cloud credentials.");
    expect(out).toContain("sign in as the Starkeep admin");
  });
});

describe("bad usage exits 2", () => {
  it("an unknown command", async () => {
    const { code, err } = await run(["frobnicate"]);
    expect(code).toBe(2);
    expect(err).toContain('Unknown command "frobnicate"');
  });

  it("an unknown flag, with the command's help (CLI-021)", async () => {
    const { code, err } = await run(["start", "--force"]);
    expect(code).toBe(2);
    expect(err).toMatch(/force/);
    expect(err).toContain("Usage: starkeep start");
  });

  it("an unknown command or flag under --json ends with a result object", async () => {
    for (const argv of [
      ["frobnicate", "--json"],
      ["start", "--force", "--json"],
    ]) {
      const { code, out } = await run(argv);
      expect(code).toBe(2);
      expect(lastResult(out)).toMatchObject({
        type: "result",
        ok: false,
        error: { code: "USAGE" },
      });
    }
  });

  it("no command at all", async () => {
    expect((await run([])).code).toBe(2);
  });

  it("install without a target flag", async () => {
    const { code, err } = await run(["install", "example-app"]);
    expect(code).toBe(2);
    expect(err).toContain("--local");
  });

  it("uninstall without a target flag", async () => {
    expect((await run(["uninstall", "example-app"])).code).toBe(2);
  });

  it("--delete-data with a single cloud surface, which keeps the data side", async () => {
    const { code, err } = await run(["uninstall", "example-app", "--web", "--delete-data"]);
    expect(code).toBe(2);
    expect(err).toContain("--delete-data in the cloud needs --cloud");
  });
});

describe("a cloud target before cloud setup", () => {
  it("fails and names the setup command, before any sign-in", async () => {
    const { code, err } = await run(["install", "example-app", "--cloud"]);
    expect(code).toBe(1);
    expect(err).toContain("starkeep setup --cloud");
  });

  it("--json reports the failure as a result event", async () => {
    const { code, out } = await run(["install", "example-app", "--json"]);
    expect(code).toBe(2);
    const last = JSON.parse(out.trim().split("\n").at(-1)!) as {
      type: string;
      ok: boolean;
      error: { code: string };
    };
    expect(last).toMatchObject({ type: "result", ok: false, error: { code: "USAGE" } });
  });
});

describe("a command that needs the data server", () => {
  it("fails with exit 1 and names the fix when it is not answering", async () => {
    const { code, err } = await run(["install", "example-app", "--local", "--yes"]);
    expect(code).toBe(1);
    expect(err).toContain("starkeep start data-server");
  });
});

describe("a run without a terminal stops before it changes anything (CLI-024)", () => {
  it("an install without --yes names the flag and exits 3 before reaching the data server", async () => {
    const { code, err } = await run(["install", "example-app", "--local"]);
    expect(code).toBe(3);
    expect(err).toContain(
      "Approve and install? No terminal is attached to answer. Pass --yes to approve.",
    );
  });

  it("an uninstall with --delete-data names its own flag and exits 3", async () => {
    const { code, err } = await run(["uninstall", "example-app", "--local", "--delete-data"]);
    expect(code).toBe(3);
    expect(err).toContain("Pass --yes to delete without typing the app id.");
  });
});

describe("logs", () => {
  it("refuses --json and names the log file (CLI-030)", async () => {
    const { code, out } = await run(["logs", "data-server", "--json"]);
    expect(code).toBe(2);
    const result = lastResult(out);
    expect(result).toMatchObject({ ok: false, error: { code: "USAGE" } });
    expect(result.error!.message).toContain("starkeep logs prints text only");
    expect(result.error!.message).toContain("local-data-server.log");
  });

  it("says when a name has no log here (LDS-114)", async () => {
    const { code, err } = await run(["logs", "dice"]);
    expect(code).toBe(1);
    expect(err).toMatch(/No log for dice at .*dice\.log\. It has not been started here\./);
  });
});

describe("reset-local", () => {
  const dir = process.env.STARKEEP_DIR!;
  const library = ["objects", "data.db", "data.db-wal", "watches.json"].map((f) => join(dir, f));

  it("says there is nothing to delete in an empty folder (LDS-118)", async () => {
    const { code, out } = await run(["reset-local"]);
    expect(code).toBe(0);
    expect(out).toContain(`Nothing to delete in ${dir}.`);
  });

  it("lists what it would delete without --apply, and deletes nothing (LDS-116)", async () => {
    mkdirSync(library[0]!, { recursive: true });
    writeFileSync(join(library[0]!, "blob"), "x");
    for (const f of library.slice(1)) writeFileSync(f, "x");
    try {
      const { code, out } = await run(["reset-local"]);
      expect(code).toBe(0);
      expect(out).toContain("Would delete:");
      for (const f of library) expect(out).toContain(f);
      expect(out.trim().endsWith("Run `starkeep reset-local --apply` to delete them.")).toBe(true);
      for (const f of library) expect(existsSync(f)).toBe(true);
    } finally {
      for (const f of library) rmSync(f, { recursive: true, force: true });
    }
  });
});
