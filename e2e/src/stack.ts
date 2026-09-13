/**
 * Multi-process orchestration harness for Tier-2 e2e tests.
 *
 * Boots the real platform topology: a local-data-server child process (via
 * @starkeep/testkit) against a throwaway STARKEEP_DIR, plus web-server
 * instances of admin-web and drive on ephemeral ports, all wired together
 * through the same env vars production uses (STARKEEP_DIR,
 * STARKEEP_LOCAL_DATA_SERVER_URL). Installed apps are not booted here —
 * installing them through the real admin-web API and starting them through the
 * real daemon route *is* test coverage, so specs do that themselves via the
 * helpers below.
 *
 * The harness names no app. `appParentDirs` is required rather than defaulted,
 * because a default is how a platform harness acquires an opinion about which
 * apps exist: core's own suites point it at the Probe fixture in `test-apps/`,
 * and an app's suite points it at its own checkout. This module is the harness
 * app repositories consume for their e2e — everything exported from
 * `@starkeep/e2e`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort, startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/**
 * Core's own fixture apps. The parent dir core's suites scan — it holds Probe,
 * the conforming app the platform tests itself against.
 */
export const CORE_FIXTURE_APPS_DIR = resolve(REPO_ROOT, "test-apps");

// ---------------------------------------------------------------------------
// Web-server child processes
// ---------------------------------------------------------------------------

export interface WebServer {
  url: string;
  port: number;
  child: ChildProcess;
  logs(): string;
  stop(): Promise<void>;
}

export interface WebServerOptions {
  appDir: string;
  env?: Record<string, string>;
  /** Path polled for readiness; default "/". */
  readyPath?: string;
  startTimeoutMs?: number;
  /**
   * What to spawn, and how the allocated port reaches it. Every app's server
   * half is a plain Node process now: `node dist/server.js`, or `tsx
   * src/server.ts` for one that runs from its checkout.
   */
  command?: string;
  /** The entry and any flags, before the port. Required. */
  args?: string[];
  /** The flag the port is passed on. Default `--port`. */
  portFlag?: string;
}

/**
 * Spawn an app's web server on a free port and wait until `readyPath` responds
 * 200. Spawned detached (own process group) so stop() can take down the
 * server's worker processes with it.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const port = await getFreePort();
  // localhost, not 127.0.0.1: every spec gets one origin, so a cookie a server
  // sets under one host is readable under the other.
  const url = `http://localhost:${port}`;

  if (!options.args?.length) {
    throw new Error("startWebServer() needs args naming the server entry");
  }

  const command = options.command ?? process.execPath;
  const args = [...options.args, options.portFlag ?? "--port", String(port)];

  let output = "";
  const child = spawn(command, args, {
    cwd: options.appDir,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });

  const label = `${command} in ${options.appDir}`;

  async function stop(): Promise<void> {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const killTimer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 5_000);
      await exited;
      clearTimeout(killTimer);
    }
  }

  const startTimeoutMs = options.startTimeoutMs ?? 180_000;
  const readyUrl = `${url}${options.readyPath ?? "/"}`;
  const deadline = Date.now() + startTimeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before becoming ready.\n--- output ---\n${output}`);
    }
    try {
      const res = await fetch(readyUrl, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(
        `${label} not ready on ${readyUrl} within ${startTimeoutMs}ms.\n--- output ---\n${output}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return { url, port, child, logs: () => output, stop };
}

// ---------------------------------------------------------------------------
// The platform stack
// ---------------------------------------------------------------------------

export interface PlatformStackOptions {
  /**
   * Parent dirs scanned for installable apps. Required: the harness has no
   * business deciding which apps a deployment has, and a default here would
   * make every caller inherit whichever one it picked.
   */
  appParentDirs: string[];
  /** Boot the Drive UI (default true). */
  drive?: boolean;
}

export interface PlatformStack {
  lds: LocalDataServer;
  adminUrl: string;
  /** null when started with `drive: false`. */
  driveUrl: string | null;
  /** admin-web's STARKEEP_DIR (config.json, app-creds/, pids/). */
  adminDataDir: string;
  /**
   * The ports admin-web believes its workspace daemons use — reserved free
   * ports, never the real 9820/9830 (see the env it is booted with). Tests that
   * need to occupy a daemon's port bind these.
   */
  daemonPorts: { localDataServer: number; drive: number };
  stop(): Promise<void>;
}

export async function startPlatformStack(options: PlatformStackOptions): Promise<PlatformStack> {
  if (!options.appParentDirs?.length) {
    throw new Error(
      "startPlatformStack needs appParentDirs: name the parent dir holding the " +
        "apps under test (core's suites pass CORE_FIXTURE_APPS_DIR; an app's own " +
        "suite passes its checkout).",
    );
  }
  const lds = await startLocalDataServer();

  // admin-web gets its own STARKEEP_DIR, isolated from the LDS's, so tests
  // can't touch real operator state. (On a real machine admin-web and the LDS
  // share one ~/.starkeep; this harness only exercises admin-web's local
  // install/list/config paths — config.json + app-creds/ + pids/ — which never
  // read the LDS's data.db, so the dirs can stay separate here.) The config is
  // written up front rather than relying on the config route's first-read
  // seeding, so discovery is deterministic.
  const adminDataDir = await mkdtemp(join(tmpdir(), "starkeep-e2e-admin-"));
  await writeFile(
    join(adminDataDir, "config.json"),
    JSON.stringify({ appParentDirs: options.appParentDirs }, null, 2),
  );

  // admin-web resolves its workspace daemons' ports from the same env vars the
  // daemons themselves read (see exec-commands). Point them at reserved free
  // ports so a test can never probe — or adopt, or SIGTERM on teardown — a real
  // daemon the operator is running on 9820/9830. The stack's own LDS and drive
  // are started here on their own ephemeral ports, not through these.
  const daemonPorts = {
    localDataServer: await getFreePort(),
    drive: await getFreePort(),
  };

  let admin: WebServer | undefined;
  let drive: WebServer | undefined;
  try {
    // admin-web is the first app off the framework: its server is a plain Node
    // process serving a built client, so the harness starts what an operator
    // starts rather than a dev server. `tsx` runs the TypeScript entry directly,
    // the way `apps/local-data-server` is run.
    const adminDir = join(REPO_ROOT, "apps/admin-web");
    admin = await startWebServer({
      appDir: adminDir,
      command: join(adminDir, "node_modules/.bin/tsx"),
      args: ["src/server.ts"],
      readyPath: "/api/apps/list",
      env: {
        STARKEEP_DIR: adminDataDir,
        STARKEEP_LOCAL_DATA_SERVER_URL: lds.url,
        STARKEEP_PORT: String(daemonPorts.localDataServer),
        STARKEEP_DRIVE_PORT: String(daemonPorts.drive),
      },
    });
    if (options.drive !== false) {
      const driveDir = join(REPO_ROOT, "apps/drive");
      drive = await startWebServer({
        appDir: driveDir,
        command: join(driveDir, "node_modules/.bin/tsx"),
        args: ["src/server.ts"],
        readyPath: "/api/types",
        env: {
          // Drive reads the LDS registry SQLite directly for its HMAC secret.
          STARKEEP_DIR: lds.starkeepDir,
          STARKEEP_LOCAL_DATA_SERVER_URL: lds.url,
        },
      });
    }
  } catch (err) {
    await drive?.stop();
    await admin?.stop();
    await lds.stop();
    await rm(adminDataDir, { recursive: true, force: true });
    throw err;
  }

  async function stop(): Promise<void> {
    // App daemons spawned by admin-web's daemon route are detached process
    // groups recorded in <adminDataDir>/pids; take them down first so nothing
    // keeps talking to the LDS while it shuts down.
    await killRecordedDaemons(adminDataDir);
    await drive?.stop();
    await admin!.stop();
    await lds.stop();
    await rm(adminDataDir, { recursive: true, force: true });
  }

  return {
    lds,
    adminUrl: admin.url,
    driveUrl: drive?.url ?? null,
    adminDataDir,
    daemonPorts,
    stop,
  };
}

/** SIGTERM every process group recorded in <dataDir>/pids/*.pid. */
async function killRecordedDaemons(dataDir: string): Promise<void> {
  const pidsDir = join(dataDir, "pids");
  let entries: string[];
  try {
    entries = await readdir(pidsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".pid")) continue;
    const pid = parseInt(await readFile(join(pidsDir, entry), "utf-8"), 10);
    if (Number.isNaN(pid)) continue;
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGTERM");
        break;
      } catch {
        /* group/process already gone */
      }
    }
  }
  // Give daemons a moment to release their ports before the LDS goes away.
  await new Promise((r) => setTimeout(r, 500));
}

// ---------------------------------------------------------------------------
// App lifecycle through the real admin-web API. The UI specs drive these
// flows through the browser; these helpers exist for setup/teardown and for
// app-repository e2e suites that test app functionality, not install UX.
// ---------------------------------------------------------------------------

async function adminPost(adminUrl: string, path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${adminUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function installAppViaAdmin(adminUrl: string, appId: string): Promise<void> {
  await adminPost(adminUrl, "/api/apps/install", { appId, approved: true });
}

export async function uninstallAppViaAdmin(adminUrl: string, appId: string): Promise<void> {
  await adminPost(adminUrl, "/api/apps/uninstall", { appId });
}

/**
 * Start an installed app's dev server through the real daemon route, then
 * wait until it serves 200 on "/". Returns its base URL.
 */
export async function startAppDaemonViaAdmin(
  adminUrl: string,
  appId: string,
  { startTimeoutMs = 180_000 }: { startTimeoutMs?: number } = {},
): Promise<{ url: string; port: number }> {
  const res = await adminPost(adminUrl, "/api/exec/daemon", {
    action: "start",
    id: appId,
  });
  const { port } = (await res.json()) as { port?: number };
  if (!port) {
    throw new Error(`daemon start for ${appId} returned no port`);
  }
  // localhost for the same dev-origin reason as startWebServer.
  const url = `http://localhost:${port}`;
  await eventually(
    async () => {
      const probe = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!probe.ok) throw new Error(`${appId} on ${url} → ${probe.status}`);
    },
    { timeoutMs: startTimeoutMs, intervalMs: 500 },
  );
  return { url, port };
}

export async function stopAppDaemonViaAdmin(adminUrl: string, appId: string): Promise<void> {
  await adminPost(adminUrl, "/api/exec/daemon", { action: "stop", id: appId });
  await eventually(async () => {
    const res = await fetch(`${adminUrl}/api/exec/daemon/status?id=${encodeURIComponent(appId)}`);
    const { running } = (await res.json()) as { running: boolean };
    if (running) throw new Error(`${appId} still running`);
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Poll until `fn` stops throwing, or fail with its last error after `timeoutMs`. */
export async function eventually<T>(
  fn: () => Promise<T> | T,
  { timeoutMs = 15_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
