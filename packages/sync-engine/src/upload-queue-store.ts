/**
 * The uploader's own state: what is queued, what was sent, and how far
 * discovery has read.
 *
 * Only the uploader writes these tables, and the sync round never reads them.
 * That split is what lets the uploader run beside a round without the engine's
 * lock. The cloud's bytes watermark stays the only authority on what the cloud
 * holds: everything here is a work list the watermark corrects. See
 * `design-upload-queue-2026-10-23.md`, section "State".
 *
 * Synchronous, because `RawDatabase` is. Every node has a SQLite handle except
 * a test or a one-off engine, which gets {@link createMemoryUploadQueueStore}.
 */

import {
  compareHLC,
  deserializeHLC,
  serializeHLC,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import type { Watermarks } from "./types.js";

/**
 * `fast` is a derived child of at most 1 MiB: the stand-ins and posters another
 * node needs to paint a photo list. Everything else is `full`.
 */
export type UploadTier = "fast" | "full";

/**
 * `ready` waits only for its next attempt time. `blocked-not-held` is a file
 * whose bytes this node no longer had when the scheduler took it.
 */
export type UploadEntryState = "ready" | "blocked-not-held";

/** One file the uploader owes the cloud, as discovery found it. */
export interface QueuedFile {
  readonly key: string;
  /** The row's `updated_at`; its `nodeId` is the author. */
  readonly hlc: HLCTimestamp;
  /** The shared record naming the file, or null for an app file-table row. */
  readonly recordId: StarkeepId | null;
  /** What a log line names the row by. */
  readonly itemId: string;
  readonly sizeBytes: number;
  /** The record's content hash, or the key when it has none. */
  readonly fileHash: string;
  readonly mimeType: string | null;
  readonly tier: UploadTier;
}

export interface UploadQueueEntry extends QueuedFile {
  readonly attempts: number;
  /** Wall-clock ms before which the entry is not taken. */
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly state: UploadEntryState;
  /** Put back by reconciliation: taken before the rest of its tier. */
  readonly front: boolean;
}

export interface UploadSentEntry extends QueuedFile {
  /** Wall-clock ms of the 2xx PUT. */
  readonly sentAt: number;
}

/** A presign batch whose transfers had not all settled. */
export interface OpenUploadBatch {
  readonly id: string;
  readonly startedAt: number;
  readonly items: number;
}

export interface UploadTierTotals {
  readonly count: number;
  readonly bytes: number;
}

export interface UploadQueueTotals {
  readonly fast: UploadTierTotals;
  readonly full: UploadTierTotals;
  readonly blocked: UploadTierTotals;
  /** Entries waiting out a backoff after a failure. Counted in their tier too. */
  readonly backingOff: number;
}

export interface UploadQueueStore {
  /**
   * Add a file, or take a newer row version of one already queued. The queue
   * keys on the object key, so two rows naming one key share an entry, and an
   * older version never replaces a newer one. A replaced entry is ready again
   * and keeps its attempt count.
   */
  enqueue(file: QueuedFile): void;
  /** Add a file, or ready one already queued, at the front of its tier. */
  enqueueFront(file: QueuedFile): void;
  get(key: string): UploadQueueEntry | null;
  remove(key: string): void;
  /**
   * Ready entries of one tier, due by `now`, in the scheduler's order: entries
   * put back by reconciliation first, then `fast` newest HLC first and `full`
   * oldest HLC first.
   */
  nextReady(tier: UploadTier, now: number, limit: number): UploadQueueEntry[];
  /** The earliest attempt time among ready entries not yet due, or null. */
  nextDueAt(now: number): number | null;
  recordFailure(key: string, attempts: number, nextAttemptAt: number, lastError: string): void;
  setState(key: string, state: UploadEntryState): void;
  /** Blocked entries in key order after `afterKey`, for a recheck that pages. */
  blocked(afterKey: string | null, limit: number): UploadQueueEntry[];
  totals(now: number): UploadQueueTotals;

  /** Move a file the cloud accepted from the queue to the sent table. */
  markSent(key: string, sentAt: number): void;
  sent(key: string): UploadSentEntry | null;
  sentCount(): number;
  /** Put a sent file back at the front of its tier. */
  requeueSent(key: string): void;
  /** Forget sent files of `author` above `hlc` (every one, when null). */
  dropSentAbove(author: string, hlc: HLCTimestamp | null): void;
  /** Forget sent files of `author` the cloud's watermark has passed. */
  pruneSent(author: string, hlc: HLCTimestamp): void;

  /** How far discovery has read, per author. */
  cursors(): Watermarks;
  setCursor(author: string, hlc: HLCTimestamp | null): void;
  /** The cloud's watermark as the uploader last saw it, per author. */
  seenCloud(): Watermarks;
  setSeenCloud(watermarks: Watermarks): void;
  /**
   * Authors whose files discovery is reading again after the cloud's
   * watermark dropped, each with the point the re-read must reach. Until then
   * discovery follows its cursor alone, not the cloud's watermark, which can
   * climb back above a hole before the re-read gets there.
   */
  rescans(): Watermarks;
  setRescan(author: string, hlc: HLCTimestamp | null): void;

  openBatch(batch: OpenUploadBatch): void;
  closeBatch(id: string): void;
  openBatches(): OpenUploadBatch[];
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

/** The store for a test or a one-off engine. Forgets everything on exit. */
export function createMemoryUploadQueueStore(): UploadQueueStore {
  const queue = new Map<string, UploadQueueEntry>();
  const sentMap = new Map<string, UploadSentEntry>();
  const cursorMap = new Map<string, HLCTimestamp>();
  const rescanMap = new Map<string, HLCTimestamp>();
  let seen: Watermarks = {};
  const batches = new Map<string, OpenUploadBatch>();

  return {
    enqueue(file) {
      const current = queue.get(file.key);
      if (current && compareHLC(current.hlc, file.hlc) > 0) return;
      queue.set(file.key, {
        ...file,
        attempts: current?.attempts ?? 0,
        nextAttemptAt: current?.nextAttemptAt ?? 0,
        lastError: current?.lastError ?? null,
        state: "ready",
        front: current?.front ?? false,
      });
    },
    enqueueFront(file) {
      const current = queue.get(file.key);
      queue.set(file.key, {
        ...(current ?? file),
        attempts: current?.attempts ?? 0,
        nextAttemptAt: 0,
        lastError: current?.lastError ?? null,
        state: "ready",
        front: true,
      });
    },
    get: (key) => queue.get(key) ?? null,
    remove: (key) => void queue.delete(key),
    nextReady(tier, now, limit) {
      return [...queue.values()]
        .filter((e) => e.tier === tier && e.state === "ready" && e.nextAttemptAt <= now)
        .sort((a, b) => {
          if (a.front !== b.front) return a.front ? -1 : 1;
          return tier === "fast" ? compareHLC(b.hlc, a.hlc) : compareHLC(a.hlc, b.hlc);
        })
        .slice(0, limit);
    },
    nextDueAt(now) {
      let earliest: number | null = null;
      for (const e of queue.values()) {
        if (e.state !== "ready" || e.nextAttemptAt <= now) continue;
        if (earliest === null || e.nextAttemptAt < earliest) earliest = e.nextAttemptAt;
      }
      return earliest;
    },
    recordFailure(key, attempts, nextAttemptAt, lastError) {
      const e = queue.get(key);
      if (e) queue.set(key, { ...e, attempts, nextAttemptAt, lastError, front: false });
    },
    setState(key, state) {
      const e = queue.get(key);
      if (e) queue.set(key, { ...e, state });
    },
    blocked(afterKey, limit) {
      return [...queue.values()]
        .filter((e) => e.state === "blocked-not-held" && (afterKey === null || e.key > afterKey))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, limit);
    },
    totals(now) {
      const sum = (pick: (e: UploadQueueEntry) => boolean): UploadTierTotals => {
        let count = 0;
        let bytes = 0;
        for (const e of queue.values()) {
          if (!pick(e)) continue;
          count += 1;
          bytes += e.sizeBytes;
        }
        return { count, bytes };
      };
      return {
        fast: sum((e) => e.state === "ready" && e.tier === "fast"),
        full: sum((e) => e.state === "ready" && e.tier === "full"),
        blocked: sum((e) => e.state === "blocked-not-held"),
        backingOff: sum((e) => e.state === "ready" && e.nextAttemptAt > now).count,
      };
    },
    markSent(key, sentAt) {
      const e = queue.get(key);
      if (!e) return;
      queue.delete(key);
      sentMap.set(key, { ...fileOf(e), sentAt });
    },
    sent: (key) => sentMap.get(key) ?? null,
    sentCount: () => sentMap.size,
    requeueSent(key) {
      const s = sentMap.get(key);
      if (!s) return;
      sentMap.delete(key);
      queue.set(key, {
        ...fileOf(s),
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        state: "ready",
        front: true,
      });
    },
    dropSentAbove(author, hlc) {
      for (const [key, s] of sentMap) {
        if (s.hlc.nodeId !== author) continue;
        if (hlc === null || compareHLC(s.hlc, hlc) > 0) sentMap.delete(key);
      }
    },
    pruneSent(author, hlc) {
      for (const [key, s] of sentMap) {
        if (s.hlc.nodeId === author && compareHLC(s.hlc, hlc) <= 0) sentMap.delete(key);
      }
    },
    cursors: () => Object.fromEntries(cursorMap),
    setCursor(author, hlc) {
      if (hlc === null) cursorMap.delete(author);
      else cursorMap.set(author, hlc);
    },
    seenCloud: () => ({ ...seen }),
    setSeenCloud(watermarks) {
      seen = { ...watermarks };
    },
    rescans: () => Object.fromEntries(rescanMap),
    setRescan(author, hlc) {
      if (hlc === null) rescanMap.delete(author);
      else rescanMap.set(author, hlc);
    },
    openBatch: (batch) => void batches.set(batch.id, batch),
    closeBatch: (id) => void batches.delete(id),
    openBatches: () => [...batches.values()],
  };
}

function fileOf(e: QueuedFile): QueuedFile {
  return {
    key: e.key,
    hlc: e.hlc,
    recordId: e.recordId,
    itemId: e.itemId,
    sizeBytes: e.sizeBytes,
    fileHash: e.fileHash,
    mimeType: e.mimeType,
    tier: e.tier,
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

// Compile-only Kysely instance (DummyDriver never executes); statements run
// synchronously through the raw handle's prepare(), as `sync-state-sqlite.ts`
// does.
type DB = Record<string, Record<string, unknown>>;
const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const QUEUE = "upload_queue";
const SENT = "upload_sent";
const CURSOR = "upload_cursor";
const BATCH = "upload_batch";

/** `sql.raw("?")` leaves a positional placeholder, bound per call. */
const P = sql.raw("?");
/** The same placeholder, typed where Kysely wants a number. */
const N = sql<number>`?`;
/**
 * Literals inlined into the SQL. A plain value would compile to one more `?`,
 * which the hand-bound parameters below would never fill.
 */
const ZERO = sql.lit(0);
const ONE = sql.lit(1);
const READY = sql.lit("ready");
const BLOCKED = sql.lit("blocked-not-held");

export interface SqliteUploadQueueStoreOptions {
  readonly db: RawDatabase;
  /**
   * The sync channel these rows belong to. A desktop runs one engine per
   * channel against one database, so every row carries its channel.
   */
  readonly channel: string;
}

interface QueueRow {
  key: string;
  hlc: string;
  record_id: string | null;
  item_id: string;
  size_bytes: number;
  file_hash: string;
  mime_type: string | null;
  tier: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  state: string;
  front: number;
}

interface SentRow {
  key: string;
  hlc: string;
  record_id: string | null;
  item_id: string;
  size_bytes: number;
  file_hash: string;
  mime_type: string | null;
  tier: string;
  sent_at: number;
}

export function createSqliteUploadQueueStore(
  options: SqliteUploadQueueStoreOptions,
): UploadQueueStore {
  const { db, channel } = options;

  const fileColumns = (t: ReturnType<typeof qb.schema.createTable>) =>
    t
      .addColumn("channel", "text", (c) => c.notNull())
      .addColumn("key", "text", (c) => c.notNull())
      .addColumn("hlc", "text", (c) => c.notNull())
      .addColumn("author", "text", (c) => c.notNull())
      .addColumn("record_id", "text")
      .addColumn("item_id", "text", (c) => c.notNull())
      .addColumn("size_bytes", "integer", (c) => c.notNull())
      .addColumn("file_hash", "text", (c) => c.notNull())
      .addColumn("mime_type", "text")
      .addColumn("tier", "text", (c) => c.notNull());
  db.exec(
    fileColumns(qb.schema.createTable(QUEUE).ifNotExists())
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("next_attempt_at", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("last_error", "text")
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("front", "integer", (c) => c.notNull().defaultTo(0))
      .addPrimaryKeyConstraint(`${QUEUE}_pk`, ["channel", "key"])
      .compile().sql,
  );
  db.exec(
    qb.schema
      .createIndex(`${QUEUE}_ready`)
      .ifNotExists()
      .on(QUEUE)
      .columns(["channel", "tier", "state", "hlc"])
      .compile().sql,
  );
  db.exec(
    fileColumns(qb.schema.createTable(SENT).ifNotExists())
      .addColumn("sent_at", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint(`${SENT}_pk`, ["channel", "key"])
      .compile().sql,
  );
  db.exec(
    qb.schema
      .createIndex(`${SENT}_author`)
      .ifNotExists()
      .on(SENT)
      .columns(["channel", "author", "hlc"])
      .compile().sql,
  );
  db.exec(
    qb.schema
      .createTable(CURSOR)
      .ifNotExists()
      .addColumn("channel", "text", (c) => c.notNull())
      .addColumn("author", "text", (c) => c.notNull())
      .addColumn("cursor_hlc", "text")
      .addColumn("seen_cloud_hlc", "text")
      .addColumn("rescan_to_hlc", "text")
      .addPrimaryKeyConstraint(`${CURSOR}_pk`, ["channel", "author"])
      .compile().sql,
  );
  db.exec(
    qb.schema
      .createTable(BATCH)
      .ifNotExists()
      .addColumn("channel", "text", (c) => c.notNull())
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("started_at", "integer", (c) => c.notNull())
      .addColumn("items", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint(`${BATCH}_pk`, ["channel", "id"])
      .compile().sql,
  );

  const fileValues = {
    channel: P,
    key: P,
    hlc: P,
    author: P,
    record_id: P,
    item_id: P,
    size_bytes: P,
    file_hash: P,
    mime_type: P,
    tier: P,
  };
  const fileParams = (f: QueuedFile): unknown[] => [
    channel,
    f.key,
    serializeHLC(f.hlc),
    f.hlc.nodeId,
    f.recordId,
    f.itemId,
    f.sizeBytes,
    f.fileHash,
    f.mimeType,
    f.tier,
  ];

  // A newer row version replaces the file's facts and makes the entry ready
  // again; attempts and backoff carry over. An older version changes nothing.
  const enqueueStmt = db.prepare(
    qb
      .insertInto(QUEUE)
      .values({ ...fileValues, attempts: ZERO, next_attempt_at: ZERO, state: READY, front: ZERO })
      .onConflict((oc) =>
        oc
          .columns(["channel", "key"])
          .doUpdateSet((eb) => ({
            hlc: eb.ref("excluded.hlc"),
            author: eb.ref("excluded.author"),
            record_id: eb.ref("excluded.record_id"),
            item_id: eb.ref("excluded.item_id"),
            size_bytes: eb.ref("excluded.size_bytes"),
            file_hash: eb.ref("excluded.file_hash"),
            mime_type: eb.ref("excluded.mime_type"),
            tier: eb.ref("excluded.tier"),
            state: READY,
          }))
          .where(sql.ref(`${QUEUE}.hlc`), "<=", sql.ref("excluded.hlc")),
      )
      .compile().sql,
  );
  const getStmt = db.prepare(
    qb.selectFrom(QUEUE).selectAll().where("channel", "=", P).where("key", "=", P).compile().sql,
  );
  const removeStmt = db.prepare(
    qb.deleteFrom(QUEUE).where("channel", "=", P).where("key", "=", P).compile().sql,
  );
  const readyQuery = (order: "asc" | "desc") =>
    db.prepare(
      qb
        .selectFrom(QUEUE)
        .selectAll()
        .where("channel", "=", P)
        .where("tier", "=", P)
        .where("state", "=", READY)
        .where("next_attempt_at", "<=", P)
        .orderBy("front", "desc")
        .orderBy("hlc", order)
        .limit(N)
        .compile().sql,
    );
  const readyNewestStmt = readyQuery("desc");
  const readyOldestStmt = readyQuery("asc");
  const nextDueStmt = db.prepare(
    qb
      .selectFrom(QUEUE)
      .select((eb) => eb.fn.min("next_attempt_at").as("due"))
      .where("channel", "=", P)
      .where("state", "=", READY)
      .where("next_attempt_at", ">", P)
      .compile().sql,
  );
  const failureStmt = db.prepare(
    qb
      .updateTable(QUEUE)
      .set({ attempts: P, next_attempt_at: P, last_error: P, front: ZERO })
      .where("channel", "=", P)
      .where("key", "=", P)
      .compile().sql,
  );
  const stateStmt = db.prepare(
    qb.updateTable(QUEUE).set({ state: P }).where("channel", "=", P).where("key", "=", P).compile()
      .sql,
  );
  const blockedStmt = db.prepare(
    qb
      .selectFrom(QUEUE)
      .selectAll()
      .where("channel", "=", P)
      .where("state", "=", BLOCKED)
      .where("key", ">", P)
      .orderBy("key")
      .limit(N)
      .compile().sql,
  );
  const totalsStmt = db.prepare(
    qb
      .selectFrom(QUEUE)
      .select((eb) => [
        "tier",
        "state",
        eb.fn.countAll<number>().as("count"),
        eb.fn.sum<number>("size_bytes").as("bytes"),
        eb.fn
          .sum<number>(eb.case().when("next_attempt_at", ">", P).then(ONE).else(ZERO).end())
          .as("backing_off"),
      ])
      .where("channel", "=", P)
      .groupBy(["tier", "state"])
      .compile().sql,
  );
  const insertSentStmt = db.prepare(
    qb
      .insertInto(SENT)
      .values({ ...fileValues, sent_at: P })
      .onConflict((oc) =>
        oc.columns(["channel", "key"]).doUpdateSet((eb) => ({
          hlc: eb.ref("excluded.hlc"),
          author: eb.ref("excluded.author"),
          record_id: eb.ref("excluded.record_id"),
          item_id: eb.ref("excluded.item_id"),
          size_bytes: eb.ref("excluded.size_bytes"),
          file_hash: eb.ref("excluded.file_hash"),
          mime_type: eb.ref("excluded.mime_type"),
          tier: eb.ref("excluded.tier"),
          sent_at: eb.ref("excluded.sent_at"),
        })),
      )
      .compile().sql,
  );
  const getSentStmt = db.prepare(
    qb.selectFrom(SENT).selectAll().where("channel", "=", P).where("key", "=", P).compile().sql,
  );
  const sentCountStmt = db.prepare(
    qb
      .selectFrom(SENT)
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("channel", "=", P)
      .compile().sql,
  );
  const deleteSentStmt = db.prepare(
    qb.deleteFrom(SENT).where("channel", "=", P).where("key", "=", P).compile().sql,
  );
  const insertFrontStmt = db.prepare(
    qb
      .insertInto(QUEUE)
      .values({ ...fileValues, attempts: ZERO, next_attempt_at: ZERO, state: READY, front: ONE })
      .onConflict((oc) =>
        oc
          .columns(["channel", "key"])
          .doUpdateSet({ state: READY, front: ONE, next_attempt_at: ZERO }),
      )
      .compile().sql,
  );
  const dropSentAboveStmt = db.prepare(
    qb
      .deleteFrom(SENT)
      .where("channel", "=", P)
      .where("author", "=", P)
      .where("hlc", ">", P)
      .compile().sql,
  );
  const dropSentAllStmt = db.prepare(
    qb.deleteFrom(SENT).where("channel", "=", P).where("author", "=", P).compile().sql,
  );
  const pruneSentStmt = db.prepare(
    qb
      .deleteFrom(SENT)
      .where("channel", "=", P)
      .where("author", "=", P)
      .where("hlc", "<=", P)
      .compile().sql,
  );
  const cursorsStmt = db.prepare(
    qb
      .selectFrom(CURSOR)
      .select(["author", "cursor_hlc", "seen_cloud_hlc", "rescan_to_hlc"])
      .where("channel", "=", P)
      .compile().sql,
  );
  const upsertCursorStmt = db.prepare(
    qb
      .insertInto(CURSOR)
      .values({ channel: P, author: P, cursor_hlc: P })
      .onConflict((oc) =>
        oc
          .columns(["channel", "author"])
          .doUpdateSet((eb) => ({ cursor_hlc: eb.ref("excluded.cursor_hlc") })),
      )
      .compile().sql,
  );
  const upsertSeenStmt = db.prepare(
    qb
      .insertInto(CURSOR)
      .values({ channel: P, author: P, seen_cloud_hlc: P })
      .onConflict((oc) =>
        oc
          .columns(["channel", "author"])
          .doUpdateSet((eb) => ({ seen_cloud_hlc: eb.ref("excluded.seen_cloud_hlc") })),
      )
      .compile().sql,
  );
  const upsertRescanStmt = db.prepare(
    qb
      .insertInto(CURSOR)
      .values({ channel: P, author: P, rescan_to_hlc: P })
      .onConflict((oc) =>
        oc
          .columns(["channel", "author"])
          .doUpdateSet((eb) => ({ rescan_to_hlc: eb.ref("excluded.rescan_to_hlc") })),
      )
      .compile().sql,
  );
  const clearSeenStmt = db.prepare(
    qb
      .updateTable(CURSOR)
      .set({ seen_cloud_hlc: sql.lit(null) })
      .where("channel", "=", P)
      .compile().sql,
  );
  const openBatchStmt = db.prepare(
    qb
      .insertInto(BATCH)
      .values({ channel: P, id: P, started_at: P, items: P })
      .onConflict((oc) => oc.columns(["channel", "id"]).doNothing())
      .compile().sql,
  );
  const closeBatchStmt = db.prepare(
    qb.deleteFrom(BATCH).where("channel", "=", P).where("id", "=", P).compile().sql,
  );
  const openBatchesStmt = db.prepare(
    qb
      .selectFrom(BATCH)
      .select(["id", "started_at", "items"])
      .where("channel", "=", P)
      .orderBy("started_at")
      .compile().sql,
  );

  const toEntry = (row: QueueRow): UploadQueueEntry => ({
    key: row.key,
    hlc: deserializeHLC(row.hlc),
    recordId: row.record_id as StarkeepId | null,
    itemId: row.item_id,
    sizeBytes: Number(row.size_bytes),
    fileHash: row.file_hash,
    mimeType: row.mime_type,
    tier: row.tier as UploadTier,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error,
    state: row.state as UploadEntryState,
    front: Number(row.front) === 1,
  });
  const toSent = (row: SentRow): UploadSentEntry => ({
    key: row.key,
    hlc: deserializeHLC(row.hlc),
    recordId: row.record_id as StarkeepId | null,
    itemId: row.item_id,
    sizeBytes: Number(row.size_bytes),
    fileHash: row.file_hash,
    mimeType: row.mime_type,
    tier: row.tier as UploadTier,
    sentAt: Number(row.sent_at),
  });

  return {
    enqueue(file) {
      enqueueStmt.run(...fileParams(file));
    },
    enqueueFront(file) {
      insertFrontStmt.run(...fileParams(file));
    },
    get(key) {
      const row = getStmt.get(channel, key) as QueueRow | undefined;
      return row ? toEntry(row) : null;
    },
    remove(key) {
      removeStmt.run(channel, key);
    },
    nextReady(tier, now, limit) {
      const stmt = tier === "fast" ? readyNewestStmt : readyOldestStmt;
      return (stmt.all(channel, tier, now, limit) as QueueRow[]).map(toEntry);
    },
    nextDueAt(now) {
      const row = nextDueStmt.get(channel, now) as { due: number | null } | undefined;
      return row?.due === null || row?.due === undefined ? null : Number(row.due);
    },
    recordFailure(key, attempts, nextAttemptAt, lastError) {
      failureStmt.run(attempts, nextAttemptAt, lastError, channel, key);
    },
    setState(key, state) {
      stateStmt.run(state, channel, key);
    },
    blocked(afterKey, limit) {
      return (blockedStmt.all(channel, afterKey ?? "", limit) as QueueRow[]).map(toEntry);
    },
    totals(now) {
      const rows = totalsStmt.all(now, channel) as Array<{
        tier: string;
        state: string;
        count: number;
        bytes: number | null;
        backing_off: number | null;
      }>;
      const totals = {
        fast: { count: 0, bytes: 0 },
        full: { count: 0, bytes: 0 },
        blocked: { count: 0, bytes: 0 },
        backingOff: 0,
      };
      for (const row of rows) {
        const into =
          row.state === "blocked-not-held"
            ? totals.blocked
            : row.tier === "fast"
              ? totals.fast
              : totals.full;
        into.count += Number(row.count);
        into.bytes += Number(row.bytes ?? 0);
        if (row.state === "ready") totals.backingOff += Number(row.backing_off ?? 0);
      }
      return totals;
    },
    markSent(key, sentAt) {
      const row = getStmt.get(channel, key) as QueueRow | undefined;
      if (!row) return;
      insertSentStmt.run(...fileParams(toEntry(row)), sentAt);
      removeStmt.run(channel, key);
    },
    sent(key) {
      const row = getSentStmt.get(channel, key) as SentRow | undefined;
      return row ? toSent(row) : null;
    },
    sentCount() {
      const row = sentCountStmt.get(channel) as { count: number } | undefined;
      return Number(row?.count ?? 0);
    },
    requeueSent(key) {
      const row = getSentStmt.get(channel, key) as SentRow | undefined;
      if (!row) return;
      insertFrontStmt.run(...fileParams(toSent(row)));
      deleteSentStmt.run(channel, key);
    },
    dropSentAbove(author, hlc) {
      if (hlc === null) dropSentAllStmt.run(channel, author);
      else dropSentAboveStmt.run(channel, author, serializeHLC(hlc));
    },
    pruneSent(author, hlc) {
      pruneSentStmt.run(channel, author, serializeHLC(hlc));
    },
    cursors() {
      const out: Watermarks = {};
      for (const row of cursorsStmt.all(channel) as Array<{
        author: string;
        cursor_hlc: string | null;
      }>) {
        if (row.cursor_hlc) out[row.author] = deserializeHLC(row.cursor_hlc);
      }
      return out;
    },
    setCursor(author, hlc) {
      upsertCursorStmt.run(channel, author, hlc === null ? null : serializeHLC(hlc));
    },
    seenCloud() {
      const out: Watermarks = {};
      for (const row of cursorsStmt.all(channel) as Array<{
        author: string;
        seen_cloud_hlc: string | null;
      }>) {
        if (row.seen_cloud_hlc) out[row.author] = deserializeHLC(row.seen_cloud_hlc);
      }
      return out;
    },
    setSeenCloud(watermarks) {
      clearSeenStmt.run(channel);
      for (const [author, hlc] of Object.entries(watermarks)) {
        upsertSeenStmt.run(channel, author, serializeHLC(hlc));
      }
    },
    rescans() {
      const out: Watermarks = {};
      for (const row of cursorsStmt.all(channel) as Array<{
        author: string;
        rescan_to_hlc: string | null;
      }>) {
        if (row.rescan_to_hlc) out[row.author] = deserializeHLC(row.rescan_to_hlc);
      }
      return out;
    },
    setRescan(author, hlc) {
      upsertRescanStmt.run(channel, author, hlc === null ? null : serializeHLC(hlc));
    },
    openBatch(batch) {
      openBatchStmt.run(channel, batch.id, batch.startedAt, batch.items);
    },
    closeBatch(id) {
      closeBatchStmt.run(channel, id);
    },
    openBatches() {
      return (
        openBatchesStmt.all(channel) as Array<{ id: string; started_at: number; items: number }>
      ).map((row) => ({ id: row.id, startedAt: Number(row.started_at), items: Number(row.items) }));
    },
  };
}
