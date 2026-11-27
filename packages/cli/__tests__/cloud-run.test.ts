/**
 * runCloud when another process holds the app's lock: a run of the same
 * operation is followed, as admin-web follows it; anything else refuses.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.STARKEEP_DIR = mkdtempSync(join(tmpdir(), "cli-cloud-run-"));

const world = vi.hoisted(() => ({
  slot: { state: "idle", owner: null as string | null },
  followed: 0,
  started: 0,
}));

vi.mock("@starkeep/operator/locks", () => ({
  acquireLock: () => ({
    ok: false,
    holder: { pid: 4242, command: "starkeep install probe --cloud", since: "now" },
  }),
}));
vi.mock("@starkeep/operator/runs", () => ({
  runStatus: () => world.slot,
  runLogPath: () => "/logs/app.log",
}));
vi.mock("@starkeep/operator/operation-runs", async (original) => ({
  ...(await original<object>()),
  followOperation: async (_slot: string, _from: number, onEvent: (e: unknown) => void) => {
    world.followed++;
    onEvent({ type: "progress", message: "Deploying probe…" });
    return { result: { type: "result", ok: true, data: { url: "https://x/apps/probe" } }, code: 0 };
  },
  runOperationInSlot: async () => {
    world.started++;
    throw new Error("must not start a second run");
  },
}));

const { runCloud } = await import("../src/cloud");
const { createIo } = await import("../src/io");

function io() {
  const lines: string[] = [];
  return {
    io: createIo({
      json: false,
      cwd: ".",
      stdout: (t) => lines.push(t),
      stderr: (t) => lines.push(t),
    }),
    lines,
  };
}

const RUN = {
  name: "install-cloud-app" as const,
  input: { appId: "probe" },
  owner: "probe (every surface)",
  lock: "app-probe",
  command: "starkeep install probe --cloud",
};

beforeEach(() => {
  world.followed = 0;
  world.started = 0;
});

describe("runCloud with the app's lock held elsewhere", () => {
  it("follows another terminal's run of the same operation to its end (APP-LIFE-266)", async () => {
    world.slot = { state: "running", owner: "probe (every surface)" };
    const { io: out, lines } = io();
    await expect(runCloud(out, RUN)).resolves.toEqual({ url: "https://x/apps/probe" });
    expect(world.followed).toBe(1);
    expect(world.started).toBe(0);
    expect(lines.join("")).toContain(
      "Following the probe (every surface) run that another command started (pid 4242: starkeep install probe --cloud).",
    );
    expect(lines.join("")).toContain("Deploying probe…");
  });

  it("refuses, naming the holder, when the slot runs something else or nothing yet", async () => {
    world.slot = { state: "idle", owner: null };
    await expect(runCloud(io().io, RUN)).rejects.toThrow(
      "Another operation holds app-probe (pid 4242: starkeep install probe --cloud). Try again once it ends.",
    );
    expect(world.followed).toBe(0);
  });
});
