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
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";
import { getFreePort } from "@starkeep/testkit";
import { portIsFree } from "../../src/lib/app-ports";
import {
  eventually,
  getRequest,
  isAlive,
  jsonRequest,
  makeAppDir,
  makeDataDir,
  testAppManifest,
  writeAdminConfig,
} from "../helpers";

let daemonPOST: (req: Request) => Promise<Response>;
let statusGET: (req: Request) => Promise<Response>;
let pidsDir: string;
let dataDir: string;
let daemonAppDir: string;
const strays: number[] = [];
// No local data server listens here, so Start resolves through the scan.
const NO_DATA_SERVER = "http://127.0.0.1:9";
const daemonAppManifest = testAppManifest({
  id: "daemon-app",
  localRun: { command: process.execPath, args: ["server.mjs"], portFlag: "--port" },
});

// A real HTTP server the route can spawn via localRun: binds the port given
// by --port, like an app dev server would.
const SERVER_MJS = `
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => res.end("ok")).listen(port, "127.0.0.1");
`;

// The same server, but it ignores SIGTERM, like a dev server stuck in shutdown.
const STUBBORN_SERVER_MJS = `${SERVER_MJS}
process.on("SIGTERM", () => {});
`;

beforeAll(async () => {
  dataDir = makeDataDir();
  pidsDir = join(dataDir, "pids");
  const parent = join(dataDir, "apps");
  mkdirSync(parent, { recursive: true });
  writeAdminConfig(dataDir, { appParentDirs: [parent] });

  daemonAppDir = makeAppDir(parent, "daemon-app", daemonAppManifest);
  writeFileSync(join(daemonAppDir, "server.mjs"), SERVER_MJS);
  makeAppDir(
    parent,
    "stubborn-app",
    testAppManifest({
      id: "stubborn-app",
      localRun: { command: process.execPath, args: ["server.mjs"], portFlag: "--port" },
    }),
  );
  writeFileSync(join(parent, "stubborn-app", "server.mjs"), STUBBORN_SERVER_MJS);
  makeAppDir(parent, "norun-app", testAppManifest({ id: "norun-app" }));

  // An app whose daemon prints an error and dies immediately (like a dev
  // server with a broken build).
  makeAppDir(
    parent,
    "doa-app",
    testAppManifest({
      id: "doa-app",
      localRun: { command: process.execPath, args: ["crash.mjs"], portFlag: "--port" },
    }),
  );
  writeFileSync(
    join(parent, "doa-app", "crash.mjs"),
    `console.error("boom: turbopack build failed"); process.exit(1);`,
  );

  // An app whose localRun command doesn't exist at all (like Node missing
  // from PATH inside a sandbox).
  makeAppDir(
    parent,
    "nocmd-app",
    testAppManifest({
      id: "nocmd-app",
      localRun: { command: "starkeep-no-such-command-xyzzy", args: [] },
    }),
  );

  // An app checkout that was never `pnpm install`ed: package.json declares a
  // dependency, and node_modules is missing.
  makeAppDir(
    parent,
    "nodeps-app",
    testAppManifest({
      id: "nodeps-app",
      localRun: { command: process.execPath, args: ["server.mjs"], portFlag: "--port" },
    }),
  );
  writeFileSync(
    join(parent, "nodeps-app", "package.json"),
    JSON.stringify({ name: "nodeps-app", dependencies: { "left-pad": "^1.3.0" } }),
  );
  writeFileSync(join(parent, "nodeps-app", "server.mjs"), SERVER_MJS);

  process.env.STARKEEP_DIR = dataDir;
  // Nothing listens here: no app is installed, so Start resolves through the scan.
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = NO_DATA_SERVER;
  daemonPOST = (await import("../../src/routes/exec-daemon")).POST;
  statusGET = (await import("../../src/routes/exec-daemon-status")).GET;
});

afterAll(() => {
  // Belt and braces: kill anything the tests started but failed to stop.
  for (const id of ["daemon-app", "stubborn-app"]) {
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
  let firstPort = 0;

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
    firstPort = body.port;
  });

  it("start of a running app is 409 with no port choice, and keeps its pid, meta and port", async () => {
    const pidBefore = readFileSync(join(pidsDir, "daemon-app.pid"), "utf-8");
    const metaBefore = readFileSync(join(pidsDir, "daemon-app.meta.json"), "utf-8");
    const recordBefore = readFileSync(join(dataDir, "app-ports.json"), "utf-8");
    // A stale page, such as a second tab, sends a plain start or a reassign.
    for (const body of [
      { action: "start", id: "daemon-app" },
      { action: "start", id: "daemon-app", reassignPort: true },
    ]) {
      const res = await act(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: `'daemon-app' is already running at http://localhost:${firstPort}.`,
      });
    }
    expect(readFileSync(join(pidsDir, "daemon-app.pid"), "utf-8")).toBe(pidBefore);
    expect(readFileSync(join(pidsDir, "daemon-app.meta.json"), "utf-8")).toBe(metaBefore);
    expect(readFileSync(join(dataDir, "app-ports.json"), "utf-8")).toBe(recordBefore);
  });

  it("stop answers only once the process group is gone and its port is free", async () => {
    const pid = parseInt(readFileSync(join(pidsDir, "daemon-app.pid"), "utf-8"), 10);
    const res = await act({ action: "stop", id: "daemon-app" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopped: boolean }).stopped).toBe(true);

    expect(isAlive(pid)).toBe(false);
    expect(await portIsFree(firstPort)).toBe(true);
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

  it("a second start reuses the first start's port, so the app keeps its origin", async () => {
    const res = await act({ action: "start", id: "daemon-app" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { port: number }).port).toBe(firstPort);
    await eventually(async () => expect((await status("daemon-app")).running).toBe(true));
  });

  it("a start right after a stop gets the same port, not 'port in use'", async () => {
    expect((await act({ action: "stop", id: "daemon-app" })).status).toBe(200);
    const res = await act({ action: "start", id: "daemon-app" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { port: number }).port).toBe(firstPort);
    await eventually(async () => expect((await status("daemon-app")).running).toBe(true));
    expect((await act({ action: "stop", id: "daemon-app" })).status).toBe(200);
    expect(await portIsFree(firstPort)).toBe(true);
  });
});

describe("a daemon that ignores SIGTERM", () => {
  it("stop sends SIGKILL after the grace period and answers with the port free", async () => {
    const res = await act({ action: "start", id: "stubborn-app" });
    expect(res.status).toBe(200);
    const { pid, port } = (await res.json()) as { pid: number; port: number };
    await eventually(async () => expect((await status("stubborn-app")).running).toBe(true));

    expect((await act({ action: "stop", id: "stubborn-app" })).status).toBe(200);
    expect(isAlive(pid)).toBe(false);
    expect(await portIsFree(port)).toBe(true);
    expect((await status("stubborn-app")).running).toBe(false);
  }, 20_000);
});

/** The port `app-ports.json` records for `appId`, and the retired ports. */
function recordedPorts(appId: string): { port: number | undefined; retired: number[] } {
  const record = JSON.parse(readFileSync(join(dataDir, "app-ports.json"), "utf-8")) as {
    apps: Record<string, { port: number }>;
    retired: number[];
  };
  return { port: record.apps[appId]?.port, retired: record.retired };
}

/** Start `id` and return its port, once it is up; then stop it. */
async function startAndStop(body: Record<string, unknown>): Promise<number> {
  const res = await act({ action: "start", ...body });
  expect(res.status).toBe(200);
  const { port } = (await res.json()) as { port: number };
  await eventually(async () => {
    const s = await status(body.id as string);
    expect(s.running).toBe(true);
    expect(s.port).toBe(port);
  });
  expect((await act({ action: "stop", id: body.id })).status).toBe(200);
  expect((await status(body.id as string)).running).toBe(false);
  expect(await portIsFree(port)).toBe(true);
  return port;
}

describe("a recorded port another program holds", () => {
  let holder: Server;
  let held = 0;

  beforeAll(async () => {
    held = recordedPorts("daemon-app").port!;
    holder = createNetServer();
    await new Promise<void>((resolveP, rejectP) => {
      holder.once("error", rejectP);
      holder.listen(held, "127.0.0.1", resolveP);
    });
  });

  afterAll(async () => {
    if (holder.listening) await new Promise((resolveP) => holder.close(resolveP));
  });

  it("start is 409 with the reason and the port, so the UI can offer another port", async () => {
    const res = await act({ action: "start", id: "daemon-app" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `'daemon-app' cannot start: its port ${held} is in use. Is 'daemon-app' already running at http://localhost:${held}?`,
      reason: "port-in-use",
      port: held,
    });
    expect(recordedPorts("daemon-app").port).toBe(held);
  });

  it("start with reassignPort moves the app to a new port and retires the held one", async () => {
    const moved = await startAndStop({ id: "daemon-app", reassignPort: true });
    expect(moved).not.toBe(held);
    expect(recordedPorts("daemon-app")).toEqual({ port: moved, retired: [held] });

    // The old port is free again, and the app keeps the port it moved to.
    await new Promise((resolveP) => holder.close(resolveP));
    expect(await startAndStop({ id: "daemon-app" })).toBe(moved);
  });
});

describe("a reinstall that the registry reports", () => {
  let registry: HttpServer;
  let row: Record<string, unknown>;

  beforeAll(async () => {
    // A stand-in local data server that answers only the registry listing.
    registry = createHttpServer((req, res) => {
      if (req.url === "/admin/apps") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ apps: [row] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveP) => registry.listen(0, "127.0.0.1", resolveP));
    const { port } = registry.address() as AddressInfo;
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL = NO_DATA_SERVER;
    await new Promise((resolveP) => registry.close(resolveP));
  });

  const installed = (installedAt: string, sourceDir: string | null) => {
    row = {
      appId: "daemon-app",
      status: "active",
      manifest: daemonAppManifest,
      sourceDir,
      installedAt,
    };
  };

  it("keeps the recorded port for the install the registry reports first", async () => {
    const before = recordedPorts("daemon-app").port;
    installed("2026-11-11 10:00:00", daemonAppDir);
    expect(await startAndStop({ id: "daemon-app" })).toBe(before);
  });

  it("gives a reinstalled app pinned to its folder a new port", async () => {
    const before = recordedPorts("daemon-app").port!;
    installed("2026-11-11 11:00:00", daemonAppDir);
    const after = await startAndStop({ id: "daemon-app" });
    expect(after).not.toBe(before);
    expect(recordedPorts("daemon-app").retired).toContain(before);
  });

  it("gives a reinstalled app found through the scan a new port", async () => {
    const before = recordedPorts("daemon-app").port!;
    installed("2026-11-11 12:00:00", null);
    const after = await startAndStop({ id: "daemon-app" });
    expect(after).not.toBe(before);
    expect(recordedPorts("daemon-app").retired).toContain(before);
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

describe("start failures are diagnosed, not silent", () => {
  it("a daemon that dies at startup fails the start with its log tail", async () => {
    const res = await act({ action: "start", id: "doa-app" });
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("exited during startup");
    expect(error).toContain("boom: turbopack build failed");
    // Confirmed-dead starts must not leave ghost pid/meta files behind.
    expect(existsSync(join(pidsDir, "doa-app.pid"))).toBe(false);
    expect(existsSync(join(pidsDir, "doa-app.meta.json"))).toBe(false);
    expect((await status("doa-app")).running).toBe(false);
  });

  it("a nonexistent localRun command fails the start with the spawn error", async () => {
    const res = await act({ action: "start", id: "nocmd-app" });
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("failed to spawn 'starkeep-no-such-command-xyzzy'");
  });

  it("an app with package.json but no node_modules is refused with a pnpm install hint", async () => {
    const res = await act({ action: "start", id: "nodeps-app" });
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("pnpm install");
    expect(error).toContain("nodeps-app");
    expect(error).toContain("left-pad");
    // Refused before spawning: no pid/meta files, nothing running.
    expect(existsSync(join(pidsDir, "nodeps-app.pid"))).toBe(false);
    expect((await status("nodeps-app")).running).toBe(false);
  });
});
