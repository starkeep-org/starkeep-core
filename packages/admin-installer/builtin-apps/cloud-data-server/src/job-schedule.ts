/**
 * When a scheduled job next runs: the next instant at one wall-clock time of
 * day in one IANA time zone.
 *
 * Two clock changes need a rule:
 *
 * - **Spring forward.** A time inside the skipped hour does not exist that
 *   day. The run moves to the first minute after the gap, so 02:30 on the day
 *   Los Angeles jumps from 02:00 to 03:00 runs at 03:00.
 * - **Fall back.** A time inside the repeated hour happens twice. The run
 *   takes the first occurrence and never runs twice.
 *
 * The offsets come from `Intl.DateTimeFormat`, so the runtime's zone data
 * decides. An unknown zone reads as UTC, because a stored zone the runtime
 * no longer knows must still produce a time rather than stop the job.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether the runtime knows `timeZone` as an IANA zone. */
export function isKnownTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** `timeZone` when the runtime knows it, or `"UTC"`. */
export function zoneOrUtc(timeZone: string | null | undefined): string {
  return timeZone && isKnownTimeZone(timeZone) ? timeZone : "UTC";
}

/** Every zone the consent page offers, UTC first. */
export function selectableTimeZones(): string[] {
  const zones = Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC");
  return ["UTC", ...zones];
}

/** A time of day as `HH:MM`, from 00:00 to 23:59. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallAt(t: number, timeZone: string): Wall & { second: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(t))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** The zone's offset from UTC at instant `t`, in milliseconds. */
function offsetAt(t: number, timeZone: string): number {
  const w = wallAt(t, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

function sameWall(a: Wall, b: Wall): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * The instant at wall time `w` in `timeZone`: the earlier of two occurrences
 * in a repeated hour, or the end of the gap when the time was skipped.
 */
export function instantAt(w: Wall, timeZone: string): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  // The offsets a day either side bracket any transition near this time.
  const before = offsetAt(naive - DAY_MS, timeZone);
  const after = offsetAt(naive + DAY_MS, timeZone);
  const valid = [...new Set([before, after, offsetAt(naive, timeZone)])]
    .map((offset) => naive - offset)
    .filter((t) => sameWall(wallAt(t, timeZone), w));
  if (valid.length > 0) return Math.min(...valid);

  // A gap: find the transition, the first minute on the later offset.
  let lo = naive - Math.max(before, after);
  let hi = naive - Math.min(before, after);
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (offsetAt(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The next instant after `afterMs` at `timeOfDay` (`HH:MM`) in `timeZone`.
 * Throws on a malformed time of day, which the callers check first.
 */
export function nextDueAt(timeZone: string, timeOfDay: string, afterMs: number): number {
  if (!TIME_OF_DAY_PATTERN.test(timeOfDay)) throw new Error(`Malformed time of day: ${timeOfDay}`);
  const zone = zoneOrUtc(timeZone);
  const [hour, minute] = timeOfDay.split(":").map(Number) as [number, number];
  const today = wallAt(afterMs, zone);
  // Today, tomorrow or the day after: a gap can push today's time to an
  // instant that is still not after `afterMs`, and tomorrow then answers.
  for (let i = 0; i < 3; i++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const t = instantAt(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour,
        minute,
      },
      zone,
    );
    if (t > afterMs) return t;
  }
  throw new Error(`No ${timeOfDay} in ${zone} within three days of ${afterMs}`);
}
