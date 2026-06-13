/**
 * Child-process test harness for the local-data-server.
 *
 * Spawns `tsx apps/local-data-server/server.ts` against a throwaway
 * STARKEEP_DIR on an ephemeral port, waits for /health, and tears down.
 * Child-process (rather than in-process) boot is deliberate: the server reads
 * its config at module load, and a real process is the honest test surface —
 * restarts, signal handling, and the per-startup file-token secret all behave
 * exactly as in production.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_ENTRY = join(REPO_ROOT, "apps/local-data-server/server.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");

export interface LocalDataServerOptions {
  /**
   * Reuse an existing STARKEEP_DIR instead of creating a fresh temp dir —
   * used by restart-durability tests. The harness will not delete a dir it
   * did not create.
   */
  starkeepDir?: string;
  /** Fixed port; defaults to an ephemeral free port. */
  port?: number;
  /**
   * Written to `<dir>/config.json` before boot (merged over the defaults the
   * server would generate). Use `apiGatewayUrl` to point the server at a fake
   * cloud responder.
   */
  config?: Record<string, unknown>;
  /** Extra environment for the child process. */
  env?: Record<string, string>;
  /** Milliseconds to wait for /health before failing. */
  startTimeoutMs?: number;
  /**
   * Written to `<dir>/auth.json` before boot. The server's id-token liveness
   * gate only decodes the JWT `exp` claim locally (no signature check), so a
   * `fakeIdToken()` here is enough to let the sync supervisor start against a
   * fake cloud.
   */
  auth?: { idToken: string; refreshToken?: string };
}

/**
 * An unsigned JWT whose payload carries a far-future (or caller-chosen) `exp`,
 * sufficient for the local-data-server's local-only liveness check.
 */
export function fakeIdToken(expiresInSeconds = 3600): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = encode({ alg: "none", typ: "JWT" });
  const payload = encode({
    sub: "test-user",
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
  return `${header}.${payload}.fake-signature`;
}

export interface LocalDataServer {
  /** Base URL, e.g. http://127.0.0.1:53124 */
  url: string;
  port: number;
  starkeepDir: string;
  child: ChildProcess;
  /** Combined stdout+stderr captured so far (for debugging assertions). */
  logs(): string;
  /** Resolves when the child exits (e.g. after PATCH /config). */
  waitForExit(timeoutMs?: number): Promise<number | null>;
  /** SIGTERM, wait, SIGKILL fallback. Removes the temp dir it created. */
  stop(): Promise<void>;
  /** Stop the process but keep the data dir (for restart tests). */
  stopKeepData(): Promise<void>;
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close(() => reject(new Error("could not allocate a port")));
        return;
      }
      const port = address.port;
      srv.close(() => resolvePort(port));
    });
  });
}

export async function startLocalDataServer(
  options: LocalDataServerOptions = {},
): Promise<LocalDataServer> {
  const ownsDir = options.starkeepDir === undefined;
  const starkeepDir =
    options.starkeepDir ?? (await mkdtemp(join(tmpdir(), "starkeep-lds-")));
  const port = options.port ?? (await getFreePort());
  const url = `http://127.0.0.1:${port}`;

  if (options.config) {
    await mkdir(starkeepDir, { recursive: true });
    // nodeId must be unique per replica; provide one so the server doesn't
    // need its first-boot generation path when a partial config is given.
    const config = { nodeId: `test-${port}-${Date.now()}`, ...options.config };
    await writeFile(join(starkeepDir, "config.json"), JSON.stringify(config, null, 2));
  }

  if (options.auth) {
    await mkdir(starkeepDir, { recursive: true });
    const auth = {
      refreshToken: options.auth.refreshToken ?? "test-refresh-token",
      idToken: options.auth.idToken,
    };
    await writeFile(join(starkeepDir, "auth.json"), JSON.stringify(auth, null, 2));
  }

  let output = "";
  const child = spawn(TSX_BIN, [SERVER_ENTRY], {
    env: {
      ...process.env,
      STARKEEP_DIR: starkeepDir,
      STARKEEP_PORT: String(port),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });

  // Wait for /health (or early exit).
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const deadline = Date.now() + startTimeoutMs;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!healthy) {
    child.kill("SIGKILL");
    if (ownsDir) await rm(starkeepDir, { recursive: true, force: true });
    throw new Error(
      `local-data-server did not become healthy on ${url} within ${startTimeoutMs}ms.\n--- output ---\n${output}`,
    );
  }

  async function terminate(): Promise<void> {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killTimer);
    }
  }

  return {
    url,
    port,
    starkeepDir,
    child,
    logs: () => output,
    async waitForExit(timeoutMs = 10_000) {
      const timeout = new Promise<never>((_, rejectExit) =>
        setTimeout(() => rejectExit(new Error("server did not exit in time")), timeoutMs),
      );
      return Promise.race([exited, timeout]);
    },
    async stop() {
      await terminate();
      if (ownsDir) await rm(starkeepDir, { recursive: true, force: true });
    },
    async stopKeepData() {
      await terminate();
    },
  };
}
