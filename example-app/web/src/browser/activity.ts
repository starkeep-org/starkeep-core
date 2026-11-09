/**
 * The Activity log: every request the page makes, newest first.
 *
 * Some operations change nothing else a person can see, such as a label
 * retraction or a refused write. The log makes each one apparent anyway: the
 * method, the path, the status and how long it took.
 */

export interface ActivityEntry {
  readonly method: string;
  readonly path: string;
  readonly status: number | "error";
  readonly ms: number;
  readonly at: Date;
}

const LIMIT = 100;
const entries: ActivityEntry[] = [];
const listeners = new Set<() => void>();

export function recordActivity(entry: ActivityEntry): void {
  entries.unshift(entry);
  entries.length = Math.min(entries.length, LIMIT);
  for (const listener of listeners) listener();
}

export function activityEntries(): readonly ActivityEntry[] {
  return entries;
}

export function onActivity(listener: () => void): void {
  listeners.add(listener);
}
