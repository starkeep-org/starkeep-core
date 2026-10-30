/**
 * Where this instance's local daemons listen, as admin-web's server side
 * reaches them.
 *
 * Server-side only, because it reads the process environment. The browser
 * learns the same addresses from `/api/runtime-config`, whose handler reads them
 * here, through `lib/runtime-config.ts`. Routes must not use that browser
 * accessor: it fetches a relative URL, which fails in Node and falls back to the
 * loopback defaults, so a route that used it reached the default daemon
 * whatever this instance's environment said.
 *
 * An explicit URL wins, for the e2e harness. Otherwise the address follows the
 * port variable that `exec-commands.ts` spawns the daemon with, so a second
 * Starkeep instance on one machine needs only `STARKEEP_PORT` and
 * `STARKEEP_DRIVE_PORT`. Read per call, not captured at load.
 */
import { daemonPort } from "./exec-commands";

export function localDataServerUrlFromEnv(): string {
  return (
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL ??
    `http://127.0.0.1:${daemonPort("STARKEEP_PORT", 9820)}`
  );
}

export function driveUrlFromEnv(): string {
  return (
    process.env.STARKEEP_DRIVE_URL ?? `http://localhost:${daemonPort("STARKEEP_DRIVE_PORT", 9830)}`
  );
}
