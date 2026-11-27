/**
 * `setup --join <address>`, with stand-ins for the local data server's HTTP
 * answers, the service start and the sync sign-in.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIo } from "../src/io";

const dir = mkdtempSync(join(tmpdir(), "cli-setup-join-"));
process.env.STARKEEP_DIR = dir;
const configPath = join(dir, "config.json");

const { setupJoin } = await import("../src/setup/cloud");

interface World {
  calls: string[];
  /** Whether the data server answers /health after the restart. */
  comesBack: boolean;
  /** Whether the data server answers at all. */
  answers: boolean;
}

let world: World;
let printed: string[];

const deps = {
  startLocalServices: async () => {
    world.calls.push("start-services");
  },
  loginSync: async () => {
    world.calls.push("login-sync");
  },
};

function io() {
  return createIo({
    json: false,
    cwd: dir,
    interactive: false,
    stdout: (t) => printed.push(t),
    stderr: (t) => printed.push(t),
  });
}

beforeEach(() => {
  world = { calls: [], comesBack: true, answers: true };
  printed = [];
  rmSync(configPath, { force: true });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!world.answers) throw new TypeError("fetch failed");
    if (url.endsWith("/config") && init?.method === "PATCH") {
      world.calls.push(`patch ${String(init.body)}`);
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/health")) {
      return new Response("{}", { status: world.comesBack ? 200 : 503 });
    }
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(configPath, { force: true });
});

describe("setup --join", () => {
  it("records the address, waits for the restart, then signs in to sync (LDS-119)", async () => {
    await expect(
      setupJoin(io(), "https://d123.cloudfront.net/", deps, { noBrowser: true }),
    ).resolves.toEqual({ cloudUrl: "https://d123.cloudfront.net" });
    expect(world.calls).toEqual([
      "start-services",
      'patch {"apiGatewayUrl":"https://d123.cloudfront.net"}',
      "login-sync",
    ]);
    expect(printed.join("")).toContain(
      "This computer joins https://d123.cloudfront.net. Restarting the data server…",
    );
  });

  it("refuses an address that is not https with status 2, and joins nothing (LDS-120)", async () => {
    await expect(
      setupJoin(io(), "http://d123.cloudfront.net", deps, { noBrowser: true }),
    ).rejects.toMatchObject({
      message: "--join takes the cloud's https address, such as https://d123.cloudfront.net.",
      exitCode: 2,
    });
    expect(world.calls).toEqual([]);
  });

  it("says where to look when the data server does not come back (LDS-121)", async () => {
    world.comesBack = false;
    vi.useFakeTimers();
    try {
      const joined = expect(
        setupJoin(io(), "https://d123.cloudfront.net", deps, { noBrowser: true }),
      ).rejects.toMatchObject({
        message:
          "The data server did not come back after the restart. Run `starkeep logs data-server`.",
        exitCode: 1,
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await joined;
    } finally {
      vi.useRealTimers();
    }
    expect(world.calls).not.toContain("login-sync");
  });

  it("says how to start a data server that does not answer", async () => {
    world.answers = false;
    await expect(
      setupJoin(io(), "https://d123.cloudfront.net", deps, { noBrowser: true }),
    ).rejects.toThrow(
      "The local data server is not answering. Run `starkeep start data-server` first.",
    );
  });

  it("refuses another cloud on a computer that already has one, and changes nothing (LDS-123)", async () => {
    writeFileSync(configPath, JSON.stringify({ apiGatewayUrl: "https://d123.cloudfront.net" }));
    await expect(
      setupJoin(io(), "https://d456.cloudfront.net", deps, { noBrowser: true }),
    ).rejects.toMatchObject({
      message:
        "This computer already belongs to https://d123.cloudfront.net. Moving a computer to another cloud is not supported.",
      exitCode: 1,
    });
    expect(world.calls).toEqual([]);
  });

  it("refuses a join on a computer whose own cloud deploy has started", async () => {
    writeFileSync(configPath, JSON.stringify({ userPoolId: "us-east-2_abc" }));
    await expect(
      setupJoin(io(), "https://d456.cloudfront.net", deps, { noBrowser: true }),
    ).rejects.toThrow(
      "This computer already belongs to the cloud whose sign-in pool is us-east-2_abc.",
    );
    expect(world.calls).toEqual([]);
  });

  it("resumes a join of the same cloud", async () => {
    writeFileSync(configPath, JSON.stringify({ apiGatewayUrl: "https://d123.cloudfront.net" }));
    await setupJoin(io(), "https://d123.cloudfront.net", deps, { noBrowser: true });
    expect(world.calls).toContain("login-sync");
  });
});
