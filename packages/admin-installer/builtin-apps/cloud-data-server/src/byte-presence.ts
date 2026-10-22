/**
 * Whether a shared file has reached S3, asked before the cloud signs a URL
 * for it.
 *
 * A row travels ahead of its file, so the cloud can list a record whose bytes
 * are still on the phone that wrote it. A URL signed for such a record answers
 * 403 from CloudFront, and a browser shows a broken image. This answers from
 * two sources and stores nothing new:
 *
 * - **At or below Drive's bytes watermark** for the row's author, the file is
 *   in S3 by guarantee: the sync responder walked it there. No check.
 * - **Above it**, one `HeadObject`. A miss is "awaiting upload".
 *
 * The watermark is Drive's because the Drive channel carries every shared
 * file. Every app's role may read it; see "How data access actually flows at
 * runtime" in `data-roles-and-permissions.md`.
 *
 * Only the lazy reads ask: the per-tile renditions batch and the single-record
 * routes. The bulk library list signs nothing and checks nothing, since a
 * 500-record page would otherwise cost 500 checks per load.
 */

import { compareHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";

/** One file a read is about to sign, with the version of the row that names it. */
export interface PresenceRow {
  readonly key: string;
  /** The row's `updated_at`. Its `nodeId` names the author the watermark is kept by. */
  readonly updatedAt: HLCTimestamp;
}

export interface BytePresence {
  /** The keys among `rows` that are not in storage yet. */
  missing(rows: readonly PresenceRow[]): Promise<ReadonlySet<string>>;
}

/**
 * Keys known to be in storage, kept for the life of a warm Lambda.
 *
 * Positive only. Shared keys are content-addressed, so a key once present
 * stays present; a key that was missing may land at any moment, so a miss is
 * never remembered.
 */
export interface PresentKeyCache {
  has(key: string): boolean;
  add(key: string): void;
}

/** A bounded LRU over a `Map`, whose iteration order is insertion order. */
export function createPresentKeyCache(capacity = 50_000): PresentKeyCache {
  const keys = new Map<string, true>();
  return {
    has(key) {
      if (!keys.has(key)) return false;
      keys.delete(key);
      keys.set(key, true);
      return true;
    },
    add(key) {
      keys.delete(key);
      keys.set(key, true);
      if (keys.size > capacity) keys.delete(keys.keys().next().value!);
    },
  };
}

/** HEADs in flight at once, per request. */
export const PRESENCE_CONCURRENCY = 32;

/**
 * HEADs per request. Keys past it count as present, which is the behavior
 * before this check existed: a page that pathological costs a broken tile
 * rather than seconds of latency, and the client's retry recovers the tile.
 */
export const PRESENCE_MAX_CHECKS = 512;

export interface BytePresenceOptions {
  /** Drive's bytes watermark for the request's user, per author. */
  readonly loadWatermarks: () => Promise<Record<string, HLCTimestamp>>;
  /** Whether storage holds the key, under the caller's own role. */
  readonly has: (key: string) => Promise<boolean>;
  readonly cache: PresentKeyCache;
  readonly concurrency?: number;
  readonly maxChecks?: number;
}

/**
 * One request's presence checks. The watermark is read on first use and at
 * most once, so a request that never asks costs nothing.
 */
export function createBytePresence(options: BytePresenceOptions): BytePresence {
  const concurrency = options.concurrency ?? PRESENCE_CONCURRENCY;
  const maxChecks = options.maxChecks ?? PRESENCE_MAX_CHECKS;
  let watermarks: Promise<Record<string, HLCTimestamp> | null> | null = null;
  let checksLeft = maxChecks;
  // What this request already learned, so the original's availability and
  // its own size in the summary cost one HEAD between them.
  const known = new Map<string, boolean>();

  const loadOnce = () =>
    (watermarks ??= options.loadWatermarks().catch((err: unknown) => {
      // Every row then takes a HEAD: slower, never a wrong URL. Until Drive is
      // redeployed with the read grant, this is every request.
      console.warn(`[presence] could not read Drive's bytes watermark: ${(err as Error).message}`);
      return null;
    }));

  return {
    async missing(rows) {
      const out = new Set<string>();
      if (rows.length === 0) return out;
      const marks = await loadOnce();

      // A key is covered when any row naming it is at or below its author's
      // watermark: the walk saw that row's file, and the key is the file.
      const covered = new Set<string>();
      const uncovered = new Set<string>();
      for (const row of rows) {
        const mark = marks?.[row.updatedAt.nodeId];
        if (mark !== undefined && compareHLC(row.updatedAt, mark) <= 0) covered.add(row.key);
        else uncovered.add(row.key);
      }
      const toCheck: string[] = [];
      for (const key of uncovered) {
        if (covered.has(key) || options.cache.has(key)) continue;
        const answer = known.get(key);
        if (answer === false) out.add(key);
        else if (answer === undefined) toCheck.push(key);
      }

      const checked = toCheck.slice(0, Math.max(0, checksLeft));
      checksLeft -= checked.length;
      if (checked.length < toCheck.length) {
        console.warn(
          `[presence] ${toCheck.length - checked.length} key(s) past the ${maxChecks}-check cap ` +
            `are signed unchecked`,
        );
      }
      for (let start = 0; start < checked.length; start += concurrency) {
        const batch = checked.slice(start, start + concurrency);
        const held = await Promise.all(
          batch.map(async (key) => {
            try {
              return await options.has(key);
            } catch (err) {
              // A failed check signs the URL, as before this check existed.
              // Reporting "awaiting upload" would leave the tile waiting on an
              // upload that may have finished long ago.
              console.warn(`[presence] could not check ${key}: ${(err as Error).message}`);
              return null;
            }
          }),
        );
        for (const [i, key] of batch.entries()) {
          const answer = held[i];
          if (answer === null || answer === undefined) continue;
          known.set(key, answer);
          if (answer) options.cache.add(key);
          else out.add(key);
        }
      }
      return out;
    },
  };
}
