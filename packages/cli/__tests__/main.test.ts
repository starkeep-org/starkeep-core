/**
 * The command table and the argument parsing around it: help, exit codes for
 * bad usage, and the explicit install target.
 */
import { mkdtempSync } from "node:fs";
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

  it("an unknown flag", async () => {
    const { code, err } = await run(["status", "--nope"]);
    expect(code).toBe(2);
    expect(err).toMatch(/nope/);
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

describe("reset-local", () => {
  it("only lists what it would delete without --apply", async () => {
    const { code, out } = await run(["reset-local"]);
    expect(code).toBe(0);
    expect(out).toContain("Nothing to delete");
  });
});
