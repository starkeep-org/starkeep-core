/**
 * Child-process test harness for the local-data-server.
 *
 * Spawns `tsx apps/local-data-server/server.ts` against a throwaway
 * STARKEEP_DIR on an ephemeral port, waits for /health, and tears down.
 * When `STARKEEP_LDS_ENTRY` names a pre-bundled `server.mjs` it runs that with
 * plain `node` instead: apps/local-data-server's integration globalSetup builds
 * one per run so its ~60 spawns don't each pay tsx's transpile of the server.
 * Every other consumer leaves it unset and runs from source.
 * Child-process (rather than in-process) boot is deliberate: the server reads
 * its config at module load, and a real process is the honest test surface —
 * restarts, signal handling, and the per-startup file-token secret all behave
 * exactly as in production.
 *
 * Orphans are the hazard of that choice, and this harness closes both routes to
 * one: it reaps the detached replacement a PATCH /config restart leaves behind
 * (which is no longer its child), and it stamps every server it starts with
 * STARKEEP_EXIT_WITH_PID so a run that never reaches teardown still cannot leave
 * a cloud-syncing daemon behind.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_CLOUD_ACCOUNT } from "./fake-cloud.js";

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
  /**
   * Fixed port; defaults to an ephemeral free port. A fixed port gets one
   * attempt. An ephemeral port is retried on a fresh port when another process
   * takes it before the server binds it.
   */
  port?: number;
  /**
   * Picks the port for each ephemeral attempt; defaults to {@link getFreePort}.
   * Exists so the harness's own tests can hand it a taken port first.
   * @internal
   */
  pickPort?: () => Promise<number>;
  /**
   * Written to `<dir>/config.json` before boot (merged over the defaults the
   * server would generate). Use `apiGatewayUrl` to point the server at a fake
   * cloud responder.
   */
  config?: Record<string, unknown>;
  /** Extra environment for the child process. */
  env?: Record<string, string>;
  /**
   * Don't inject `STARKEEP_DIR` into the child env — instead let the server's
   * own `.env`-file loading resolve it (e.g. from a `.env.local` in the dir named
   * by a `STARKEEP_ENV_DIR` passed via `env`). Used to test the dotfile wiring:
   * the server must independently arrive at `starkeepDir`, not be told it.
   */
  loadDirFromEnvFile?: boolean;
  /** Milliseconds to wait for /health before failing. */
  startTimeoutMs?: number;
  /**
   * Whether to sign this machine in once it is up. By default, whenever
   * `config.apiGatewayUrl` names a cloud, the harness points the server at that
   * fake cloud's pool and signs in with {@link FAKE_CLOUD_ACCOUNT}, as a person
   * signs a machine in, so sync starts. `false` boots signed out, as a machine
   * nobody has signed in yet, and leaves the pool endpoint to `env`; a test
   * against a real cloud always passes `false`. A reused dir that already
   * holds a sign-in keeps it.
   */
  signIn?: false;
}

export interface LocalDataServer {
  /** Base URL, e.g. http://127.0.0.1:53124 */
  url: string;
  port: number;
  starkeepDir: string;
  child: ChildProcess;
  /** Combined stdout+stderr captured so far (for debugging assertions). */
  logs(): string;
  /**
   * Pids of the detached replacements a PATCH /config restart spawned, oldest
   * first. Empty unless the server restarted itself. stop() reaps these.
   */
  successorPids(): number[];
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

interface Boot {
  port: number;
  url: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  successors: number[];
  output(): string;
  healthy: boolean;
  /** The child died before it became healthy (as opposed to timing out). */
  exitedEarly: boolean;
}

// Printed by server.ts from its own listen callback, so seeing it proves this
// child holds the port. /health alone cannot: when another test's server holds
// the port, it answers /health for a child that is about to die of EADDRINUSE.
const LISTENING_LINE = "Starkeep data server listening on";

/** Spawns one server on `port` and waits until it is healthy, dies, or times out. */
async function bootOnce(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  port: number,
  startTimeoutMs: number,
): Promise<Boot> {
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  // A PATCH /config restart replaces the server with a *detached* process that
  // is not our child, so `child` stops naming the thing that has to be killed.
  // The outgoing server prints its replacement's pid on the way out; collect
  // those so stop() reaps whoever is actually serving. Only the first
  // replacement announces itself here — later ones log to a file under
  // STARKEEP_DIR, not to this pipe — which is why STARKEEP_EXIT_WITH_PID
  // still has to be the general answer.
  let output = "";
  const successors: number[] = [];
  let partialLine = "";
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    const lines = (partialLine + text).split("\n");
    partialLine = lines.pop() ?? "";
    for (const line of lines) {
      const match = /\[server\] Restarted as pid (\d+)/.exec(line);
      if (match) successors.push(Number(match[1]));
    }
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);

  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });
  // "close" fires once the child has exited *and* its pipes are drained, so the
  // crash text (EADDRINUSE included) is in `output` by then.
  const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;

  const deadline = Date.now() + startTimeoutMs;
  let healthy = false;
  while (Date.now() < deadline && !hasExited()) {
    if (output.includes(LISTENING_LINE)) {
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const exitedEarly = !healthy && hasExited();
  // Bounded: a grandchild (tsx runs the server in one) could hold the pipes open.
  if (exitedEarly) await Promise.race([closed, new Promise((r) => setTimeout(r, 2_000))]);
  return { port, url, child, exited, successors, output: () => output, healthy, exitedEarly };
}

export async function startLocalDataServer(
  options: LocalDataServerOptions = {},
): Promise<LocalDataServer> {
  const ownsDir = options.starkeepDir === undefined;
  const starkeepDir = options.starkeepDir ?? (await mkdtemp(join(tmpdir(), "starkeep-lds-")));
  if (options.config) {
    await mkdir(starkeepDir, { recursive: true });
    // nodeId must be unique per replica; provide one so the server doesn't
    // need its first-boot generation path when a partial config is given.
    const config = { nodeId: `test-${randomUUID()}`, ...options.config };
    await writeFile(join(starkeepDir, "config.json"), JSON.stringify(config, null, 2));
  }

  // The cloud this machine syncs with: the given config's, or, on a restart in
  // a reused dir, the config the machine already holds.
  let cloudUrl: unknown = options.config?.["apiGatewayUrl"];
  if (cloudUrl === undefined && !options.config) {
    try {
      cloudUrl = (
        JSON.parse(await readFile(join(starkeepDir, "config.json"), "utf8")) as Record<
          string,
          unknown
        >
      )["apiGatewayUrl"];
    } catch {
      // A fresh dir has no config yet.
    }
  }
  const signIn = typeof cloudUrl === "string" && options.signIn !== false;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // The fake cloud plays the pool at a fixed path under its own address. Set
    // only when the harness signs in, which is only against a fake cloud: a
    // real cloud's pool is Cognito itself, and a test that signs in on its own
    // passes the endpoint it means in `env`.
    ...(signIn && typeof cloudUrl === "string"
      ? { STARKEEP_COGNITO_ENDPOINT: `${cloudUrl.replace(/\/+$/, "")}/cognito/` }
      : {}),
    // Backstop against orphans. Teardown is not guaranteed to run — a killed
    // runner, a hung spec, a failure before the `finally` — and the server the
    // PATCH /config restart leaves behind is detached from us anyway. This tells
    // every server in the chain (the env is inherited across the respawn) to
    // exit once this test process is gone, so a missed teardown self-heals in
    // seconds instead of leaving a cloud-syncing daemon running for days.
    STARKEEP_EXIT_WITH_PID: String(process.pid),
    ...options.env,
  };
  if (options.loadDirFromEnvFile) {
    // The server must resolve STARKEEP_DIR from its own .env-file loading; make
    // sure neither our injection nor an inherited shell export shortcuts that.
    delete childEnv.STARKEEP_DIR;
  } else {
    childEnv.STARKEEP_DIR = starkeepDir;
  }
  // A pre-bundled entry, when the caller's run built one, skips tsx's per-spawn
  // transpile; otherwise run from source.
  const bundledEntry = process.env.STARKEEP_LDS_ENTRY;
  const [command, args] = bundledEntry
    ? [process.execPath, [bundledEntry]]
    : [TSX_BIN, [SERVER_ENTRY]];
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;

  // An ephemeral port can be lost between getFreePort() releasing it and the
  // child binding it: another server in the parallel test run takes it, and the
  // child dies with EADDRINUSE. Retry those on a fresh port. A fixed port is the
  // caller's choice, so a clash with it is the caller's failure to see.
  const pickPort = options.pickPort ?? getFreePort;
  const maxAttempts = options.port === undefined ? 3 : 1;
  let attempt = 0;
  let boot: Boot;
  for (;;) {
    attempt++;
    const port = options.port ?? (await pickPort());
    boot = await bootOnce(
      command,
      args,
      { ...childEnv, STARKEEP_PORT: String(port) },
      port,
      startTimeoutMs,
    );
    if (boot.healthy) break;
    boot.child.kill("SIGKILL");
    if (boot.exitedEarly && /EADDRINUSE/.test(boot.output()) && attempt < maxAttempts) continue;
    if (ownsDir) await rm(starkeepDir, { recursive: true, force: true });
    const why = boot.exitedEarly
      ? `exited (code ${String(boot.child.exitCode)}, signal ${String(boot.child.signalCode)}) before becoming healthy`
      : `did not become healthy within ${startTimeoutMs}ms`;
    throw new Error(
      `local-data-server on ${boot.url} ${why} (attempt ${attempt} of ${maxAttempts}).\n--- output ---\n${boot.output()}`,
    );
  }
  const { port, url, child, exited, successors } = boot;
  const output = boot.output;

  if (signIn) {
    const status = (await (await fetch(`${url}/auth/status`)).json()) as { state?: string };
    if (status.state !== "signed-in") {
      const res = await fetch(`${url}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(FAKE_CLOUD_ACCOUNT),
      });
      if (!res.ok) {
        child.kill("SIGKILL");
        if (ownsDir) await rm(starkeepDir, { recursive: true, force: true });
        throw new Error(
          `local-data-server could not sign in to ${String(cloudUrl)}: ${res.status} ${await res.text()}\n` +
            `--- output ---\n${output()}`,
        );
      }
    }
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: alive, just not ours to signal.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async function terminate(): Promise<void> {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killTimer);
    }
    // Usually empty; only a restart test gets here with anything to reap.
    if (successors.length === 0) return;
    for (const pid of successors) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    // Wait for them before the caller deletes the data dir out from under a
    // replacement that is still draining, then insist.
    const deadline = Date.now() + 5_000;
    while (successors.some(isAlive) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const pid of successors.filter(isAlive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  return {
    url,
    port,
    starkeepDir,
    child,
    logs: output,
    successorPids: () => [...successors],
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
