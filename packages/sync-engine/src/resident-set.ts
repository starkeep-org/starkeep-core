/**
 * The resident-set index: what blobs this node actually holds, how big they
 * are, and which budget row each one counts against.
 *
 * ## This deliberately amends a stated design decision
 *
 * The sync engine's design says there is no persisted per-record status, and
 * that residency is *derived* — `localStorage.has(key)` per record. That was
 * right when the only question was "did this one blob arrive". It stops being
 * right the moment budgets exist, because "how many bytes am I holding for
 * this class" is a question over the whole library, and answering it by
 * probing is 300k+ storage calls once renditions exist. So this table is a
 * knowing exception, not an oversight, and it is scoped to exactly that:
 * **sizes and grouping, never sync status.** Whether a record's metadata has
 * been applied is still the watermark's business, and nothing here is
 * consulted to decide what to ship.
 *
 * The index is a cache of a fact the filesystem also knows, so it can be
 * rebuilt by walking storage. It must never become the *authority* on whether
 * bytes exist — the eviction pass deletes through the storage adapter and
 * updates the index after, so a crash between the two leaves a stale row
 * rather than a phantom file.
 *
 * ## The platform still never learns what a size class is
 *
 * `sizeClass` is an opaque string supplied by the host. `image-medium` means
 * nothing here. The host is also what decides that originals split
 * photo-vs-video (the plan's `original` row is two rows, because one 4K clip
 * is worth hundreds of stills and under a pooled budget one silently starves
 * the other) — it simply hands down `original:image` and `original:video` as
 * two class names. Every other class gets that split for free from its name
 * prefix, which is why this file needs no concept of media kind.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";

/** One held blob. */
export interface ResidentEntry {
  readonly recordId: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  /** Opaque budget-row key, supplied by the host. */
  readonly sizeClass: string;
  /**
   * This node insists on holding these bytes. Pins **count against** their
   * class's budget — otherwise someone pins 200 GB into a small budget and the
   * eviction pass thrashes forever trying to reach a target it can't reach —
   * and pins **win**, so the pass treats the pinned set as fixed and reports
   * the overage rather than swallowing it.
   */
  readonly pinned: boolean;
  /**
   * True while this node is the only place these bytes are known to exist, or
   * while they are still needed as a derivation input here. Such an entry is
   * **never evictable**, whatever the budget says. Set by the host, because
   * only it knows about derivation.
   */
  readonly protectedLocally: boolean;
  /**
   * Whether dropping this blob needs proof of a durable replica elsewhere.
   * False for anything cheaply re-derivable (a rendition); true for anything
   * that is the only copy of some information (an original). Defaults to true
   * when unknown, because the cost of being wrong is asymmetric.
   */
  readonly requiresDurabilityProof: boolean;
  readonly recencyAtMs: number | null;
  readonly lastOpenedAtMs: number | null;
  readonly addedAtMs: number;
}

export interface EvictionCandidateQuery {
  readonly sizeClass: string;
  /** Stop once this many bytes of candidates have been collected. */
  readonly targetBytes: number;
}

export interface ResidentSetIndex {
  /** Record an arrival. Idempotent on `objectStorageKey`. */
  add(entry: ResidentEntry): void;
  /** Forget a blob this node no longer holds. */
  remove(objectStorageKey: string): void;
  get(objectStorageKey: string): ResidentEntry | null;
  /** Bytes currently held for one class. */
  usageOf(sizeClass: string): number;
  /** Bytes held per class, for the retention UI's projected-use column. */
  usageByClass(): Record<string, number>;
  /** Entry count per class. */
  countByClass(): Record<string, number>;
  setPinned(objectStorageKey: string, pinned: boolean): void;
  markOpened(objectStorageKey: string, atMs: number): void;
  /**
   * Eviction candidates for a class, worst-to-keep first, excluding everything
   * that is structurally not evictable (pinned, locally protected). Ordering is
   * least-recently-useful: never-opened and oldest first.
   */
  evictionCandidates(query: EvictionCandidateQuery): ResidentEntry[];
  /** Every entry of a class, for a budget-reduction impact preview. */
  entriesOf(sizeClass: string): ResidentEntry[];
  /**
   * Every held blob belonging to one record — an original and its renditions
   * are separate rows here. Pinning or opening a record touches all of them,
   * and doing that by scanning would make a UI action O(library).
   */
  entriesOfRecord(recordId: string): ResidentEntry[];
}

type DB = Record<string, Record<string, unknown>>;
const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const TABLE = "resident_blobs";

interface Row {
  record_id: string;
  object_storage_key: string;
  size_bytes: number;
  size_class: string;
  pinned: number;
  protected_locally: number;
  requires_durability_proof: number;
  recency_at_ms: number | null;
  last_opened_at_ms: number | null;
  added_at_ms: number;
}

export function createSqliteResidentSetIndex(options: {
  readonly db: DatabaseSync;
}): ResidentSetIndex {
  const { db } = options;

  db.exec(
    qb.schema
      .createTable(TABLE)
      .ifNotExists()
      .addColumn("object_storage_key", "text", (c) => c.primaryKey())
      .addColumn("record_id", "text", (c) => c.notNull())
      .addColumn("size_bytes", "integer", (c) => c.notNull())
      .addColumn("size_class", "text", (c) => c.notNull())
      .addColumn("pinned", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("protected_locally", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("requires_durability_proof", "integer", (c) => c.notNull().defaultTo(1))
      .addColumn("recency_at_ms", "integer")
      .addColumn("last_opened_at_ms", "integer")
      .addColumn("added_at_ms", "integer", (c) => c.notNull())
      .compile().sql,
  );
  // Every hot query here is "everything in one class": the usage sum, the
  // eviction scan, the reduction preview. Without this they are full scans of
  // a table that has one row per held blob — 300k+ once renditions exist.
  db.exec(
    qb.schema
      .createIndex(`${TABLE}_by_class`)
      .ifNotExists()
      .on(TABLE)
      .columns(["size_class"])
      .compile().sql,
  );
  // Pinning or opening a record updates every rendition of it, and that has to
  // be a keyed lookup: it happens on a UI interaction, once per tap.
  db.exec(
    qb.schema
      .createIndex(`${TABLE}_by_record`)
      .ifNotExists()
      .on(TABLE)
      .columns(["record_id"])
      .compile().sql,
  );

  const addStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({
        object_storage_key: sql.raw("?"),
        record_id: sql.raw("?"),
        size_bytes: sql.raw("?"),
        size_class: sql.raw("?"),
        pinned: sql.raw("?"),
        protected_locally: sql.raw("?"),
        requires_durability_proof: sql.raw("?"),
        recency_at_ms: sql.raw("?"),
        last_opened_at_ms: sql.raw("?"),
        added_at_ms: sql.raw("?"),
      })
      .onConflict((oc) =>
        oc.column("object_storage_key").doUpdateSet((eb) => ({
          record_id: eb.ref("excluded.record_id"),
          size_bytes: eb.ref("excluded.size_bytes"),
          size_class: eb.ref("excluded.size_class"),
          protected_locally: eb.ref("excluded.protected_locally"),
          requires_durability_proof: eb.ref("excluded.requires_durability_proof"),
          recency_at_ms: eb.ref("excluded.recency_at_ms"),
          // pinned and last_opened_at_ms are deliberately NOT overwritten: they
          // are node-local user state, and a re-arrival of the same bytes (a
          // re-sync, a re-derivation) is not a reason to forget that someone
          // pinned this or opened it yesterday.
        })),
      )
      .compile().sql,
  );

  const removeStmt = db.prepare(
    qb.deleteFrom(TABLE).where("object_storage_key", "=", sql.raw("?")).compile().sql,
  );
  const getStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("object_storage_key", "=", sql.raw("?")).compile().sql,
  );
  const usageStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(({ fn }) => [fn.sum<number>("size_bytes").as("total")])
      .where("size_class", "=", sql.raw("?"))
      .compile().sql,
  );
  const usageByClassStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(({ fn }) => ["size_class", fn.sum<number>("size_bytes").as("total"), fn.count<number>("object_storage_key").as("n")])
      .groupBy("size_class")
      .compile().sql,
  );
  const setPinnedStmt = db.prepare(
    qb
      .updateTable(TABLE)
      .set({ pinned: sql.raw("?") })
      .where("object_storage_key", "=", sql.raw("?"))
      .compile().sql,
  );
  const markOpenedStmt = db.prepare(
    qb
      .updateTable(TABLE)
      .set({ last_opened_at_ms: sql.raw("?") })
      .where("object_storage_key", "=", sql.raw("?"))
      .compile().sql,
  );
  const entriesOfStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("size_class", "=", sql.raw("?")).compile().sql,
  );
  const entriesOfRecordStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("record_id", "=", sql.raw("?")).compile().sql,
  );
  // Worst-to-keep first. `last_opened_at_ms IS NULL` sorts first so
  // never-opened material goes before anything anyone has actually looked at,
  // then oldest-opened, then oldest by the record's own date. Structurally
  // non-evictable rows are excluded here rather than filtered by the caller,
  // so a caller cannot forget to.
  const candidatesStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .selectAll()
      .where("size_class", "=", sql.raw("?"))
      // sql.lit, not a bare 0: Kysely parameterizes plain values, which would
      // put unbound `?` placeholders into a statement prepared once and bound
      // with a single argument. These are constants, so they belong in the SQL.
      .where("pinned", "=", sql.lit(0))
      .where("protected_locally", "=", sql.lit(0))
      .orderBy(sql`last_opened_at_ms IS NULL`, "desc")
      .orderBy("last_opened_at_ms", "asc")
      .orderBy("recency_at_ms", "asc")
      .compile().sql,
  );

  function toEntry(row: Row): ResidentEntry {
    return {
      recordId: row.record_id,
      objectStorageKey: row.object_storage_key,
      sizeBytes: row.size_bytes,
      sizeClass: row.size_class,
      pinned: row.pinned === 1,
      protectedLocally: row.protected_locally === 1,
      requiresDurabilityProof: row.requires_durability_proof === 1,
      recencyAtMs: row.recency_at_ms,
      lastOpenedAtMs: row.last_opened_at_ms,
      addedAtMs: row.added_at_ms,
    };
  }

  return {
    add(entry: ResidentEntry): void {
      addStmt.run(
        entry.objectStorageKey,
        entry.recordId,
        entry.sizeBytes,
        entry.sizeClass,
        entry.pinned ? 1 : 0,
        entry.protectedLocally ? 1 : 0,
        entry.requiresDurabilityProof ? 1 : 0,
        entry.recencyAtMs,
        entry.lastOpenedAtMs,
        entry.addedAtMs,
      );
    },

    remove(objectStorageKey: string): void {
      removeStmt.run(objectStorageKey);
    },

    get(objectStorageKey: string): ResidentEntry | null {
      const row = getStmt.get(objectStorageKey) as Row | undefined;
      return row ? toEntry(row) : null;
    },

    usageOf(sizeClass: string): number {
      const row = usageStmt.get(sizeClass) as { total: number | null } | undefined;
      return row?.total ?? 0;
    },

    usageByClass(): Record<string, number> {
      const rows = usageByClassStmt.all() as Array<{ size_class: string; total: number }>;
      return Object.fromEntries(rows.map((r) => [r.size_class, r.total]));
    },

    countByClass(): Record<string, number> {
      const rows = usageByClassStmt.all() as Array<{ size_class: string; n: number }>;
      return Object.fromEntries(rows.map((r) => [r.size_class, r.n]));
    },

    setPinned(objectStorageKey: string, pinned: boolean): void {
      setPinnedStmt.run(pinned ? 1 : 0, objectStorageKey);
    },

    markOpened(objectStorageKey: string, atMs: number): void {
      markOpenedStmt.run(atMs, objectStorageKey);
    },

    evictionCandidates(query: EvictionCandidateQuery): ResidentEntry[] {
      const rows = candidatesStmt.all(query.sizeClass) as unknown as Row[];
      const out: ResidentEntry[] = [];
      let collected = 0;
      for (const row of rows) {
        if (collected >= query.targetBytes) break;
        const entry = toEntry(row);
        out.push(entry);
        collected += entry.sizeBytes;
      }
      return out;
    },

    entriesOf(sizeClass: string): ResidentEntry[] {
      return (entriesOfStmt.all(sizeClass) as unknown as Row[]).map(toEntry);
    },

    entriesOfRecord(recordId: string): ResidentEntry[] {
      return (entriesOfRecordStmt.all(recordId) as unknown as Row[]).map(toEntry);
    },
  };
}
