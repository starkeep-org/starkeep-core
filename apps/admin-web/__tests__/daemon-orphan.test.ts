/**
 * Orphaned fixed-port workspace daemons — an instance whose pid file was lost
 * (crash, bad stop) or has gone stale (the daemon replaced itself), but which
 * still holds its port. Status must adopt it (report running so Stop is
 * offered), Start must adopt instead of colliding, and Stop must signal the
 * process actually serving; a non-daemon process on the port is refused, never
 * claimed.
 *
 * The fixed ports in DAEMON_COMMANDS (9820/9830) can't be bound safely in
 * tests, so we point the `drive` entry at test-allocated ports. Vitest
 * isolates test files in separate workers, so the mutation doesn't leak.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest, NextResponse } from "next/server";
import type { DaemonId } from "../src/lib/exec-commands";
import { getFreePort } from "@starkeep/testkit";
import { eventually, getRequest, isAlive, jsonRequest, makeDataDir } from "./helpers";

let daemonPOST: (req: NextRequest) => Promise<NextResponse>;
let statusGET: (req: NextRequest) => Promise<NextResponse>;
let isWorkspaceDaemonRunning: (id: DaemonId) => boolean;
let daemonCommands: { drive: { args: string[]; port?: number } };
let pidsDir: string;
const strays: number[] = [];

// A node process bound to a port — command line matches the dev-server shape
// (`node …`), so it's adoptable.
function spawnNodeServer(port: number): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", `require("http").createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1")`],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  strays.push(child.pid!);
  return child;
}

async function waitForPort(port: number): Promise<void> {
  await eventually(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBeLessThan(500);
  });
}

beforeAll(async () => {
  const dataDir = makeDataDir();
  pidsDir = join(dataDir, "pids");
  process.env.STARKEEP_DIR = dataDir;
  ({ POST: daemonPOST } = await import("../app/api/exec/daemon/route"));
  ({ GET: statusGET } = await import("../app/api/exec/daemon/status/route"));
  ({ DAEMON_COMMANDS: daemonCommands } = await import("../src/lib/exec-commands"));
  ({ isWorkspaceDaemonRunning } = await import("../src/lib/daemon-control"));
});

/** A pid that is certainly dead: spawn a process that exits at once. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
}

afterAll(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

const act = (body: unknown) => daemonPOST(jsonRequest("/api/exec/daemon", body));
const status = async (id: string) => {
  const res = await statusGET(getRequest(`/api/exec/daemon/status?id=${id}`));
  expect(res.status).toBe(200);
  return (await res.json()) as { running: boolean; pid?: number; port?: number; adopted?: boolean };
};
const clearRecords = (id: string) => {
  rmSync(join(pidsDir, `${id}.pid`), { force: true });
  rmSync(join(pidsDir, `${id}.meta.json`), { force: true });
};

describe("orphaned workspace daemon (daemon-looking process on the fixed port, no pid file)", () => {
  let orphan: ChildProcess;

  beforeAll(async () => {
    const port = await getFreePort();
    daemonCommands.drive.port = port;
    orphan = spawnNodeServer(port);
    await waitForPort(port);
  });

  it("status with no pid file adopts the orphan and reports it running", async () => {
    const s = await status("drive");
    expect(s.running).toBe(true);
    expect(s.adopted).toBe(true);
    expect(s.pid).toBe(orphan.pid);
    expect(s.port).toBe(daemonCommands.drive.port);
    // Adoption re-records the instance so Stop has a pid to signal.
    expect(readFileSync(join(pidsDir, "drive.pid"), "utf-8")).toBe(String(orphan.pid));
  });

  it("start adopts the orphan instead of spawning a colliding duplicate", async () => {
    clearRecords("drive");
    const res = await act({ action: "start", id: "drive" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pid: number; adopted?: boolean };
    expect(body.ok).toBe(true);
    expect(body.adopted).toBe(true);
    expect(body.pid).toBe(orphan.pid);
    // The orphan itself must survive adoption.
    expect(isAlive(orphan.pid!)).toBe(true);
    expect(existsSync(join(pidsDir, "drive.pid"))).toBe(true);
  });
});

describe("workspace daemon that replaced itself (stale pid file, successor on the port)", () => {
  // What the local-data-server does on PATCH /config: it re-execs itself as a
  // *detached* child in a new process group and exits, so the pid admin-web
  // recorded — the pnpm launcher, which dies with the instance it started —
  // stops naming anything while the daemon keeps right on serving.
  let successor: ChildProcess;
  let launcherPid: number;

  beforeAll(async () => {
    const port = await getFreePort();
    daemonCommands.drive.port = port;
    clearRecords("drive");
    successor = spawnNodeServer(port);
    await waitForPort(port);
    launcherPid = await deadPid();
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, "drive.pid"), String(launcherPid));
    writeFileSync(
      join(pidsDir, "drive.meta.json"),
      JSON.stringify({ pid: launcherPid, port }),
    );
  });

  it("status reports the successor's pid, not the launcher that exited", async () => {
    const s = await status("drive");
    expect(s.running).toBe(true);
    expect(s.pid).toBe(successor.pid);
    expect(s.pid).not.toBe(launcherPid);
    expect(readFileSync(join(pidsDir, "drive.pid"), "utf-8")).toBe(String(successor.pid));
  });

  it("a config-change restart still finds it running", async () => {
    // Reading the stale pid alone said "not running", so the restart that
    // applies newly-written config was skipped and the daemon kept serving its
    // boot-time snapshot indefinitely.
    writeFileSync(join(pidsDir, "drive.pid"), String(launcherPid));
    expect(isWorkspaceDaemonRunning("drive")).toBe(true);
  });

  it("stop signals the successor rather than reporting a phantom success", async () => {
    writeFileSync(join(pidsDir, "drive.pid"), String(launcherPid));
    const res = await act({ action: "stop", id: "drive" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopped: boolean }).stopped).toBe(true);
    await eventually(() => {
      expect(isAlive(successor.pid!)).toBe(false);
    });
    expect(existsSync(join(pidsDir, "drive.pid"))).toBe(false);
    expect(existsSync(join(pidsDir, "drive.meta.json"))).toBe(false);
  });
});

describe("non-daemon process on the fixed port", () => {
  let squatter: ChildProcess;

  beforeAll(async () => {
    const port = await getFreePort();
    daemonCommands.drive.port = port;
    clearRecords("drive");
    // python3, so the command-line guard can't mistake it for a dev server.
    squatter = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      detached: true,
      stdio: "ignore",
    });
    squatter.unref();
    strays.push(squatter.pid!);
    await waitForPort(port);
  });

  it("status does not adopt it", async () => {
    const s = await status("drive");
    expect(s.running).toBe(false);
    expect(existsSync(join(pidsDir, "drive.pid"))).toBe(false);
  });

  it("start refuses with a clear port-in-use error and leaves it alone", async () => {
    const res = await act({ action: "start", id: "drive" });
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("already in use");
    expect(error).toContain(String(daemonCommands.drive.port));
    expect(isAlive(squatter.pid!)).toBe(true);
  });
});
