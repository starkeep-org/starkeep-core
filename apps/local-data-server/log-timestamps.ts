/**
 * Prefix every console line this process writes with the wall-clock time.
 *
 * admin-web hands the daemon a plain file descriptor for stdout and stderr, so
 * nothing downstream stamps a line. Without a time on each line the log can say
 * what happened but never when, and a sync-latency question becomes an
 * archaeology of S3 `LastModified` values, `resident_keys.added_at_ms` and HLC
 * physical times. See `findings-phone-to-desktop-sync-latency-2026-10-14.md`.
 *
 * Local time with its UTC offset, not `toISOString()`'s UTC: the person reading
 * this log reads it against their own clock, `pmset` sleep records and the
 * phone's screen, and every one of those is local.
 *
 * Imported for its side effect, first, so lines written during startup are
 * stamped too.
 */

export function localIsoTimestamp(date: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const STAMPED = Symbol.for("starkeep.console.timestamped");

export function timestampConsole(): void {
  const target = console as Console & { [STAMPED]?: boolean };
  // A second import — a test that loads the server module twice, a reload
  // under `tsx --watch` — must not stamp each line twice.
  if (target[STAMPED]) return;
  target[STAMPED] = true;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => original(localIsoTimestamp(), ...args);
  }
}

timestampConsole();
