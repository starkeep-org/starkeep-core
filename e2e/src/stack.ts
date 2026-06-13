/**
 * Multi-process orchestration harness for Tier-2 e2e tests.
 *
 * Boots the real platform topology: a local-data-server child process (via
 * @starkeep/testkit) against a throwaway STARKEEP_DIR, plus `next dev`
 * instances of admin-web and drive on ephemeral ports, all wired together
 * through the same env vars production uses (STARKEEP_DATA_DIR,
 * STARKEEP_LOCAL_DATA_SERVER_URL, STARKEEP_DIR). Installed apps (photos) are
 * not booted here — installing them through the real admin-web API and
 * starting them through the real daemon route *is* test coverage, so specs do
 * that themselves via the helpers below.
 *
 * This module is the harness starkeep-apps/photos consumes for its own e2e
 * (sibling-checkout layout): everything exported from @starkeep/e2e.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort, startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Sibling checkout holding installable apps (photos). */
export const DEFAULT_APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");

// ---------------------------------------------------------------------------
// next dev child processes
// ---------------------------------------------------------------------------

export interface NextDevServer {
  url: string;
  port: number;
  child: ChildProcess;
  logs(): string;
  stop(): Promise<void>;
}

/**
 * Spawn `next dev -p <port>` in `appDir` and wait until `readyPath` responds
 * 200. Spawned detached (own process group) so stop() can take down next's
 * worker processes with it.
 */
export async function startNextDev(options: {
  appDir: string;
  env?: Record<string, string>;
  /** Path polled for readiness; default "/" (forces the first compile). */
  readyPath?: string;
  startTimeoutMs?: number;
}): Promise<NextDevServer> {
  const port = await getFreePort();
  // localhost, not 127.0.0.1: Next's dev-origin protection treats the bare IP
  // as cross-origin and silently drops the turbopack HMR websocket handshake,
  // which stalls hydration in the browser.
  const url = `http://localhost:${port}`;
  const nextBin = join(options.appDir, "node_modules/.bin/next");

  let output = "";
  const child = spawn(nextBin, ["dev", "-p", String(port)], {
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

  // Dev-mode Next compiles on demand; the first request is the slow one.
  const startTimeoutMs = options.startTimeoutMs ?? 180_000;
  const readyUrl = `${url}${options.readyPath ?? "/"}`;
  const deadline = Date.now() + startTimeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `next dev in ${options.appDir} exited before becoming ready.\n--- output ---\n${output}`,
      );
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
        `next dev in ${options.appDir} not ready on ${readyUrl} within ${startTimeoutMs}ms.\n--- output ---\n${output}`,
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
  /** Parent dirs scanned for installable apps. Default: the sibling starkeep-apps checkout. */
  appParentDirs?: string[];
  /** Boot the Drive UI (default true). */
  drive?: boolean;
}

export interface PlatformStack {
  lds: LocalDataServer;
  adminUrl: string;
  /** null when started with `drive: false`. */
  driveUrl: string | null;
  /** admin-web's STARKEEP_DATA_DIR (config.json, app-creds/, pids/). */
  adminDataDir: string;
  stop(): Promise<void>;
}

export async function startPlatformStack(
  options: PlatformStackOptions = {},
): Promise<PlatformStack> {
  const lds = await startLocalDataServer();

  // admin-web gets its own data dir, separate from the LDS's STARKEEP_DIR —
  // the same split a real machine has (~/.starkeep is shared, but here each
  // side is isolated so tests can't touch real operator state). The config is
  // written up front rather than relying on the config route's first-read
  // seeding, so discovery is deterministic.
  const adminDataDir = await mkdtemp(join(tmpdir(), "starkeep-e2e-admin-"));
  await writeFile(
    join(adminDataDir, "config.json"),
    JSON.stringify({ appParentDirs: options.appParentDirs ?? [DEFAULT_APPS_DIR] }, null, 2),
  );

  let admin: NextDevServer | undefined;
  let drive: NextDevServer | undefined;
  try {
    admin = await startNextDev({
      appDir: join(REPO_ROOT, "apps/admin-web"),
      readyPath: "/api/apps/list",
      env: {
        STARKEEP_DATA_DIR: adminDataDir,
        STARKEEP_LOCAL_DATA_SERVER_URL: lds.url,
      },
    });
    if (options.drive !== false) {
      drive = await startNextDev({
        appDir: join(REPO_ROOT, "apps/drive"),
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
// starkeep-apps e2e suites that test app functionality, not install UX.
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
  // localhost for the same dev-origin reason as startNextDev.
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
