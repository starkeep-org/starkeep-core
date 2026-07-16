/**
 * Orphaned workspace daemons: an instance whose pid file was lost (a crash, a
 * bad stop) still holds its fixed port. Admin must adopt it — report it running
 * and offer Stop — rather than report not-running and offer a Start that
 * collides. A process on the port that isn't ours must never be claimed.
 *
 * The Tier-1 tests (apps/admin-web/__tests__/daemon-orphan.test.ts) cover this
 * by mutating DAEMON_COMMANDS in-process. That can't reach across a process
 * boundary, so this spec does it for real: admin-web resolves the drive
 * daemon's port from STARKEEP_DRIVE_PORT, and the harness boots it with that
 * pointed at a reserved free port (never the real 9830 — see stack.ts).
 */

import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eventually } from "@starkeep/e2e";

test.describe.configure({ mode: "serial" });

const adminUrl = () => process.env.E2E_ADMIN_URL!;
const adminDataDir = () => process.env.E2E_ADMIN_DATA_DIR!;
const drivePort = () => parseInt(process.env.E2E_DRIVE_DAEMON_PORT!, 10);

const strays: ChildProcess[] = [];

/** Bind `port` with a process whose command line passes admin's daemon guard (node …). */
async function spawnNodeServer(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["-e", `require("http").createServer((q,s)=>s.end("ok")).listen(${port},"127.0.0.1")`],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  strays.push(child);
  await eventually(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBeLessThan(500);
  });
  return child;
}

/** Bind `port` with something admin must refuse to claim (not a dev-server shape). */
async function spawnForeignServer(port: number): Promise<ChildProcess> {
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  strays.push(child);
  await eventually(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBeLessThan(500);
  });
  return child;
}

async function driveStatus(): Promise<{ running: boolean; pid?: number; adopted?: boolean }> {
  const res = await fetch(`${adminUrl()}/api/exec/daemon/status?id=drive`);
  expect(res.ok).toBe(true);
  return (await res.json()) as { running: boolean; pid?: number; adopted?: boolean };
}

async function stopStray(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await eventually(async () => {
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
}

// Every case here starts from "admin has no record of drive" — that absence is
// what makes an instance an orphan. Adoption writes records back, so clear them
// rather than let one case's adoption leak into the next.
test.beforeEach(() => {
  for (const file of ["drive.pid", "drive.meta.json"]) {
    rmSync(join(adminDataDir(), "pids", file), { force: true });
  }
});

test.afterAll(async () => {
  for (const child of strays) await stopStray(child);
});

test("status adopts an orphaned daemon holding the port and re-records it", async () => {
  const orphan = await spawnNodeServer(drivePort());

  const status = await driveStatus();
  expect(status.running).toBe(true);
  expect(status.adopted).toBe(true);
  expect(status.pid).toBe(orphan.pid);

  // Re-recorded, so Stop has a pid to signal — the point of adopting at all.
  expect(readFileSync(join(adminDataDir(), "pids", "drive.pid"), "utf-8")).toBe(String(orphan.pid));

  // And Stop really does take the adopted instance down.
  const res = await fetch(`${adminUrl()}/api/exec/daemon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "stop", id: "drive" }),
  });
  expect(res.ok).toBe(true);
  await eventually(async () => {
    expect(() => process.kill(orphan.pid!, 0)).toThrow();
  });
  expect((await driveStatus()).running).toBe(false);
});

test("start adopts the orphan instead of spawning a doomed duplicate", async () => {
  const orphan = await spawnNodeServer(drivePort());

  const res = await fetch(`${adminUrl()}/api/exec/daemon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", id: "drive" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; pid: number; adopted?: boolean };
  expect(body.ok).toBe(true);
  expect(body.adopted).toBe(true);
  expect(body.pid).toBe(orphan.pid);

  // Adoption must leave the running instance alone, not restart it.
  expect(() => process.kill(orphan.pid!, 0)).not.toThrow();
  await stopStray(orphan);
});

test("a process that isn't ours is refused, never claimed", async () => {
  const foreign = await spawnForeignServer(drivePort());

  // Not a dev-server command line, so status must not adopt it…
  const status = await driveStatus();
  expect(status.running).toBe(false);
  expect(existsSync(join(adminDataDir(), "pids", "drive.pid"))).toBe(false);

  // …and Start must refuse with the port conflict rather than kill the squatter.
  const res = await fetch(`${adminUrl()}/api/exec/daemon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", id: "drive" }),
  });
  expect(res.status).toBe(500);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain("already in use");
  expect(error).toContain(String(drivePort()));
  expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
});
