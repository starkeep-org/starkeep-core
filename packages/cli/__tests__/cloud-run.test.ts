/**
 * runCloud: a run of the same operation that another terminal holds is
 * followed, as admin-web follows it, and anything else refuses. With the lock
 * free, a run that was already going is followed, a busy slot refuses, and a
 * failed run names its log.
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
  /** Whether this process gets the lock. */
  lockFree: false,
  released: 0,
  /** What a started run does: return its outcome, or throw. */
  run: null as null | (() => unknown),
}));

vi.mock("@starkeep/operator/locks", () => ({
  acquireLock: () =>
    world.lockFree
      ? { ok: true, release: () => world.released++ }
      : {
          ok: false,
          holder: { pid: 4242, command: "starkeep install probe --cloud", since: "now" },
        },
}));
vi.mock("@starkeep/operator/admin-session", async (original) => ({
  ...(await original<object>()),
  adminCredentials: async () => ({
    email: "admin@example.com",
    region: "us-west-2",
    stsCredentials: { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "t" },
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
    if (!world.run) throw new Error("must not start a second run");
    return world.run();
  },
}));

const { runCloud } = await import("../src/cloud");
const { SlotBusyError } = await import("@starkeep/operator/operation-runs");
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
  world.lockFree = false;
  world.released = 0;
  world.run = null;
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

describe("runCloud with the lock free", () => {
  const failed = (code: string, message: string) => () => ({
    result: { type: "result", ok: false, error: { code, message } },
    logPath: "/logs/app.log",
    followed: false,
  });

  it("says it followed a run that was already going (APP-LIFE-248)", async () => {
    world.lockFree = true;
    world.run = () => ({
      result: { type: "result", ok: true, data: { url: "https://x/apps/probe" } },
      logPath: "/logs/app.log",
      followed: true,
    });
    const { io: out, lines } = io();
    await expect(runCloud(out, RUN)).resolves.toEqual({ url: "https://x/apps/probe" });
    expect(lines.join("")).toContain(
      "Followed a probe (every surface) run that was already going.",
    );
    expect(world.released).toBe(1);
  });

  it("refuses while another cloud operation runs, and names it (APP-LIFE-249)", async () => {
    world.lockFree = true;
    world.run = () => {
      throw new SlotBusyError("app", "notes (every surface)");
    };
    await expect(runCloud(io().io, RUN)).rejects.toMatchObject({
      message:
        "Another cloud operation is running (notes (every surface)). Wait for it to end, or follow it in admin-web.",
      exitCode: 1,
    });
    expect(world.released).toBe(1);
  });

  it("shows the refusal and the whole log, with status 1 (APP-LIFE-250)", async () => {
    world.lockFree = true;
    world.run = failed("AWS_ERROR", "AWS refused the stack update.");
    await expect(runCloud(io().io, RUN)).rejects.toMatchObject({
      message: "AWS refused the stack update.\nThe whole log: /logs/app.log",
      exitCode: 1,
      logPath: "/logs/app.log",
    });
  });

  it("says to sign in and run the command again when the sign-in expired (APP-LIFE-251)", async () => {
    world.lockFree = true;
    world.run = failed(
      "CREDENTIALS_EXPIRED",
      "AWS rejected the admin's sign-in as expired or invalid. Sign in again, then retry.",
    );
    await expect(runCloud(io().io, RUN)).rejects.toMatchObject({
      message:
        "AWS rejected the admin's sign-in as expired or invalid. Run `starkeep login --admin`, then run the command again.\nThe whole log: /logs/app.log",
    });
  });
});
