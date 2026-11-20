/**
 * The digest job's pure parts: the stand-in provider's token rotation, and the
 * digest file's name and text.
 *
 * The server half, which reads and writes through the run's token, is
 * `web/src/server/jobs.ts`.
 */

/** The tag the digest job puts on each digest file. */
export const DIGEST_TAG = "digest";

/**
 * The next value of the provider token, and how many times it has rotated.
 *
 * A real provider issues a new refresh token on every use and expires the old
 * one, so a job must store the new value before the run ends. The example has
 * no provider, so this function plays one: it appends `#1` to a token the user
 * typed, and increments the number on each later run. The job reports only
 * the number, never the token.
 */
export function rotateProviderToken(value: string): { next: string; rotation: number } {
  const match = /^([\s\S]*)#(\d+)$/.exec(value);
  const base = match ? match[1]! : value;
  const rotation = match ? Number(match[2]) + 1 : 1;
  return { next: `${base}#${rotation}`, rotation };
}

/** The digest file's name: one per UTC day, such as `digest-2026-11-20.skexample`. */
export function digestFileName(at: Date): string {
  return `digest-${at.toISOString().slice(0, 10)}.skexample`;
}

export interface DigestCounts {
  files: number;
  notes: number;
  pinned: number;
}

/**
 * The digest file's text. The run id makes each run's text unique, so a second
 * run on one day creates a second file rather than matching the first one's
 * content hash.
 */
export function digestText(opts: {
  at: Date;
  runId: string;
  counts: DigestCounts;
  /** The provider token's rotation number, or null when no token is stored. */
  rotation: number | null;
}): string {
  const { at, runId, counts, rotation } = opts;
  return [
    `Example digest, ${at.toISOString()}`,
    `Run ${runId}`,
    "",
    `Example files: ${counts.files}`,
    `Notes: ${counts.notes}, ${counts.pinned} pinned`,
    rotation === null ? "Provider token: none stored" : `Provider token: rotation ${rotation}`,
    "",
  ].join("\n");
}
