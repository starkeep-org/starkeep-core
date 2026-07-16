/**
 * Orphaned fixed-port workspace daemons — an instance whose pid file was lost
 * (crash, bad stop) but which still holds its port. Status must adopt it
 * (report running so Stop is offered) and Start must adopt instead of
 * colliding; a non-daemon process on the port is refused, never claimed.
 *
 * The fixed ports in DAEMON_COMMANDS (9820/9830) can't be bound safely in
 * tests, so we point the `drive` entry at test-allocated ports. Vitest
 * isolates test files in separate workers, so the mutation doesn't leak.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest, NextResponse } from "next/server";
import { getFreePort } from "@starkeep/testkit";
import { eventually, getRequest, isAlive, jsonRequest, makeDataDir } from "./helpers";

let daemonPOST: (req: NextRequest) => Promise<NextResponse>;
let statusGET: (req: NextRequest) => Promise<NextResponse>;
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
});

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
