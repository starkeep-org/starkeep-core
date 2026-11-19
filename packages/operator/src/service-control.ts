/**
 * Start a service by name and report whether it runs: the steps behind
 * admin-web's Start button and its status probe, and behind `starkeep start`
 * and `starkeep status`.
 *
 * A service is a workspace daemon (`local-data-server`, `drive`) or an
 * installed app with a `localRun` block in its manifest.
 */
import { createConnection } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveInstallCommand,
  type CommandSource,
} from "@starkeep/admin-installer/approved-commands";
import { appPort } from "./app-ports";
import { appSource } from "./apps";
import {
  PIDS_DIR,
  adoptOrphanWorkspaceDaemon,
  isAlive,
  isWorkspaceDaemonId,
  liveDaemon,
  pidFile,
  spawnDaemon,
  startWorkspaceDaemon,
  type StartSuccess,
} from "./daemons";

interface LocalRunBlock {
  command: string;
  args?: string[];
  portFlag?: string;
  cwd?: string;
}

/**
 * Why a start was refused before or after spawning. `status` is the HTTP
 * status admin-web answers with. `port-in-use` carries the held port, so a
 * caller can offer to move the app to another one.
 */
export interface StartRefusal {
  ok: false;
  error: string;
  status: 400 | 404 | 409 | 500;
  reason?: "port-in-use";
  port?: number;
  logPath?: string;
}

export type ServiceStartOutcome = StartSuccess | StartRefusal;

export interface StartServiceOptions {
  /** Move the app off a recorded port another program holds. */
  reassignPort?: boolean;
}

/** Start a workspace daemon or an installed app. */
export async function startService(
  id: string,
  options: StartServiceOptions = {},
): Promise<ServiceStartOutcome> {
  if (isWorkspaceDaemonId(id)) {
    // Fixed-port workspace daemon: startWorkspaceDaemon preflights the port
    // (adopting an orphaned instance rather than colliding with it) and
    // verifies the spawn actually came up.
    const outcome = await startWorkspaceDaemon(id);
    return outcome.ok ? outcome : { ...outcome, status: 500 };
  }

  // Installed-app daemon: spawn shape comes from the app's manifest, not a
  // hand-curated map. Apps without a localRun block can be installed but
  // not started. An installed app runs from the folder Install pinned, with
  // the manifest the user approved there.
  const found = await appSource(id);
  if (found.kind === "not-found") {
    return {
      ok: false,
      status: 404,
      error: `No manifest found for app '${id}' in configured app parent dirs`,
    };
  }
  if (found.kind === "pinned-missing") {
    return {
      ok: false,
      status: 409,
      error: `'${id}' cannot start: its source folder ${found.appDir} no longer holds a starkeep.manifest.json. Restore the folder to start it. Uninstalling and installing from a new folder deletes the app's data on this machine.`,
    };
  }
  const localRun = found.manifest.localRun as LocalRunBlock | undefined;
  if (!localRun || typeof localRun.command !== "string") {
    return {
      ok: false,
      status: 400,
      error: `App '${id}' has no localRun block in its manifest, so it cannot be started here.`,
    };
  }
  // A page whose status is stale, such as a second tab, can still offer
  // Start for an app that already runs. A second copy would overwrite the pid
  // and meta files, and Stop would lose the first copy. A reassign would
  // also retire the port the running copy serves on. The answer carries no
  // `reason`, so the UI offers no other port.
  const live = liveDaemon(id);
  if (live) {
    return {
      ok: false,
      status: 409,
      error:
        live.port !== undefined
          ? `'${id}' is already running at http://localhost:${live.port}.`
          : `'${id}' is already running.`,
    };
  }
  const spawnArgs = [...(localRun.args ?? [])];
  let port: number | undefined;
  if (localRun.portFlag) {
    // One port until a reinstall or a reassign, so the app's browser
    // origin, and with it the app's localStorage and IndexedDB, survives
    // restarts (#135). A held port answers with its reason and port, so the
    // UI can offer to choose another port.
    const assigned = await appPort(id, found.installedAt, {
      reassign: options.reassignPort === true,
    });
    if (!assigned.ok) {
      return assigned.reason === "port-in-use"
        ? {
            ok: false,
            status: 409,
            error: assigned.error,
            reason: assigned.reason,
            port: assigned.port,
          }
        : { ok: false, status: 409, error: assigned.error };
    }
    port = assigned.port;
    spawnArgs.push(localRun.portFlag, String(port));
  }
  const cwd = resolve(found.appDir, localRun.cwd ?? ".");
  const outcome = await spawnDaemon({
    id,
    command: localRun.command,
    args: spawnArgs,
    cwd,
    port,
    install: resolveInstallCommand(found.appDir, found.manifest as CommandSource),
  });
  return outcome.ok ? outcome : { ...outcome, status: 500 };
}

export interface ServiceStatus {
  running: boolean;
  pid?: number;
  port?: number;
  /** Set when the probe found an orphaned workspace daemon and re-recorded it. */
  adopted?: boolean;
}

function tryHost(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => {
      socket.destroy();
      done(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
  });
}

export function isPortBound(port: number): Promise<boolean> {
  return tryHost("127.0.0.1", port).then((ok) => ok || tryHost("::1", port));
}

/** Whether a service runs, by its pid record and, when known, its port. */
export async function serviceStatus(id: string): Promise<ServiceStatus> {
  const pf = pidFile(id);
  if (!existsSync(pf)) {
    // No pid file, but a workspace daemon has a fixed port we can still check:
    // an orphaned instance (pid file lost in a crash or bad stop) would
    // otherwise show as not-running, offering a Start that collides with the
    // port. Adopt it so status shows Running and Stop works.
    if (isWorkspaceDaemonId(id)) {
      const adopted = adoptOrphanWorkspaceDaemon(id);
      if (adopted) return { running: true, pid: adopted.pid, port: adopted.port, adopted: true };
    }
    return { running: false };
  }

  // A workspace daemon that replaced itself (the local-data-server does exactly
  // that on PATCH /config, with a detached successor) leaves this file naming
  // the launcher that exited alongside the old instance. Re-point it at
  // whatever holds the fixed port, so the pid reported here — and the one Stop
  // will later signal — is the process actually serving.
  let pid = parseInt(readFileSync(pf, "utf-8"), 10);
  if (isWorkspaceDaemonId(id) && !isAlive(pid)) {
    pid = adoptOrphanWorkspaceDaemon(id)?.pid ?? pid;
  }

  const metaPath = resolve(PIDS_DIR, `${id}.meta.json`);
  let meta: { pid: number; port?: number } | null = null;
  try {
    meta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, "utf-8")) as { pid: number; port?: number })
      : null;
  } catch {
    meta = null;
  }

  // For daemons with a known port, prefer the port: the stored pid is pnpm's
  // launcher, which may exit once the app's own server takes over.
  const running = meta?.port ? await isPortBound(meta.port) : isAlive(pid);

  // Only clean up if the process is actually gone. A transient "port not yet
  // bound" reading during startup must not delete the pid/meta files — the
  // child may still be spinning up and will bind shortly.
  if (!running && !isAlive(pid)) {
    unlinkSync(pf);
    if (existsSync(metaPath)) unlinkSync(metaPath);
  }

  return running
    ? { running, pid, ...(meta?.port !== undefined ? { port: meta.port } : {}) }
    : { running };
}
