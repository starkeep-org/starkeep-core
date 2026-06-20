/**
 * /api/exec/daemon (+ /status) — installed-app daemon lifecycle driven by the
 * manifest's localRun block. (Plan §5, Tier 1.)
 *
 * No local-data-server needed: these routes only touch the filesystem, the
 * process table, and the app scan.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest, NextResponse } from "next/server";
import { getFreePort } from "@starkeep/testkit";
import {
  eventually,
  getRequest,
  isAlive,
  jsonRequest,
  makeAppDir,
  makeDataDir,
  testAppManifest,
  writeAdminConfig,
} from "./helpers";

let daemonPOST: (req: NextRequest) => Promise<NextResponse>;
let statusGET: (req: NextRequest) => Promise<NextResponse>;
let pidsDir: string;
const strays: number[] = [];

// A real HTTP server the route can spawn via localRun: binds the port given
// by --port, like an app dev server would.
const SERVER_MJS = `
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => res.end("ok")).listen(port, "127.0.0.1");
`;

beforeAll(async () => {
  const dataDir = makeDataDir();
  pidsDir = join(dataDir, "pids");
  const parent = join(dataDir, "apps");
  mkdirSync(parent, { recursive: true });
  writeAdminConfig(dataDir, { appParentDirs: [parent] });

  const appDir = makeAppDir(
    parent,
    "daemon-app",
    testAppManifest({
      id: "daemon-app",
      localRun: { command: process.execPath, args: ["server.mjs"], portFlag: "--port" },
    }),
  );
  writeFileSync(join(appDir, "server.mjs"), SERVER_MJS);
  makeAppDir(parent, "norun-app", testAppManifest({ id: "norun-app" }));

  process.env.STARKEEP_DIR = dataDir;
  ({ POST: daemonPOST } = await import("../app/api/exec/daemon/route"));
  ({ GET: statusGET } = await import("../app/api/exec/daemon/status/route"));
});

afterAll(() => {
  // Belt and braces: kill anything the tests started but failed to stop.
  for (const id of ["daemon-app"]) {
    const pf = join(pidsDir, `${id}.pid`);
    if (existsSync(pf)) {
      const pid = parseInt(readFileSync(pf, "utf-8"), 10);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
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
  return (await res.json()) as { running: boolean; pid?: number; port?: number };
};

describe("input validation", () => {
  it("rejects an unknown action with 400", async () => {
    const res = await act({ action: "restart", id: "daemon-app" });
    expect(res.status).toBe(400);
  });

  it("start of an unknown app id is 404", async () => {
    const res = await act({ action: "start", id: "ghost-app" });
    expect(res.status).toBe(404);
  });

  it("start of an app without a localRun block is 400", async () => {
    const res = await act({ action: "start", id: "norun-app" });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("localRun");
  });

  it("status without an id is 400", async () => {
    const res = await statusGET(getRequest("/api/exec/daemon/status"));
    expect(res.status).toBe(400);
  });
});

describe("start → status → stop lifecycle", () => {
  it("status of a never-started id reports not running", async () => {
    expect((await status("daemon-app")).running).toBe(false);
  });

  it("start spawns the manifest's localRun command with an allocated port", async () => {
    const res = await act({ action: "start", id: "daemon-app" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pid: number; logPath: string; port: number };
    expect(body.pid).toBeGreaterThan(0);
    expect(body.port).toBeGreaterThan(0);
    expect(existsSync(join(pidsDir, "daemon-app.pid"))).toBe(true);
    expect(existsSync(join(pidsDir, "daemon-app.meta.json"))).toBe(true);

    // The spawned server must actually come up on the allocated port, and the
    // status route's TCP probe must see it.
    await eventually(async () => {
      const s = await status("daemon-app");
      expect(s.running).toBe(true);
      expect(s.port).toBe(body.port);
    });
    const ping = await fetch(`http://127.0.0.1:${body.port}/`);
    expect(ping.ok).toBe(true);
  });

  it("stop kills the process group and cleans up pid/meta files", async () => {
    const pid = parseInt(readFileSync(join(pidsDir, "daemon-app.pid"), "utf-8"), 10);
    const res = await act({ action: "stop", id: "daemon-app" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopped: boolean }).stopped).toBe(true);

    await eventually(() => {
      expect(isAlive(pid)).toBe(false);
    });
    expect(existsSync(join(pidsDir, "daemon-app.pid"))).toBe(false);
    expect(existsSync(join(pidsDir, "daemon-app.meta.json"))).toBe(false);
    expect((await status("daemon-app")).running).toBe(false);
  });

  it("stop when nothing is running is 404", async () => {
    const res = await act({ action: "stop", id: "daemon-app" });
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("Not running");
  });
});

describe("the ps guard on port-based stop", () => {
  let squatter: ChildProcess;
  let port: number;

  beforeAll(async () => {
    // A process that binds the recorded port but is NOT a dev server
    // (python3, so it can't match the pnpm|node|next|vite|npm command check).
    port = await getFreePort();
    squatter = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      detached: true,
      stdio: "ignore",
    });
    squatter.unref();
    strays.push(squatter.pid!);
    await eventually(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBeLessThan(500);
    });
    // Simulate a stale daemon record: meta file with the port, no pid file.
    mkdirSync(pidsDir, { recursive: true });
    writeFileSync(join(pidsDir, "stale-app.meta.json"), JSON.stringify({ pid: 999999, port }));
  });

  it("refuses to signal a non-dev-server process occupying the recorded port", async () => {
    const res = await act({ action: "stop", id: "stale-app" });
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("refusing");
    expect(isAlive(squatter.pid!)).toBe(true);
    // The meta file must survive — nothing was stopped.
    expect(existsSync(join(pidsDir, "stale-app.meta.json"))).toBe(true);
  });
});
