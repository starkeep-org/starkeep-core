/**
 * The whole CLI through its wrapper, against a throwaway Starkeep instance on
 * its own ports: set up, install the example app, start it, read the status,
 * stop everything, and uninstall with the data.
 *
 * It uses core's example app, which the seeded config offers, and never any
 * other app.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WRAPPER = join(CHECKOUT, "scripts", "starkeep.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "cli-lifecycle-"));

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

let env: NodeJS.ProcessEnv;

function starkeep(...args: string[]): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: dataDir,
    env,
    encoding: "utf8",
    timeout: 300_000,
  });
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr };
}

/** The final `result` event of a `--json` run. */
function result(out: string): { ok: boolean; data?: Record<string, unknown> } {
  const lines = out.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1)!) as { ok: boolean; data?: Record<string, unknown> };
}

beforeAll(async () => {
  const appBase = 30_000 + Math.floor(Math.random() * 20_000);
  env = {
    ...process.env,
    STARKEEP_DIR: dataDir,
    STARKEEP_PORT: String(await freePort()),
    STARKEEP_DRIVE_PORT: String(await freePort()),
    STARKEEP_ADMIN_PORT: String(await freePort()),
    STARKEEP_APP_PORT_RANGE: `${appBase}-${appBase + 99}`,
  };
  delete env.STARKEEP_LOCAL_DATA_SERVER_URL;
  delete env.STARKEEP_DRIVE_URL;
  delete env.INIT_CWD;
});

afterAll(() => {
  starkeep("stop");
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the local lifecycle", () => {
  it("sets up and starts the data server and Drive", () => {
    const run = starkeep("setup", "--local", "--yes", "--no-link", "--no-install", "--json");
    expect(run.code, run.err).toBe(0);
    expect(result(run.out).ok).toBe(true);
    expect(existsSync(join(dataDir, "config.json"))).toBe(true);
    expect(existsSync(join(dataDir, "services.json"))).toBe(true);
  });

  it("refuses an install without a terminal and without --yes (exit 3)", () => {
    const run = starkeep("install", "example-app", "--local");
    expect(run.code).toBe(3);
    expect(run.err).toContain("--yes");
  });

  it("installs the example app", () => {
    const run = starkeep("install", "example-app", "--local", "--yes", "--json");
    expect(run.code, run.err + run.out).toBe(0);
    expect(result(run.out)).toMatchObject({ ok: true, data: { installed: ["example-app"] } });
  });

  it("starts it and reports it running", () => {
    expect(starkeep("start", "example-app").code).toBe(0);
    const status = starkeep("status", "--json");
    expect(status.code).toBe(0);
    const services = result(status.out).data!.services as Array<{ name: string; running: boolean }>;
    expect(services.find((s) => s.name === "example-app")?.running).toBe(true);
    expect(services.find((s) => s.name === "data-server")?.running).toBe(true);
  });

  it("lists it as running", () => {
    const run = starkeep("list", "--json");
    const apps = result(run.out).data!.apps as Array<{ appId: string; local: string }>;
    expect(apps.find((a) => a.appId === "example-app")?.local).toBe("running");
  });

  it("stops it, and uninstalls it with its data", () => {
    expect(starkeep("stop", "example-app").code).toBe(0);
    const run = starkeep("uninstall", "example-app", "--local", "--delete-data", "--yes", "--json");
    expect(run.code, run.err + run.out).toBe(0);
    const list = starkeep("list", "--json");
    const apps = result(list.out).data!.apps as Array<{ appId: string; local: string }>;
    expect(apps.find((a) => a.appId === "example-app")?.local).toBe("not installed");
  });

  it("stops everything", () => {
    expect(starkeep("stop").code).toBe(0);
    const status = starkeep("status", "--json");
    const services = result(status.out).data!.services as Array<{ name: string; running: boolean }>;
    expect(services.every((s) => !s.running)).toBe(true);
  });
});
