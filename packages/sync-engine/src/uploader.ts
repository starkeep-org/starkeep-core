/**
 * The upload queue beside the sync round.
 *
 * Rows reach the cloud in the round. Files reach it here, continuously, in an
 * order chosen for the person rather than for the watermark: the small
 * stand-ins another node needs to paint a photo list first, newest first, and
 * then originals oldest first. Neither half waits for the other. See
 * `design-upload-queue-2026-10-23.md`.
 *
 * Four rules keep this safe without the engine's lock:
 *
 * 1. The cloud's bytes watermark is the only authority on what the cloud
 *    holds. The queue is a work list, and reconciliation corrects it against
 *    the watermark the round saves.
 * 2. The uploader writes only its own tables (`upload-queue-store.ts`) and
 *    the multipart session store. It reads records, labels, residency and the
 *    saved watermarks, and the round never reads what it writes.
 * 3. Every action is idempotent and safe on a stale read. The presign pins
 *    the checksum, so a re-upload sends the same bytes.
 * 4. A file leaves the queue only on proof (the cloud answers *present*, or a
 *    PUT answers 2xx) or on a durable decision (the record was deleted, or
 *    carries a no-cloud label). A failure, a skip or an interruption never
 *    removes a file.
 */

import { compareHLC, type StarkeepId } from "@starkeep/protocol-primitives";
import {
  MULTIPART_PART_BYTES,
  type DatabaseAdapter,
  type ObjectStorageAdapter,
  type PutStreamOptions,
} from "@starkeep/storage-adapter";
import { expectedHashFor } from "./file-sync-engine.js";
import {
  advanceBytesWatermark,
  cloudExcludedRecords,
  scanFileRows,
  type FileRow,
  type FileRowSources,
} from "./file-rows.js";
import type {
  QueuedFile,
  UploadQueueEntry,
  UploadQueueStore,
  UploadTier,
} from "./upload-queue-store.js";
import type { Watermarks } from "./types.js";

// ---------------------------------------------------------------------------
// Engine defaults. The phone and the desktop use the same values (decision 4).
// ---------------------------------------------------------------------------

/** Largest derived child that goes in the fast tier. */
export const FAST_TIER_MAX_BYTES = 1024 * 1024;

/** Items in one presign-batch request. The route accepts no more. */
export const UPLOAD_BATCH_SIZE = 32;

/** Files up to this size use the small lane. */
export const SMALL_LANE_MAX_BYTES = 1024 * 1024;

/** PUTs at once in the small lane. */
export const SMALL_LANE_SLOTS = 6;

/** PUTs at once in the large lane. */
export const LARGE_LANE_SLOTS = 2;

/** Files sent in parts at once. A part upload is already a long sequence. */
export const PARTS_LANE_SLOTS = 1;

/**
 * Bytes in flight across every lane. A file larger than this still goes, alone.
 * A file sent in parts counts as one part, since only one part moves at a time.
 */
export const MAX_BYTES_IN_FLIGHT = 32 * 1024 * 1024;

/** Retry delays after the first, second, third and later failures. */
export const UPLOAD_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000];

/** How long a network-wide failure pauses the uploader. */
export const NETWORK_PAUSE_MS = 30_000;

/** Rows one discovery call reads. Discovery repeats while rows remain. */
export const DISCOVERY_PAGE_ROWS = 1000;

/**
 * The backstop timer: discovery, the blocked recheck, and any entry whose
 * backoff ran out while nothing else woke the uploader.
 */
export const UPLOADER_BACKSTOP_MS = 60_000;

/** Blocked entries one backstop tick rechecks. */
const BLOCKED_RECHECK_PAGE = 64;

/** Rows the pin check reads above the cloud's watermark. */
const PIN_SCAN_ROWS = 64;

/** Failures one report names; the rest are counted. */
const REPORT_FAILURES = 5;

/** Longest error text one report carries per failure. */
const REPORT_ERROR_CHARS = 200;

/** How often `drain()` looks at its signal. */
const DRAIN_POLL_MS = 250;

/**
 * Whether a file goes in the fast tier: a derived child of at most 1 MiB. The
 * 320, 640, 1280 and 2560 stand-ins qualify, and so do video posters. An app
 * file-table row has no parent, so it is always `full`.
 */
export function uploadTierOf(parentId: string | null, sizeBytes: number): UploadTier {
  return parentId !== null && sizeBytes <= FAST_TIER_MAX_BYTES ? "fast" : "full";
}

// ---------------------------------------------------------------------------
// The far end
// ---------------------------------------------------------------------------

/** What the cloud signs for a single PUT. Echoed exactly by the uploader. */
export interface PresignedPut {
  readonly url: string;
  readonly checksumSha256?: string;
  readonly storageClass?: string;
  readonly tagging?: Record<string, string>;
}

/**
 * The cloud's answer for one file of a batch.
 *
 * `absent` answers a file the uploader asked about without asking for a URL,
 * because it goes up in parts and the parts path signs its own.
 */
export type UploadAnswer =
  | { readonly status: "present" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "absent" }
  | { readonly status: "signed"; readonly signed: PresignedPut };

export interface UploadItem {
  readonly file: QueuedFile;
  /** The SHA-256 the cloud pins, or null when the file has no known hash. */
  readonly expectedSha256Hex: string | null;
  /** True for a file that goes up in parts. */
  readonly parts: boolean;
}

/**
 * The uploader's activity since its previous request, carried on each batch
 * for the cloud to log. See "Logging" in the design.
 */
export interface UploadBatchReport {
  /** Milliseconds since this uploader's previous request, or null for its first. */
  readonly sinceMs: number | null;
  readonly succeeded: {
    readonly fast: { readonly count: number; readonly bytes: number };
    readonly full: { readonly count: number; readonly bytes: number };
  };
  readonly failures: ReadonlyArray<{
    readonly key: string;
    readonly sizeBytes: number;
    readonly error: string;
    readonly elapsedMs: number;
  }>;
  readonly failureCount: number;
  /** Entries found not held since the previous request. */
  readonly blockedNotHeld: number;
  readonly queue: { readonly fast: number; readonly full: number; readonly blocked: number };
  readonly state: "running" | "draining" | "paused";
  /** Milliseconds left before a drain's deadline, when one is known. */
  readonly deadlineInMs?: number;
  /**
   * Batches an earlier run of this uploader opened and never finished: the
   * process was frozen or killed with their transfers in flight.
   */
  readonly unfinishedBatches?: ReadonlyArray<{
    readonly id: string;
    readonly startedAt: string;
    readonly items: number;
  }>;
}

/** Where files go. The engine builds one from its two object storages. */
export interface UploadTarget {
  /** Whether this file goes up in parts, which signs its own URLs. */
  usesParts(file: QueuedFile, source: ObjectStorageAdapter): boolean;
  /** One answer per item, in order. Throws when the request as a whole fails. */
  prepare(items: readonly UploadItem[], report: UploadBatchReport): Promise<UploadAnswer[]>;
  /** Send one file the cloud answered `signed` or `absent` for. */
  send(
    item: UploadItem,
    answer: Extract<UploadAnswer, { status: "signed" | "absent" }>,
    source: ObjectStorageAdapter,
  ): Promise<void>;
}

/** The request one batch item becomes on the wire. */
export interface PresignUploadItem {
  readonly key: string;
  readonly contentType?: string;
  readonly contentHash?: string;
  readonly sizeBytes?: number;
  /** False asks only whether the cloud holds the file. */
  readonly sign?: false;
}

/** The answer one batch item gets on the wire. */
export type PresignUploadAnswer =
  | { readonly key: string; readonly status: "present" }
  | { readonly key: string; readonly status: "absent" }
  | { readonly key: string; readonly status: "refused"; readonly reason: string }
  | { readonly key: string; readonly status: "error"; readonly error: string }
  | ({ readonly key: string; readonly status: "signed" } & PresignedPut);

/**
 * A remote that answers presence and signs uploads in one request per batch:
 * `HttpObjectStorageAdapter` against the cloud data server.
 */
export interface BatchUploadRemote {
  presignUploads(
    items: readonly PresignUploadItem[],
    report?: UploadBatchReport,
  ): Promise<PresignUploadAnswer[]>;
  uploadPresigned(
    key: string,
    signed: PresignedPut,
    source: ObjectStorageAdapter,
    options: PutStreamOptions,
  ): Promise<void>;
  sendsInParts(key: string, sizeBytes: number, source: ObjectStorageAdapter): boolean;
  putFromFileUri?: (key: string, fileUri: string, options?: PutStreamOptions) => Promise<void>;
}

function isBatchUploadRemote(
  remote: ObjectStorageAdapter,
): remote is ObjectStorageAdapter & BatchUploadRemote {
  const r = remote as Partial<BatchUploadRemote>;
  return (
    typeof r.presignUploads === "function" &&
    typeof r.uploadPresigned === "function" &&
    typeof r.sendsInParts === "function"
  );
}

function putOptionsFor(item: UploadItem): PutStreamOptions {
  return {
    ...(item.file.mimeType ? { contentType: item.file.mimeType } : {}),
    ...(item.file.sizeBytes ? { sizeBytes: item.file.sizeBytes } : {}),
    ...(item.expectedSha256Hex ? { expectedSha256Hex: item.expectedSha256Hex } : {}),
  };
}

/**
 * The target for a pair of object storages.
 *
 * Against the cloud data server, one presign-batch request answers presence
 * and signs every PUT, which replaces a HEAD and a presign per file. Any other
 * remote — an in-process cloud, a test's memory store — answers presence
 * through `has()` and takes bytes through `putStream()`.
 */
export function createUploadTarget(remote: ObjectStorageAdapter): UploadTarget {
  if (isBatchUploadRemote(remote)) {
    return {
      usesParts: (file, source) => remote.sendsInParts(file.key, file.sizeBytes, source),
      async prepare(items, report) {
        const answers = await remote.presignUploads(
          items.map((item) => ({
            key: item.file.key,
            ...(item.file.mimeType ? { contentType: item.file.mimeType } : {}),
            ...(item.expectedSha256Hex ? { contentHash: item.expectedSha256Hex } : {}),
            sizeBytes: item.file.sizeBytes,
            ...(item.parts ? { sign: false as const } : {}),
          })),
          report,
        );
        return items.map((item, i): UploadAnswer => {
          const answer = answers[i];
          if (!answer || answer.key !== item.file.key) {
            return { status: "error", error: "the cloud's answers did not match the request" };
          }
          if (answer.status === "signed") {
            const { key: _key, status: _status, ...signed } = answer;
            return { status: "signed", signed };
          }
          if (answer.status === "refused") return { status: "refused", reason: answer.reason };
          if (answer.status === "error") return { status: "error", error: answer.error };
          return { status: answer.status };
        });
      },
      async send(item, answer, source) {
        const options = putOptionsFor(item);
        if (answer.status === "signed") {
          await remote.uploadPresigned(item.file.key, answer.signed, source, options);
          return;
        }
        // In parts: the multipart path signs its own part URLs and resumes
        // from the session store.
        const fileUri = source.localFileUriFor?.(item.file.key) ?? null;
        if (fileUri === null || !remote.putFromFileUri) {
          throw new Error(`${item.file.key} goes up in parts, and no file URI is available`);
        }
        await remote.putFromFileUri(item.file.key, fileUri, options);
      },
    };
  }

  return {
    usesParts: () => false,
    async prepare(items) {
      return Promise.all(
        items.map(async (item): Promise<UploadAnswer> => {
          try {
            return (await remote.has(item.file.key))
              ? { status: "present" }
              : { status: "signed", signed: { url: "" } };
          } catch (err) {
            return { status: "error", error: (err as Error).message };
          }
        }),
      );
    },
    async send(item, _answer, source) {
      const options = putOptionsFor(item);
      const body = await source.getStream(item.file.key);
      if (!body) throw new Error(`${item.file.key} could not be read from this node`);
      try {
        await remote.putStream(item.file.key, body, options);
      } catch (err) {
        await body.cancel().catch(() => {});
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The uploader
// ---------------------------------------------------------------------------

export interface UploaderTierStats {
  readonly count: number;
  readonly bytes: number;
}

export interface UploaderStats {
  readonly state: "stopped" | "running" | "draining" | "paused";
  /** Files waiting to upload, per tier, including those backing off. */
  readonly queued: { readonly fast: UploaderTierStats; readonly full: UploaderTierStats };
  /** Files whose bytes this node no longer holds. */
  readonly blocked: UploaderTierStats;
  /** Files waiting out a backoff after a failure. */
  readonly backingOff: number;
  readonly inFlight: UploaderTierStats;
  /** Files this uploader sent since it was created. */
  readonly sent: UploaderTierStats;
}

export interface Uploader {
  /** Run continuously until {@link stop}. */
  start(): void;
  /** Start no new transfers. In-flight PUTs finish. */
  stop(): void;
  /**
   * Run until nothing is ready to send, or the signal aborts. Works whether
   * or not {@link start} was called, and leaves that state as it was.
   */
  drain(options?: {
    readonly signal?: { readonly aborted: boolean };
    /** Wall-clock ms the signal will abort at, for the report. */
    readonly deadlineAt?: number;
  }): Promise<UploaderStats>;
  stats(): UploaderStats;
  /** Called whenever {@link stats} may have changed. Returns an unsubscribe. */
  onChange(listener: (stats: UploaderStats) => void): () => void;
  /**
   * Something changed that may add work: a local write, a connectivity change,
   * bytes coming back. Runs discovery, rechecks blocked files and lifts a
   * network pause.
   */
  nudge(): void;
}

/** The uploader's clock and timers, injectable so tests can drive time. */
export interface UploaderTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: UploaderTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface UploaderOptions {
  /** This channel's file-bearing rows on this node. */
  readonly sources: FileRowSources;
  /** For the record and label re-check; null on a per-app channel. */
  readonly records: DatabaseAdapter | null;
  readonly localObjectStorage: ObjectStorageAdapter;
  readonly target: UploadTarget;
  readonly store: UploadQueueStore;
  /**
   * The cloud's bytes watermark as the round last saved it, lowered to any
   * repair floor. Null until the round has saved one: the uploader idles until
   * then, as a requester stops pushing rows when the cloud reports none.
   */
  readonly loadCloudBytes: () => Promise<Watermarks | null>;
  readonly timers?: UploaderTimers;
}

/** What the engine calls that a host does not. */
export interface UploaderInternals {
  readonly uploader: Uploader;
  /**
   * Reconcile against the watermark the round just saved. `exchangeStartedAt`
   * is when the exchange that saved it began, or null when no exchange ran
   * (a repair floor armed by `verify()`).
   */
  afterExchange(exchangeStartedAt: number | null): void;
}

/** One presign batch, from its request until every transfer it signed settles. */
interface Batch {
  readonly id: string;
  outstanding: number;
  readonly sent: number;
  /** Failed transfers held back until the batch settles, to tell an outage. */
  readonly networkFailures: Array<{ entry: UploadQueueEntry; error: string; elapsedMs: number }>;
  otherOutcomes: number;
}

interface Buffered {
  readonly entry: UploadQueueEntry;
  readonly item: UploadItem;
  readonly answer: Extract<UploadAnswer, { status: "signed" | "absent" }>;
  readonly batch: Batch;
}

interface Running {
  readonly entry: UploadQueueEntry;
  readonly lane: Lane;
  readonly cost: number;
}

type Lane = "small" | "large" | "parts";

const LANE_SLOTS: Record<Lane, number> = {
  small: SMALL_LANE_SLOTS,
  large: LARGE_LANE_SLOTS,
  parts: PARTS_LANE_SLOTS,
};

/** A short name for a key in a log line: the first 12 characters of its last segment. */
export function shortKey(key: string): string {
  return (key.split("/").pop() ?? key).slice(0, 12);
}

/**
 * Whether an error says the network failed rather than the request. A request
 * the far end answered carries its status in the message; a network failure
 * carries none.
 */
function isNetworkError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  const message = e?.message ?? String(err);
  if (/failed: \d{3}\b/.test(message)) return false;
  if (e?.name === "TypeError" || e?.name === "AbortError") return true;
  return /network|timed? ?out|socket|connection|resolve host|ECONN|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE/i.test(
    message,
  );
}

function backoffFor(attempts: number): number {
  return UPLOAD_BACKOFF_MS[Math.min(attempts, UPLOAD_BACKOFF_MS.length) - 1]!;
}

let batchCounter = 0;

export function createUploader(options: UploaderOptions): UploaderInternals {
  const { sources, records, localObjectStorage, target, store, loadCloudBytes } = options;
  const timers = options.timers ?? realTimers;
  const now = () => timers.now();

  let started = false;
  let drains = 0;
  let drainDeadlineAt: number | null = null;
  let pausedUntil = 0;

  /** Keys in the buffer, in flight, or inside a presign request. */
  const claimed = new Set<string>();
  const buffer: Buffered[] = [];
  const running = new Map<string, Running>();
  let bytesInFlight = 0;
  let presigning = false;

  let discovering: Promise<void> | null = null;
  let discoverAgain = false;
  let reconciling: Promise<void> = Promise.resolve();
  let blockedRecheckAfter: string | null = null;

  let wakeHandle: unknown = null;
  let wakeAt: number | null = null;
  let backstopHandle: unknown = null;

  const sessionSent = { count: 0, bytes: 0 };
  const listeners = new Set<(stats: UploaderStats) => void>();

  // What the next report says, accumulated since the previous request.
  let lastRequestAt: number | null = null;
  let reportSucceeded = { fast: { count: 0, bytes: 0 }, full: { count: 0, bytes: 0 } };
  let reportFailures: Array<{ key: string; sizeBytes: number; error: string; elapsedMs: number }> =
    [];
  let reportFailureCount = 0;
  let reportBlocked = 0;
  // Batches an earlier process left open, reported once and then closed.
  let unfinished = store.openBatches();

  const active = (): boolean => started || drains > 0;

  function emitChange(): void {
    if (listeners.size === 0) return;
    const snapshot = stats();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.warn(`[upload] a stats listener threw: ${(err as Error).message}`);
      }
    }
  }

  function stats(): UploaderStats {
    const t = now();
    const totals = store.totals(t);
    let inFlightCount = 0;
    let inFlightBytes = 0;
    for (const r of running.values()) {
      inFlightCount += 1;
      inFlightBytes += r.entry.sizeBytes;
    }
    const state: UploaderStats["state"] = !active()
      ? "stopped"
      : t < pausedUntil
        ? "paused"
        : started
          ? "running"
          : "draining";
    return {
      state,
      queued: { fast: totals.fast, full: totals.full },
      blocked: totals.blocked,
      backingOff: totals.backingOff,
      inFlight: { count: inFlightCount, bytes: inFlightBytes },
      sent: { ...sessionSent },
    };
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /** Wake the scheduler at `at`, unless an earlier wake is already armed. */
  function wakeAtTime(at: number): void {
    if (wakeAt !== null && wakeAt <= at) return;
    if (wakeHandle !== null) timers.clearTimeout(wakeHandle);
    wakeAt = at;
    wakeHandle = timers.setTimeout(
      () => {
        wakeHandle = null;
        wakeAt = null;
        kick();
      },
      Math.max(0, at - now()),
    );
  }

  function armBackstop(): void {
    if (backstopHandle !== null || !active()) return;
    backstopHandle = timers.setTimeout(() => {
      backstopHandle = null;
      if (!active()) return;
      void recheckBlocked().finally(() => {
        requestDiscovery();
        kick();
        armBackstop();
      });
    }, UPLOADER_BACKSTOP_MS);
  }

  function clearTimers(): void {
    if (wakeHandle !== null) timers.clearTimeout(wakeHandle);
    if (backstopHandle !== null) timers.clearTimeout(backstopHandle);
    wakeHandle = null;
    wakeAt = null;
    backstopHandle = null;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async function localHas(key: string): Promise<boolean> {
    try {
      return await localObjectStorage.has(key);
    } catch (err) {
      console.warn(`[upload] could not check local storage for ${key}: ${(err as Error).message}`);
      return false;
    }
  }

  function requestDiscovery(): void {
    if (!active()) return;
    if (discovering) {
      discoverAgain = true;
      return;
    }
    discovering = (async () => {
      try {
        do {
          discoverAgain = false;
          while (active() && (await discoverPage())) {
            // Repeat while the page was full and moved the cursor.
          }
        } while (discoverAgain && active());
      } catch (err) {
        console.warn(`[upload] discovery failed: ${(err as Error).message}`);
      } finally {
        discovering = null;
        kick();
        notifyIdle();
      }
    })();
  }

  /**
   * Read one page of file rows above the discovery cursor and enqueue the
   * files this node holds and may send. True when another page may follow.
   */
  async function discoverPage(): Promise<boolean> {
    const cloud = await loadCloudBytes();
    if (cloud === null) return false;
    const cursors = store.cursors();
    const rescans = store.rescans();
    // Above the higher of the cursor and the cloud's watermark: rows the cloud
    // has walked past are not owed. An author being read again after the
    // watermark dropped follows its cursor alone. See rule 1 in `reconcile`.
    const from: Watermarks = { ...cloud };
    for (const author of Object.keys(rescans)) delete from[author];
    for (const [author, cursor] of Object.entries(cursors)) {
      const mark = from[author];
      if (mark === undefined || compareHLC(cursor, mark) > 0) from[author] = cursor;
    }
    const scan = await scanFileRows(sources, from, DISCOVERY_PAGE_ROWS);
    if (!scan.readable) return false;
    if (scan.rows.length === 0) {
      // Nothing left to read for anyone, so every re-read is done.
      for (const author of Object.keys(rescans)) store.setRescan(author, null);
      return false;
    }

    const rows = [...scan.rows].sort((a, b) => compareHLC(a.hlc, b.hlc));
    const processed = new Set<FileRow>();
    const held: FileRow[] = [];
    for (const row of rows) {
      // A stop between rows keeps the cursor short of what was not read, so
      // the next start picks up there.
      if (!active()) break;
      if (row.manifest && (await localHas(row.manifest.objectStorageKey))) held.push(row);
      processed.add(row);
    }

    let excluded: ReadonlySet<StarkeepId>;
    try {
      excluded =
        records === null
          ? new Set()
          : await cloudExcludedRecords(
              records,
              held.flatMap((row) => (row.recordId === null ? [] : [row.recordId])),
            );
    } catch (err) {
      // An unread label might be the one that forbids the upload. Enqueue
      // nothing and leave the cursor, so the page is read again.
      console.warn(`[upload] could not read no-cloud labels: ${(err as Error).message}`);
      return false;
    }

    let added = 0;
    for (const row of held) {
      if (row.recordId !== null && excluded.has(row.recordId)) continue;
      const manifest = row.manifest!;
      store.enqueue({
        key: manifest.objectStorageKey,
        hlc: row.hlc,
        recordId: row.recordId,
        itemId: row.itemId,
        sizeBytes: manifest.sizeBytes,
        fileHash: manifest.fileHash,
        mimeType: manifest.mimeType ?? null,
        tier: uploadTierOf(row.candidate?.parentId ?? null, manifest.sizeBytes),
      });
      added += 1;
    }

    const next = advanceBytesWatermark(
      from,
      rows.map((row) => ({ hlc: row.hlc, satisfied: processed.has(row) })),
      scan.ceilings,
    );
    let moved = false;
    for (const [author, hlc] of Object.entries(next)) {
      const before = from[author];
      if (before !== undefined && compareHLC(hlc, before) <= 0) continue;
      store.setCursor(author, hlc);
      moved = true;
    }
    for (const [author, target] of Object.entries(rescans)) {
      const reached = next[author];
      const unread = scan.ceilings.has(author) || rows.some((r) => !processed.has(r));
      if ((reached !== undefined && compareHLC(reached, target) >= 0) || !unread) {
        store.setRescan(author, null);
        moved = true;
      }
    }
    if (added > 0) {
      emitChange();
      kick();
    }
    return moved && scan.ceilings.size > 0;
  }

  let rechecking: Promise<void> | null = null;

  /** Move blocked entries whose bytes are back to ready, a page per call. */
  function recheckBlocked(): Promise<void> {
    rechecking ??= recheckBlockedPage()
      .catch((err: unknown) => {
        console.warn(`[upload] blocked recheck failed: ${(err as Error).message}`);
      })
      .finally(() => {
        rechecking = null;
        notifyIdle();
      });
    return rechecking;
  }

  async function recheckBlockedPage(): Promise<void> {
    const page = store.blocked(blockedRecheckAfter, BLOCKED_RECHECK_PAGE);
    blockedRecheckAfter = page.length === BLOCKED_RECHECK_PAGE ? page[page.length - 1]!.key : null;
    let moved = 0;
    for (const entry of page) {
      if (await localHas(entry.key)) {
        store.setState(entry.key, "ready");
        moved += 1;
      }
    }
    if (moved > 0) emitChange();
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Correct the queue against the cloud's watermark.
   *
   * Rule 1: where the watermark dropped, the cloud lost rows or a repair floor
   * applies. Sent files above it may be gone, so they are forgotten and
   * discovery reads again from the new value up to the old one, whatever the
   * watermark does meanwhile. A floor retires as soon as its rows re-ship, and
   * the watermark then climbs back above the hole. The presign batch skips
   * what the cloud still holds.
   *
   * Rule 2: the first file row above an author's watermark is where the
   * cloud's walk stopped. See {@link checkPins}.
   */
  async function reconcile(exchangeStartedAt: number | null): Promise<void> {
    const cloud = await loadCloudBytes();
    if (cloud === null) return;
    const seen = store.seenCloud();
    for (const author of new Set([...Object.keys(seen), ...Object.keys(cloud)])) {
      const before = seen[author];
      const after = cloud[author];
      if (before !== undefined && (after === undefined || compareHLC(after, before) < 0)) {
        store.dropSentAbove(author, after ?? null);
        // The re-read starts at the new value. A cursor below it stays: it has
        // not read that far yet.
        const cursor = store.cursors()[author];
        if (cursor === undefined || after === undefined || compareHLC(cursor, after) > 0) {
          store.setCursor(author, after ?? null);
        }
        // Read again up to where the cloud's walk had been. Past that point
        // the ordinary rule applies.
        const target = store.rescans()[author];
        if (target === undefined || compareHLC(before, target) > 0) store.setRescan(author, before);
        console.log(
          `[upload] the cloud's bytes watermark for ${author} dropped; reading its files again`,
        );
      }
      if (after !== undefined) store.pruneSent(author, after);
    }
    store.setSeenCloud(cloud);

    await checkPins(cloud, exchangeStartedAt);
    requestDiscovery();
    kick();
  }

  /**
   * The first file row above each author's watermark is where the cloud's walk
   * stopped, and the walk checks it first on every exchange. Two cases put it
   * at the front of its tier:
   *
   * - This uploader sent it before that exchange began, so the cloud lost it
   *   or never stored it.
   * - This node holds it and has not queued it. Discovery read the row while
   *   the bytes were missing, or a local check failed, and the cursor moved
   *   on. Without this, a file whose bytes turned up late would pin the
   *   cloud's watermark forever.
   *
   * One short scan per exchange, and one local check per author.
   */
  async function checkPins(cloud: Watermarks, exchangeStartedAt: number | null): Promise<void> {
    const scan = await scanFileRows(sources, cloud, PIN_SCAN_ROWS);
    if (!scan.readable) return;
    const pins = new Map<string, FileRow>();
    for (const row of [...scan.rows].sort((a, b) => compareHLC(a.hlc, b.hlc))) {
      const author = row.hlc.nodeId;
      if (!row.manifest || pins.has(author)) continue;
      if (scan.ceilings.has(author) && scan.ceilings.get(author) === null) continue;
      pins.set(author, row);
    }
    for (const pin of pins.values()) {
      const key = pin.manifest!.objectStorageKey;
      if (claimed.has(key)) continue;
      const sent = store.sent(key);
      if (sent) {
        if (exchangeStartedAt !== null && sent.sentAt < exchangeStartedAt) {
          console.warn(
            `[upload] the cloud's walk stopped at ${key}, which this node sent; sending it again`,
          );
          store.requeueSent(key);
        }
        continue;
      }
      if (store.get(key) || !(await localHas(key))) continue;
      if (pin.recordId !== null && records !== null) {
        try {
          if ((await cloudExcludedRecords(records, [pin.recordId])).has(pin.recordId)) continue;
        } catch {
          continue;
        }
      }
      console.warn(
        `[upload] the cloud's walk stopped at ${key}, which this node holds; sending it`,
      );
      store.enqueueFront({
        key,
        hlc: pin.hlc,
        recordId: pin.recordId,
        itemId: pin.itemId,
        sizeBytes: pin.manifest!.sizeBytes,
        fileHash: pin.manifest!.fileHash,
        mimeType: pin.manifest!.mimeType ?? null,
        tier: uploadTierOf(pin.candidate?.parentId ?? null, pin.manifest!.sizeBytes),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  function laneOf(item: UploadItem): Lane {
    if (item.parts) return "parts";
    return item.file.sizeBytes <= SMALL_LANE_MAX_BYTES ? "small" : "large";
  }

  function costOf(item: UploadItem): number {
    return item.parts ? MULTIPART_PART_BYTES : item.file.sizeBytes;
  }

  function laneUse(lane: Lane): number {
    let n = 0;
    for (const r of running.values()) if (r.lane === lane) n += 1;
    return n;
  }

  /** Ready `fast` entries not yet taken, which hold every `full` transfer back. */
  function fastWaiting(t: number): boolean {
    return store.nextReady("fast", t, claimed.size + 1).some((e) => !claimed.has(e.key));
  }

  function kick(): void {
    if (!active()) return;
    const t = now();
    if (t < pausedUntil) {
      wakeAtTime(pausedUntil);
      return;
    }
    startTransfers(t);
    if (!presigning && buffer.length < UPLOAD_BATCH_SIZE / 2) void presignNext();
    notifyIdle();
  }

  /** Drains waiting for the uploader to run out of work. */
  const idleWaiters = new Set<() => void>();

  function notifyIdle(): void {
    for (const check of [...idleWaiters]) check();
  }

  function startTransfers(t: number): void {
    // Fast first, in the order the batch came. A full transfer waits while a
    // fast entry is ready: strict tiers.
    buffer.sort((a, b) => (a.entry.tier === b.entry.tier ? 0 : a.entry.tier === "fast" ? -1 : 1));
    let holdFull: boolean | null = null;
    for (let i = 0; i < buffer.length; ) {
      const next = buffer[i]!;
      const lane = laneOf(next.item);
      const cost = costOf(next.item);
      const laneFull = laneUse(lane) >= LANE_SLOTS[lane];
      const bytesFull = running.size > 0 && bytesInFlight + cost > MAX_BYTES_IN_FLIGHT;
      if (!laneFull && !bytesFull && next.entry.tier === "full") {
        holdFull ??= fastWaiting(t);
      }
      if (laneFull || bytesFull || (next.entry.tier === "full" && holdFull === true)) {
        i += 1;
        continue;
      }
      buffer.splice(i, 1);
      void transfer(next, lane, cost);
    }
  }

  async function presignNext(): Promise<void> {
    presigning = true;
    let picked: UploadQueueEntry[] = [];
    // Whether to look again at once. An empty pick must not, or an idle
    // uploader would spin; a transfer settling, a timer or new work kicks it.
    let again = false;
    try {
      const cloud = await loadCloudBytes();
      if (cloud === null) return;
      const t = now();
      const want = UPLOAD_BATCH_SIZE;
      const pick = (tier: UploadTier) =>
        store
          .nextReady(tier, t, want + claimed.size)
          .filter((e) => !claimed.has(e.key))
          .slice(0, want);
      picked = pick("fast");
      if (picked.length === 0) picked = pick("full");
      if (picked.length === 0) {
        const due = store.nextDueAt(t);
        if (due !== null) wakeAtTime(due);
        return;
      }
      for (const e of picked) claimed.add(e.key);

      const items = await recheck(picked);
      again = true;
      if (items.length === 0) return;

      batchCounter += 1;
      const id = `${t.toString(36)}-${batchCounter.toString(36)}`;
      store.openBatch({ id, startedAt: t, items: items.length });
      const report = takeReport(t);
      let answers: UploadAnswer[];
      try {
        answers = await target.prepare(items, report);
      } catch (err) {
        store.closeBatch(id);
        const message = (err as Error).message;
        // The request as a whole failed, so no file is at fault: no attempt
        // counts, and the uploader waits out the outage.
        console.warn(`[upload] presign batch failed; pausing: ${message}`);
        pause();
        again = false;
        return;
      }

      const signed: Array<{
        entry: UploadQueueEntry;
        item: UploadItem;
        answer: Buffered["answer"];
      }> = [];
      let present = 0;
      for (const [i, item] of items.entries()) {
        const entry = picked.find((e) => e.key === item.file.key)!;
        const answer = answers[i]!;
        if (answer.status === "present") {
          store.remove(entry.key);
          claimed.delete(entry.key);
          present += 1;
        } else if (answer.status === "refused") {
          // A durable decision: the cloud will not take these bytes.
          console.warn(`[upload] the cloud refused ${entry.key}: ${answer.reason}`);
          store.remove(entry.key);
          claimed.delete(entry.key);
        } else if (answer.status === "error") {
          noteFailure(entry, answer.error, 0);
          claimed.delete(entry.key);
        } else {
          signed.push({ entry, item, answer });
        }
      }
      const batch: Batch = {
        id,
        outstanding: signed.length,
        sent: signed.length,
        networkFailures: [],
        otherOutcomes: 0,
      };
      for (const s of signed) buffer.push({ ...s, batch });
      if (signed.length === 0) store.closeBatch(id);
      if (present > 0 || signed.length < items.length) emitChange();
    } catch (err) {
      console.warn(`[upload] could not prepare a batch: ${(err as Error).message}`);
    } finally {
      // Entries that never reached the buffer are free again.
      for (const e of picked) {
        if (!buffer.some((b) => b.entry.key === e.key) && !running.has(e.key))
          claimed.delete(e.key);
      }
      presigning = false;
      if (again) kick();
      else notifyIdle();
    }
  }

  /**
   * Re-read each entry as the scheduler takes it. A record deleted since
   * discovery, or labelled no-cloud, leaves the queue; a file whose bytes are
   * gone waits as blocked.
   */
  async function recheck(entries: readonly UploadQueueEntry[]): Promise<UploadItem[]> {
    const live: UploadQueueEntry[] = [];
    for (const entry of entries) {
      if (entry.recordId !== null && records !== null) {
        const record = await records.get(entry.recordId);
        if (!record || record.deletedAt || record.objectStorageKey !== entry.key) {
          store.remove(entry.key);
          claimed.delete(entry.key);
          continue;
        }
      }
      if (!(await localHas(entry.key))) {
        store.setState(entry.key, "blocked-not-held");
        claimed.delete(entry.key);
        reportBlocked += 1;
        console.warn(`[upload] ${entry.key} is no longer on this node; waiting for its bytes`);
        continue;
      }
      live.push(entry);
    }
    let excluded: ReadonlySet<StarkeepId> = new Set();
    if (records !== null) {
      const ids = live.flatMap((e) => (e.recordId === null ? [] : [e.recordId]));
      try {
        excluded = await cloudExcludedRecords(records, ids);
      } catch (err) {
        // The side that cannot leak: send nothing this time.
        console.warn(`[upload] could not read no-cloud labels: ${(err as Error).message}`);
        for (const e of live) claimed.delete(e.key);
        return [];
      }
    }
    const items: UploadItem[] = [];
    for (const entry of live) {
      if (entry.recordId !== null && excluded.has(entry.recordId)) {
        console.log(`[upload] ${entry.key} is marked no-cloud; leaving it off the cloud`);
        store.remove(entry.key);
        claimed.delete(entry.key);
        continue;
      }
      items.push({
        file: entry,
        expectedSha256Hex: expectedHashFor({
          fileHash: entry.fileHash,
          objectStorageKey: entry.key,
          sizeBytes: entry.sizeBytes,
        }),
        parts: target.usesParts(entry, localObjectStorage),
      });
    }
    return items;
  }

  async function transfer(next: Buffered, lane: Lane, cost: number): Promise<void> {
    const { entry, item, answer, batch } = next;
    running.set(entry.key, { entry, lane, cost });
    bytesInFlight += cost;
    emitChange();
    const began = now();
    try {
      await target.send(item, answer, localObjectStorage);
      store.markSent(entry.key, now());
      sessionSent.count += 1;
      sessionSent.bytes += entry.sizeBytes;
      const tier = reportSucceeded[entry.tier];
      tier.count += 1;
      tier.bytes += entry.sizeBytes;
      batch.otherOutcomes += 1;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const elapsedMs = now() - began;
      if (isNetworkError(err)) {
        batch.networkFailures.push({ entry, error: message, elapsedMs });
      } else {
        console.warn(`[upload] ${entry.key} failed: ${message}`);
        noteFailure(entry, message, elapsedMs);
        batch.otherOutcomes += 1;
      }
    } finally {
      running.delete(entry.key);
      claimed.delete(entry.key);
      bytesInFlight -= cost;
      batch.outstanding -= 1;
      if (batch.outstanding === 0) settleBatch(batch);
      emitChange();
      kick();
    }
  }

  /**
   * Every transfer a batch signed has finished. When all of them failed on
   * the network, the network is what failed: the uploader pauses and no file's
   * attempt count moves, so an outage cannot push every file to the longest
   * backoff. Otherwise each network failure counts like any other.
   */
  function settleBatch(batch: Batch): void {
    store.closeBatch(batch.id);
    if (batch.networkFailures.length === 0) return;
    const outage = batch.otherOutcomes === 0 && batch.networkFailures.length === batch.sent;
    if (outage) {
      console.warn(
        `[upload] every transfer in batch ${batch.id} failed on the network; pausing: ` +
          batch.networkFailures[0]!.error,
      );
      for (const f of batch.networkFailures) recordReportFailure(f.entry, f.error, f.elapsedMs);
      pause();
      return;
    }
    for (const f of batch.networkFailures) {
      console.warn(`[upload] ${f.entry.key} failed: ${f.error}`);
      noteFailure(f.entry, f.error, f.elapsedMs);
    }
  }

  function noteFailure(entry: UploadQueueEntry, error: string, elapsedMs: number): void {
    const current = store.get(entry.key) ?? entry;
    const attempts = current.attempts + 1;
    store.recordFailure(entry.key, attempts, now() + backoffFor(attempts), error.slice(0, 500));
    recordReportFailure(entry, error, elapsedMs);
  }

  function recordReportFailure(entry: UploadQueueEntry, error: string, elapsedMs: number): void {
    reportFailureCount += 1;
    if (reportFailures.length < REPORT_FAILURES) {
      reportFailures.push({
        key: shortKey(entry.key),
        sizeBytes: entry.sizeBytes,
        error: error.slice(0, REPORT_ERROR_CHARS),
        elapsedMs,
      });
    }
  }

  function pause(): void {
    pausedUntil = now() + NETWORK_PAUSE_MS;
    wakeAtTime(pausedUntil);
    emitChange();
  }

  function takeReport(t: number): UploadBatchReport {
    const totals = store.totals(t);
    const report: UploadBatchReport = {
      sinceMs: lastRequestAt === null ? null : t - lastRequestAt,
      succeeded: reportSucceeded,
      failures: reportFailures,
      failureCount: reportFailureCount,
      blockedNotHeld: reportBlocked,
      queue: { fast: totals.fast.count, full: totals.full.count, blocked: totals.blocked.count },
      state: t < pausedUntil ? "paused" : started ? "running" : "draining",
      ...(drainDeadlineAt !== null && !started ? { deadlineInMs: drainDeadlineAt - t } : {}),
      ...(unfinished.length > 0
        ? {
            unfinishedBatches: unfinished.map((b) => ({
              id: b.id,
              startedAt: new Date(b.startedAt).toISOString(),
              items: b.items,
            })),
          }
        : {}),
    };
    for (const b of unfinished) store.closeBatch(b.id);
    unfinished = [];
    lastRequestAt = t;
    reportSucceeded = { fast: { count: 0, bytes: 0 }, full: { count: 0, bytes: 0 } };
    reportFailures = [];
    reportFailureCount = 0;
    reportBlocked = 0;
    return report;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function begin(): void {
    armBackstop();
    requestDiscovery();
    kick();
    void recheckBlocked().then(kick);
    emitChange();
  }

  function end(): void {
    if (active()) return;
    clearTimers();
    // Signed URLs not yet used are dropped. A stopped uploader starts nothing,
    // and the URLs would expire before the next start.
    for (const b of buffer.splice(0)) {
      claimed.delete(b.entry.key);
      b.batch.outstanding -= 1;
      b.batch.otherOutcomes += 1;
      if (b.batch.outstanding === 0) settleBatch(b.batch);
    }
    emitChange();
  }

  function idle(): boolean {
    if (presigning || discovering || rechecking || running.size > 0 || buffer.length > 0) {
      return false;
    }
    const t = now();
    if (t < pausedUntil) return false;
    return store.nextReady("fast", t, 1).length === 0 && store.nextReady("full", t, 1).length === 0;
  }

  const uploader: Uploader = {
    start() {
      if (started) return;
      started = true;
      begin();
    },
    stop() {
      if (!started) return;
      started = false;
      end();
    },
    async drain(drainOptions) {
      const signal = drainOptions?.signal;
      drains += 1;
      if (drainOptions?.deadlineAt !== undefined) drainDeadlineAt = drainOptions.deadlineAt;
      try {
        await reconciling;
        if (drains === 1 && !started) begin();
        else {
          requestDiscovery();
          kick();
        }
        // An uploader idles until the round has saved a watermark; there is
        // nothing to drain against before that.
        if ((await loadCloudBytes()) === null) return stats();
        await new Promise<void>((resolve) => {
          let poll: unknown = null;
          const check = (): void => {
            if (!signal?.aborted && !idle()) return;
            idleWaiters.delete(check);
            if (poll !== null) timers.clearTimeout(poll);
            resolve();
          };
          const watchSignal = (): void => {
            poll = timers.setTimeout(() => {
              poll = null;
              check();
              if (idleWaiters.has(check)) watchSignal();
            }, DRAIN_POLL_MS);
          };
          idleWaiters.add(check);
          if (signal) watchSignal();
          // After whatever this call just started has had its first turn.
          void Promise.resolve().then(check);
        });
        return stats();
      } finally {
        drains -= 1;
        if (drains === 0) drainDeadlineAt = null;
        end();
      }
    },
    stats,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    nudge() {
      if (pausedUntil > now()) {
        pausedUntil = 0;
        emitChange();
      }
      requestDiscovery();
      kick();
      void recheckBlocked().then(kick);
    },
  };

  return {
    uploader,
    afterExchange(exchangeStartedAt) {
      reconciling = reconciling
        .then(() => reconcile(exchangeStartedAt))
        .catch((err: unknown) => {
          console.warn(`[upload] reconciliation failed: ${(err as Error).message}`);
        });
    },
  };
}
