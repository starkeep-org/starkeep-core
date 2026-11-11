import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { localDataServerUrlFromEnv } from "./local-daemon-urls";

/**
 * Each installed local app keeps one port, and so one browser origin, for as
 * long as it stays installed (#135). The browser keys `localStorage`,
 * IndexedDB and bookmarks by origin, and the origin includes the port, so a
 * new port on every start emptied the app's browser storage.
 *
 * - The first port tried is a hash of the app id and the instance's data
 *   server port into a range. Every machine's default instance uses data
 *   server port 9820, so an app usually gets the same port on every machine.
 *   Two instances on one machine must use different data server ports, so
 *   their copies of an app usually hash to different ports.
 * - Whatever port the app gets is recorded, and later starts reuse it. A hash
 *   collision therefore moves an app once, at its first start, and never
 *   again.
 * - The default range sits below every common OS ephemeral range (macOS
 *   49152+, Linux 32768+), so other programs rarely hold a recorded port, and
 *   above the highest port browsers refuse to load (10080).
 *   `STARKEEP_APP_PORT_RANGE` (`first-last`) moves it. A second Starkeep
 *   instance on one machine sets the variable, beside `STARKEEP_ADMIN_PORT`,
 *   `STARKEEP_PORT` and `STARKEEP_DRIVE_PORT`, so its apps can never land on
 *   the first instance's apps' ports, and so never share their origins. Each
 *   instance keeps its own record, so ranges are the only guarantee.
 * - A record is tied to the install it was made for, by the registry's
 *   `installedAt`. An uninstall, through any path, followed by an install
 *   gives the app a fresh port: the reinstalled app's local data is gone, so
 *   its browser storage goes too.
 * - A port given up that way stays reserved forever. No other app ever lands
 *   on an origin whose browser storage another app left behind.
 */
export const DEFAULT_APP_PORT_RANGE: PortRange = { first: 20000, last: 20999 };

export interface PortRange {
  first: number;
  last: number;
}

/** The range from `STARKEEP_APP_PORT_RANGE`, the default, or why the variable is wrong. */
export function appPortRangeFromEnv(
  value = process.env.STARKEEP_APP_PORT_RANGE,
): PortRange | { error: string } {
  if (value === undefined || value.trim() === "") return DEFAULT_APP_PORT_RANGE;
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(value);
  const first = match ? Number(match[1]) : NaN;
  const last = match ? Number(match[2]) : NaN;
  if (!match || first < 1024 || last > 65535 || first > last) {
    return {
      error: `STARKEEP_APP_PORT_RANGE is "${value}"; it must be two ports between 1024 and 65535, lowest first, such as "21000-21999".`,
    };
  }
  return { first, last };
}

/**
 * Ports at or above 1024 that browsers refuse to load a page from: the Fetch
 * standard's "bad ports". A custom range may include them; an app there would
 * run but never open.
 */
const BROWSER_BLOCKED_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

/** What sets this instance apart on one machine: its data server's port. */
export function instanceKeyFromEnv(): string {
  const url = new URL(localDataServerUrlFromEnv());
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

interface AppPortEntry {
  port: number;
  /** The registry's `installedAt` for the install this port belongs to. */
  installedAt?: string;
}

interface AppPortRecord {
  apps: Record<string, AppPortEntry>;
  /** Ports that once belonged to an install that is gone; never handed out again. */
  retired: number[];
}

export function appPortsFile(): string {
  return join(starkeepDir(), "app-ports.json");
}

function readRecord(file: string): AppPortRecord {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<AppPortRecord>;
    return { apps: parsed.apps ?? {}, retired: parsed.retired ?? [] };
  } catch {
    return { apps: {}, retired: [] };
  }
}

function writeRecord(file: string, record: AppPortRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, file);
}

/** The first port tried for an app: a hash of its id and the instance into the range. */
export function hashedPort(appId: string, instance: string, range: PortRange): number {
  const size = range.last - range.first + 1;
  const n = createHash("sha256").update(`${instance}\n${appId}`).digest().readUInt32BE(0);
  return range.first + (n % size);
}

/** Whether nothing listens on `port` on loopback, the address apps bind. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", () => resolveP(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolveP(true)));
  });
}

export type AppPortOutcome =
  | { ok: true; port: number }
  | { ok: false; port?: number; error: string };

export interface AppPortOptions {
  file?: string;
  range?: PortRange;
  /** What sets this instance apart on one machine; see {@link instanceKeyFromEnv}. */
  instance?: string;
  isFree?: (port: number) => Promise<boolean>;
}

// Starts are concurrent requests; one read-modify-write of the record at a time.
let queue: Promise<unknown> = Promise.resolve();

/**
 * The port `appId` runs on, recording a new one when the app has none for its
 * current install. `installedAt` is the registry's value, or undefined when
 * the registry cannot say; an unknown install never invalidates a record.
 *
 * Fails, without moving the app, when another process holds its recorded
 * port: moving the app would empty its browser storage, which is the bug this
 * module exists to prevent.
 */
export function appPort(
  appId: string,
  installedAt: string | undefined,
  options: AppPortOptions = {},
): Promise<AppPortOutcome> {
  const run = queue.then(() => assign(appId, installedAt, options));
  queue = run.catch(() => undefined);
  return run;
}

async function assign(
  appId: string,
  installedAt: string | undefined,
  {
    file = appPortsFile(),
    range: givenRange,
    instance = instanceKeyFromEnv(),
    isFree = portIsFree,
  }: AppPortOptions,
): Promise<AppPortOutcome> {
  const range = givenRange ?? appPortRangeFromEnv();
  if ("error" in range) return { ok: false, error: range.error };
  const record = readRecord(file);
  const current = record.apps[appId];

  if (current) {
    const otherInstall =
      installedAt !== undefined &&
      current.installedAt !== undefined &&
      current.installedAt !== installedAt;
    if (!otherInstall) {
      if (installedAt !== undefined && current.installedAt === undefined) {
        record.apps[appId] = { ...current, installedAt };
        writeRecord(file, record);
      }
      if (await isFree(current.port)) return { ok: true, port: current.port };
      return {
        ok: false,
        port: current.port,
        error: `'${appId}' cannot start: its port ${current.port} is in use. Is '${appId}' already running at http://localhost:${current.port}?`,
      };
    }
    record.retired.push(current.port);
    delete record.apps[appId];
  }

  const taken = new Set([...Object.values(record.apps).map((e) => e.port), ...record.retired]);
  const size = range.last - range.first + 1;
  const start = hashedPort(appId, instance, range) - range.first;
  for (let i = 0; i < size; i++) {
    const port = range.first + ((start + i) % size);
    if (taken.has(port) || BROWSER_BLOCKED_PORTS.has(port) || !(await isFree(port))) continue;
    record.apps[appId] = { port, ...(installedAt !== undefined ? { installedAt } : {}) };
    writeRecord(file, record);
    return { ok: true, port };
  }
  // Retiring the old port above is worth keeping even when no port is left.
  writeRecord(file, record);
  return {
    ok: false,
    error: `'${appId}' cannot start: no free port is left in ${range.first}–${range.last}. Ports in use or recorded in ${file} are skipped.`,
  };
}
