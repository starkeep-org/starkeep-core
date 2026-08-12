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
 *
 * ## What a blob *is* and what it is *charged to* are two columns
 *
 * `size_class` is the first and `budget_line` is the second, and they are not
 * the same thing: a namespace pools every rung it does not recognise onto one
 * line, so a dozen invented class names spend one budget between them. Grouping
 * the budget by class is what once made rung invention free and needed a
 * separate namespace-wide cap to bound it. Both columns are stored because both
 * are grouping keys — one for the operator's reporting, one for every decision.
 */

import type { ObjectStorageAdapter, RawDatabase } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import { compareEvictionRank, type EvictionRank } from "./residency-policy.js";

/** One held blob. */
export interface ResidentEntry {
  readonly recordId: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  /**
   * Opaque class name, supplied by the host. `<namespace>:<rung>`.
   *
   * What this blob *is*, for reporting — the census, the storage report, the
   * matrix row an operator reads. Not what it is charged to: several classes
   * can share one budget line, which is how a namespace bounds an app that
   * invents rung names.
   */
  readonly sizeClass: string;
  /**
   * Which budget these bytes are charged to — `BudgetLine.key`, resolved by the
   * host against the policy.
   *
   * A column rather than a derivation, for the same reason `namespace` was one:
   * it is the grouping key of every hot query here — the usage sum, the
   * eviction scan, the displacement check — and computing it per row would make
   * each of them a full table scan over one row per held blob.
   *
   * It is stored *resolved*, which means a policy edit that adds or removes a
   * row changes which line a class belongs to. The host re-resolves on arrival;
   * anything already held keeps the line it landed on until it is touched
   * again, and the reconciliation that fixes that is the same one that fixes
   * every other stale row here.
   */
  readonly budgetLineKey: string;
  /**
   * The namespace half of `sizeClass`, stored rather than derived.
   *
   * Kept for reporting only — "what is this app holding" is a question the
   * storage report and the matrix header ask. It stopped being a *budget* when
   * rows became shares of one namespace total: a namespace is now over budget
   * only if one of its lines is, so there is nothing left for a namespace-wide
   * pass to catch.
   */
  readonly namespace: string;
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
  /**
   * Whether this node holds these bytes **now**.
   *
   * False is a *departed* row: bytes this node held and let go, either because
   * the eviction pass dropped them or because the host said so. The row stays
   * behind rather than being deleted, and that record of the departure is what
   * makes two otherwise-invisible things answerable.
   *
   * The first is R6. Eliding advances the watermark by design — that is what
   * makes declining a blob a terminal state rather than a permanent retry — so
   * the peer will never offer those bytes again. A blob that was *fetched and
   * later evicted* is in exactly the same position, and nothing said so: once
   * the pass had freed the class back to its budget,
   * `decideResidency` answered `fetch` again and `residencyOf` therefore
   * reported `staged` — "row present, blob wanted, blob not yet here", i.e.
   * *still owed* — for bytes no sync round will ever send. `staged`'s durable
   * backstop is the watermark, and the watermark was the thing that was wrong.
   *
   * The second is drift. The pass deletes through the storage adapter and
   * updates the index after, so a crash between the two leaves a row claiming
   * bytes that are gone. The module note calls that "self-correcting on the next
   * pass" and nothing corrected it; {@link ResidentSetIndex.reconcile} is what
   * now does, and it needs somewhere to write the correction to.
   */
  readonly resident: boolean;
  /**
   * Bytes charged to a budget whose transfer has not finished.
   *
   * Set by {@link ResidentSetIndex.reserve} and cleared by `add`. Counts toward
   * usage and is never an eviction candidate. See `reserve` for why the
   * accounting has to move early in this one case, despite moving on arrival
   * everywhere else.
   */
  readonly reserved: boolean;
  /**
   * Whether this node has ever actually held these bytes.
   *
   * False is a **deferred** row: a blob this node wants and has never had,
   * written down by {@link ResidentSetIndex.defer} so the acquisition pass can
   * find it later. It exists because `resident = 0` had been carrying two
   * meanings the moment a queue was introduced, and one of them is
   * unrecoverable while the other is merely pending.
   *
   * That distinction is `wasEvicted`'s whole job, so this column is what keeps
   * it honest: without it every queued blob would report `evicted` — "held and
   * gone" — for bytes that were never here, which is the one state
   * `residencyOf` defines as beyond recovery.
   *
   * Defaults to true on write, which is what every existing row was: a row
   * only came to exist by being fetched.
   */
  readonly heldEver: boolean;
}

export interface EvictionCandidateQuery {
  /** `BudgetLine.key` — the one budget a pass enforces. */
  readonly budgetLineKey: string;
  /** Stop once this many bytes of candidates have been collected. */
  readonly targetBytes: number;
}

/** What {@link ResidentSetIndex.reconcile} found when it walked storage. */
export interface ReconcileReport {
  /** Rows the index believed, and storage confirmed. */
  readonly confirmed: number;
  /** Rows the index believed and storage does not have. Marked departed. */
  readonly corrected: number;
  /**
   * Keys storage holds that the index has never seen — locally imported
   * originals, derived renditions, anything a watcher wrote.
   *
   * Reported rather than adopted, because adopting one means answering "whose
   * budget do these bytes come out of", and that needs the record row. Only the
   * host can join it; this module must not learn what a size class is. A host
   * that can resolve them calls `add` for each.
   */
  readonly unknownKeys: readonly string[];
}

/**
 * What a caller supplies about a blob. The three lifecycle flags are set by the
 * index itself — `add` means resident and held, `reserve` means reserved, and
 * `defer` means wanted and never held — so a caller cannot state them
 * inconsistently with the call it is making.
 */
export type ResidentArrival = Omit<ResidentEntry, "resident" | "reserved" | "heldEver">;

/** One page of the acquisition queue for a budget line. */
export interface DeferredCandidateQuery {
  /** `BudgetLine.key` — the line whose queue this is. */
  readonly budgetLineKey: string;
  /** How many rows to return. The caller pages; see `deferredCandidates`. */
  readonly limit: number;
}

export interface ResidentSetIndex {
  /** Record an arrival. Idempotent on `objectStorageKey`. */
  add(entry: ResidentArrival): void;
  /**
   * Reserve room for bytes that are about to be fetched, before they land.
   *
   * The accounting deliberately moves on *arrival*, not on decision — crediting
   * a decision would let a node with a flaky link slowly convince itself it is
   * full of things it does not have. That is right within one engine, whose
   * inbound loop is strictly sequential so each decision sees the previous
   * arrival. It is not right *across* engines: the supervisor hands the same
   * index to the Drive engine and to every per-app engine, each with its own
   * timer, so two ticking at once both read `usageOf`, both see room, and both
   * land. The overshoot is roughly `(engines - 1) x largest blob`, which on a
   * laptop with three apps and a 400 MB video is a gigabyte past a budget
   * somebody set.
   *
   * A reservation is a provisional row that counts toward usage and is never an
   * eviction candidate. {@link release} drops it if the transfer fails; a
   * subsequent {@link add} for the same key replaces it with the real thing. It
   * is deliberately *not* durable across a restart — a process that died
   * mid-transfer did not land the bytes, and a reservation surviving that would
   * be a permanent phantom charge against the budget.
   */
  reserve(entry: ResidentArrival): void;
  /** Drop a reservation whose transfer did not happen. No-op for a landed row. */
  release(objectStorageKey: string): void;
  /**
   * Write down a blob this node wants and could not take — the acquisition
   * queue's only write path.
   *
   * A round that declines a blob for `budget-exhausted` calls this, and so does
   * the catalogue scan. The row it writes is not a claim about disk: it carries
   * `resident = 0, reserved = 0, held_ever = 0`, counts toward no usage sum, and
   * is never an eviction candidate. It is a *hint*, and a stale one is
   * harmless — the pass re-runs the real decision before it spends a byte.
   *
   * ## What it is structurally unable to do
   *
   * The upsert can only ever refresh a row that is *already* deferred
   * (`WHERE resident = 0 AND held_ever = 0`). Two things that must never happen
   * are therefore impossible rather than merely avoided:
   *
   *   - **Un-resident a held blob.** A deferred write landing on a resident row
   *     would take bytes that are on disk out of their budget's usage sum, and
   *     the next pass would work to a target it had already passed.
   *   - **Erase an eviction record.** A departed row is the only durable
   *     evidence that this node held these bytes and let them go; overwriting
   *     it with `held_ever = 0` would make `residencyOf` report a blob no round
   *     will resend as merely queued.
   *
   * Both are guarded in the SQL rather than in a caller, because the callers
   * are a sync round and a background scan and neither is in a position to know.
   */
  defer(entry: ResidentArrival): void;
  /**
   * The acquisition queue for a budget line, **best-first**.
   *
   * The exact reverse of {@link evictionCandidates}: most-recently-opened first,
   * then by the record's own date, with never-opened material last. That is not
   * a second opinion about what matters — it is {@link compareEvictionRank}
   * read backwards, because the best thing to acquire is by definition the last
   * thing this line would give up.
   *
   * Every non-resident row of the line is a candidate, deferred and departed
   * alike. An evicted blob is exactly a blob this node wanted, held, and let go
   * under contention, so a queue that skipped it would leave the population
   * §3.2 of the plan calls out — bytes evicted after their round completed —
   * with no route home at all.
   *
   * Paged for the reason `evictionCandidates` is: a cold library's queue is the
   * whole library, and reading 300k rows into a handset's heap is the problem
   * this file exists to avoid, one level up.
   */
  deferredCandidates(query: DeferredCandidateQuery): ResidentEntry[];
  /**
   * Forget a deferred row — a candidate the acquisition pass established can
   * never win.
   *
   * Guarded to rows that are actually deferred. Asked to drop a departed row it
   * does nothing, for the same reason `defer` cannot overwrite one: the row is
   * the eviction record, and a queue tidying itself must not be able to delete
   * the fact that these bytes were once here.
   */
  dropDeferred(objectStorageKey: string): void;
  /**
   * Forget a blob entirely — the row goes.
   *
   * Distinct from {@link markDeparted}, which keeps the row as a record that
   * this node once held these bytes and let them go. Use this only when the
   * *record* is gone, not when the bytes are.
   */
  remove(objectStorageKey: string): void;
  /**
   * Note that this node no longer holds these bytes, keeping the row.
   *
   * What eviction and `noteDeparture` call. See {@link ResidentEntry.resident}.
   */
  markDeparted(objectStorageKey: string): void;
  /**
   * Whether this node held these bytes and let them go.
   *
   * The fact `residencyOf` needs to distinguish "declined, and the peer will
   * re-offer it if policy changes" from "held, evicted, and gone for good".
   *
   * `resident = 0` alone stopped answering this once a queue existed: a
   * deferred row is also not resident, and it names bytes that were never here.
   * Hence `held_ever` — without it every queued blob would report `evicted`,
   * which is the one state `residencyOf` defines as unrecoverable, for a blob
   * the acquisition pass is about to fetch.
   */
  wasEvicted(objectStorageKey: string): boolean;
  /**
   * Reconcile the index against what storage actually holds.
   *
   * The index is a cache of a fact the filesystem also knows, and this is the
   * rebuild the module note has always promised. Two directions, and only one of
   * them can be fixed here — see {@link ReconcileReport.unknownKeys}.
   */
  reconcile(storage: ObjectStorageAdapter): Promise<ReconcileReport>;
  get(objectStorageKey: string): ResidentEntry | null;
  /** Bytes currently charged to one budget line. */
  usageOf(budgetLineKey: string): number;
  /** Bytes held per class, for the retention UI's projected-use column. */
  usageByClass(): Record<string, number>;
  /** Bytes held per namespace, for the per-app row of the same UI. */
  usageByNamespace(): Record<string, number>;
  /** Entry count per class. */
  countByClass(): Record<string, number>;
  setPinned(objectStorageKey: string, pinned: boolean): void;
  markOpened(objectStorageKey: string, atMs: number): void;
  /**
   * Eviction candidates for a budget line, worst-to-keep first, excluding
   * everything that is structurally not evictable (pinned, locally protected).
   * Ordering is {@link compareEvictionRank}: never-opened and oldest first.
   */
  evictionCandidates(query: EvictionCandidateQuery): ResidentEntry[];
  /**
   * Whether this line holds at least `bytesNeeded` of evictable blobs ranked
   * *worse* than `rank`.
   *
   * The admission half of the ordering. A sync round walks the change log
   * oldest-first, so a budget that simply stopped at full would fill a device
   * with its oldest material and decline everything since; admitting whatever
   * outranks enough of what is held is what makes the line converge on the best
   * of its class whatever order things arrived in.
   *
   * Answered from {@link evictionCandidates} rather than its own aggregate,
   * deliberately: that query already returns worst-first, so the walk stops at
   * the first entry the candidate does not beat, and the two halves of the
   * ordering cannot disagree because there is only one of them.
   */
  displaceableBytes(
    budgetLineKey: string,
    rank: EvictionRank,
    bytesNeeded: number,
  ): boolean;
  /**
   * Bytes on a line that no pass can free — pinned or locally protected.
   *
   * A separate aggregate rather than a filter over `entriesOf`, because the
   * question is asked by a preview that must not read a whole line into memory
   * to answer it, and because the answer is a *floor*: `usageOf` counts pinned
   * bytes and `evictionCandidates` excludes them, so anything comparing the two
   * without this number promises a target that pins make unreachable.
   */
  unevictableBytesOf(budgetLineKey: string): number;
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

/**
 * Rows the first eviction-candidate query asks for.
 *
 * Sized so an ordinary pass — freeing whatever a line has gone over its budget
 * by — is answered in one query for objects of any realistic size, while still
 * being a few hundred kilobytes of row rather than a whole class.
 */
const CANDIDATE_PAGE_ROWS = 512;

interface Row {
  record_id: string;
  object_storage_key: string;
  size_bytes: number;
  size_class: string;
  budget_line: string;
  namespace: string;
  pinned: number;
  protected_locally: number;
  requires_durability_proof: number;
  recency_at_ms: number | null;
  last_opened_at_ms: number | null;
  added_at_ms: number;
  resident: number;
  reserved: number;
  held_ever: number;
}

export function createSqliteResidentSetIndex(options: {
  readonly db: RawDatabase;
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
      .addColumn("budget_line", "text", (c) => c.notNull())
      .addColumn("namespace", "text", (c) => c.notNull())
      .addColumn("pinned", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("protected_locally", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("requires_durability_proof", "integer", (c) => c.notNull().defaultTo(1))
      .addColumn("recency_at_ms", "integer")
      .addColumn("last_opened_at_ms", "integer")
      .addColumn("added_at_ms", "integer", (c) => c.notNull())
      // Defaults to 1 so every row written before departures were recorded
      // reads as resident, which is what it was.
      .addColumn("resident", "integer", (c) => c.notNull().defaultTo(1))
      // A row that has been charged to a budget but whose bytes are still in
      // flight. Counts toward usage — that is the entire point — and is never
      // an eviction candidate, because a pass that deleted a key mid-transfer
      // would leave the arriving stream writing a file nothing knows about.
      .addColumn("reserved", "integer", (c) => c.notNull().defaultTo(0))
      // Defaults to 1 so every row written before the acquisition queue existed
      // reads as "held", which is what it was — a row only came to exist by
      // being fetched. See {@link ResidentEntry.heldEver}.
      //
      // Adding a column to an existing table is not what `createTable()
      // .ifNotExists()` does, and there is deliberately no migration here: this
      // is development, so the dev path is to drop the database (CLAUDE.md).
      .addColumn("held_ever", "integer", (c) => c.notNull().defaultTo(1))
      .compile().sql,
  );
  // Every hot query here is "everything on one budget line": the usage sum, the
  // eviction scan, the displacement check, the reduction preview. Without this
  // they are full scans of a table that has one row per held blob — 300k+ once
  // renditions exist.
  db.exec(
    qb.schema
      .createIndex(`${TABLE}_by_budget_line`)
      .ifNotExists()
      .on(TABLE)
      .columns(["budget_line"])
      .compile().sql,
  );
  // Reporting only — the census and the storage report group by class, and
  // neither is on a decision path. There is deliberately no namespace index:
  // the one query that groups by namespace is a whole-table roll-up for a UI
  // header, which an index would not help.
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
  // The acquisition queue, best-first. `_by_budget_line` cannot serve it: the
  // ordering is two more columns deep, so SQLite would filter on that index and
  // then build a temp b-tree over the result — which on a cold library is the
  // whole library, sorted, on every tick of a background pass. The equality
  // columns come first and the two ordering columns follow in the direction the
  // query asks for, so the index *is* the sort.
  db.exec(
    qb.schema
      .createIndex(`${TABLE}_deferred`)
      .ifNotExists()
      .on(TABLE)
      .column("budget_line")
      .column("resident")
      .column("last_opened_at_ms desc")
      .column("recency_at_ms desc")
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
        budget_line: sql.raw("?"),
        namespace: sql.raw("?"),
        pinned: sql.raw("?"),
        protected_locally: sql.raw("?"),
        requires_durability_proof: sql.raw("?"),
        recency_at_ms: sql.raw("?"),
        last_opened_at_ms: sql.raw("?"),
        added_at_ms: sql.raw("?"),
        resident: sql.raw("?"),
        reserved: sql.raw("?"),
        held_ever: sql.raw("?"),
      })
      .onConflict((oc) =>
        oc.column("object_storage_key").doUpdateSet((eb) => ({
          record_id: eb.ref("excluded.record_id"),
          size_bytes: eb.ref("excluded.size_bytes"),
          size_class: eb.ref("excluded.size_class"),
          // Overwritten because a policy edit can move a class between lines —
          // a rung gaining a row of its own leaves the pooled fallback — and an
          // arrival is the moment the host has re-resolved it.
          budget_line: eb.ref("excluded.budget_line"),
          namespace: eb.ref("excluded.namespace"),
          protected_locally: eb.ref("excluded.protected_locally"),
          requires_durability_proof: eb.ref("excluded.requires_durability_proof"),
          recency_at_ms: eb.ref("excluded.recency_at_ms"),
          // Overwritten, unlike the two below: bytes arriving is exactly the
          // event that makes a departed row resident again, and it is also what
          // turns a reservation into the real thing.
          resident: eb.ref("excluded.resident"),
          // Bytes landing is what turns a reservation into the real thing.
          reserved: eb.ref("excluded.reserved"),
          // Overwritten too, and only ever upward in practice: `add` and
          // `reserve` write 1, and `defer` never reaches this statement. A
          // deferred row whose bytes have arrived is a row that has now been
          // held, and the eviction record it becomes on the way out depends on
          // saying so.
          held_ever: eb.ref("excluded.held_ever"),
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
  // Every aggregate below counts **resident** rows only. A departed row is a
  // record that this node once held these bytes, not a claim that it still
  // does, and letting one into a usage sum would make an evicted class read as
  // still full — which is the one thing that would stop the next pass running.
  const usageStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(({ fn }) => [fn.sum<number>("size_bytes").as("total")])
      .where("budget_line", "=", sql.raw("?"))
      .where("resident", "=", sql.lit(1))
      .compile().sql,
  );
  const usageByNamespaceStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(({ fn }) => ["namespace", fn.sum<number>("size_bytes").as("total")])
      .where("resident", "=", sql.lit(1))
      .groupBy("namespace")
      .compile().sql,
  );
  const usageByClassStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(({ fn }) => ["size_class", fn.sum<number>("size_bytes").as("total"), fn.count<number>("object_storage_key").as("n")])
      .where("resident", "=", sql.lit(1))
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
    qb
      .selectFrom(TABLE)
      .selectAll()
      .where("size_class", "=", sql.raw("?"))
      .where("resident", "=", sql.lit(1))
      .compile().sql,
  );
  // Deliberately **not** filtered to resident rows. Pinning a record is a
  // statement about the record, and someone pinning something this node evicted
  // last week is asking for it to be kept when it comes back — the departed row
  // is where that intent has to land, because there is nowhere else.
  const entriesOfRecordStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("record_id", "=", sql.raw("?")).compile().sql,
  );
  const unevictableStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(({ fn }) => [fn.sum<number>("size_bytes").as("total")])
      .where("budget_line", "=", sql.raw("?"))
      .where("resident", "=", sql.lit(1))
      .where((eb) =>
        eb.or([eb("pinned", "=", sql.lit(1)), eb("protected_locally", "=", sql.lit(1))]),
      )
      .compile().sql,
  );
  const markDepartedStmt = db.prepare(
    qb
      .updateTable(TABLE)
      .set({ resident: sql.lit(0) })
      .where("object_storage_key", "=", sql.raw("?"))
      .compile().sql,
  );
  // Landed rows only. A reservation also carries `resident = 1` — that is the
  // whole point of it, since the budget has to be charged before the bytes
  // arrive — but storage not having those bytes yet is the *expected* state
  // rather than a disagreement. Including them made `reconcile` mark every
  // in-flight transfer departed: the charge vanished mid-fetch, restoring the
  // overshoot the reservation exists to prevent, and `wasEvicted` then answered
  // true for a key this node never held, so `residencyOf` reported `evicted` —
  // the one state it defines as unrecoverable — for a blob that was about to
  // land.
  const residentKeysStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(["object_storage_key"])
      .where("resident", "=", sql.lit(1))
      .where("reserved", "=", sql.lit(0))
      .compile().sql,
  );
  // Worst-to-keep first. `last_opened_at_ms IS NULL` sorts first so
  // never-opened material goes before anything anyone has actually looked at,
  // then oldest-opened, then oldest by the record's own date. Structurally
  // non-evictable rows are excluded here rather than filtered by the caller,
  // so a caller cannot forget to.
  //
  // **This `ORDER BY` and `compareEvictionRank` are one ordering written twice**
  // — once for SQLite and once for the admission check, which has to ask the
  // same question about a blob that has no row yet. They must not drift; the
  // comparison function's doc comment is the specification and this mirrors it,
  // including SQLite putting NULL first in an ascending sort.
  //
  // One statement now, not two: the second existed because a pass could be
  // scoped to a whole namespace, and namespaces stopped being budgets when rows
  // became shares of one.
  //
  // ## The `LIMIT ?` is not an optimization
  //
  // This file exists because probing storage per record is "300k+ storage calls
  // once renditions exist". Reading 300k rows into memory and then trimming them
  // in JS — which is what `.all()` with no limit did — is a smaller version of
  // exactly that problem, on a device with a few hundred megabytes of heap.
  // Bytes are not rows, so the limit cannot be computed from `targetBytes`
  // directly; the caller pages, growing the request until it has collected
  // enough bytes or run out of rows. See `evictionCandidates`.
  const candidatesStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .selectAll()
      .where("budget_line", "=", sql.raw("?"))
      // sql.lit, not a bare 0: Kysely parameterizes plain values, which would
      // put unbound `?` placeholders into a statement prepared once and bound
      // with a single argument. These are constants, so they belong in the SQL.
      .where("pinned", "=", sql.lit(0))
      .where("protected_locally", "=", sql.lit(0))
      // A departed row names bytes this node already let go. Offering one as
      // an eviction candidate would have the pass delete a key that is not
      // there and count the freed bytes twice.
      .where("resident", "=", sql.lit(1))
      // Bytes still in flight. Deleting the key underneath an arriving
      // stream leaves a file nothing has a row for.
      .where("reserved", "=", sql.lit(0))
      .orderBy(sql`last_opened_at_ms IS NULL`, "desc")
      .orderBy("last_opened_at_ms", "asc")
      .orderBy("recency_at_ms", "asc")
      .limit(sql.raw("?") as never)
      .compile().sql,
  );

  /**
   * The queue write. See {@link ResidentSetIndex.defer} for what the guard is
   * for; what follows is why it is written as a conflict clause rather than a
   * read-then-write.
   *
   * A caller that checked `get()` first and then wrote would be two statements
   * where the interesting case is a race — a scan and a round both reaching the
   * same key, or a round landing bytes between the check and the write. One
   * guarded upsert cannot lose that race, and it also means the two callers
   * (`pullBlob`'s elide branch and the catalogue scan) have no invariant to
   * remember between them.
   */
  const deferStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({
        object_storage_key: sql.raw("?"),
        record_id: sql.raw("?"),
        size_bytes: sql.raw("?"),
        size_class: sql.raw("?"),
        budget_line: sql.raw("?"),
        namespace: sql.raw("?"),
        pinned: sql.raw("?"),
        protected_locally: sql.raw("?"),
        requires_durability_proof: sql.raw("?"),
        recency_at_ms: sql.raw("?"),
        last_opened_at_ms: sql.raw("?"),
        added_at_ms: sql.raw("?"),
        resident: sql.lit(0),
        reserved: sql.lit(0),
        held_ever: sql.lit(0),
      })
      .onConflict((oc) =>
        oc
          .column("object_storage_key")
          .doUpdateSet((eb) => ({
            record_id: eb.ref("excluded.record_id"),
            size_bytes: eb.ref("excluded.size_bytes"),
            size_class: eb.ref("excluded.size_class"),
            // Re-resolved by the caller against the current policy, exactly as
            // an arrival is: a rung that has gained a row of its own queues on
            // the line it belongs to now.
            budget_line: eb.ref("excluded.budget_line"),
            namespace: eb.ref("excluded.namespace"),
            protected_locally: eb.ref("excluded.protected_locally"),
            requires_durability_proof: eb.ref("excluded.requires_durability_proof"),
            recency_at_ms: eb.ref("excluded.recency_at_ms"),
            // `pinned` and `last_opened_at_ms` are left alone for the same
            // reason `add` leaves them: they are node-local user state, and
            // re-queueing a blob is not a reason to forget that somebody pinned
            // it or opened it yesterday.
          }))
          // The whole guarantee. A row that is resident, reserved, or departed
          // is untouched by a deferred write — the queue can refresh its own
          // rows and nothing else.
          .where("resident", "=", sql.lit(0))
          .where("held_ever", "=", sql.lit(0)),
      )
      .compile().sql,
  );

  const dropDeferredStmt = db.prepare(
    qb
      .deleteFrom(TABLE)
      .where("object_storage_key", "=", sql.raw("?"))
      .where("resident", "=", sql.lit(0))
      .where("held_ever", "=", sql.lit(0))
      .compile().sql,
  );

  /**
   * The acquisition queue, best-first — `compareEvictionRank` read backwards.
   *
   * `ORDER BY last_opened_at_ms DESC, recency_at_ms DESC` is the exact reverse
   * of the eviction order above, including where the nulls go: SQLite sorts
   * NULL first ascending, so descending puts it last, which is where
   * never-opened and undated material belongs when the question is what to
   * acquire *first*. The eviction statement spells its null placement out with
   * an `IS NULL` term and this does not need to, because the reversal already
   * carries it — and adding one would be a second expression the composite
   * index could not serve.
   *
   * Every non-resident row of the line, not only the deferred ones. A departed
   * row names bytes this node wanted, held, and let go under contention; it is
   * a queue entry with better provenance than most, and skipping it would leave
   * every evicted blob with no route home but a user tapping it. `held_ever`
   * separates the two facts for `wasEvicted`; it does not separate them for the
   * question "what should this line take next", where they are the same thing.
   *
   * Reservations are excluded because they are already resident for accounting
   * purposes — acquiring one would be a second transfer of bytes in flight.
   */
  const deferredCandidatesStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .selectAll()
      .where("budget_line", "=", sql.raw("?"))
      .where("resident", "=", sql.lit(0))
      .where("reserved", "=", sql.lit(0))
      .orderBy("last_opened_at_ms", "desc")
      .orderBy("recency_at_ms", "desc")
      .limit(sql.raw("?") as never)
      .compile().sql,
  );

  function toEntry(row: Row): ResidentEntry {
    return {
      recordId: row.record_id,
      objectStorageKey: row.object_storage_key,
      sizeBytes: row.size_bytes,
      sizeClass: row.size_class,
      budgetLineKey: row.budget_line,
      namespace: row.namespace,
      pinned: row.pinned === 1,
      protectedLocally: row.protected_locally === 1,
      requiresDurabilityProof: row.requires_durability_proof === 1,
      recencyAtMs: row.recency_at_ms,
      lastOpenedAtMs: row.last_opened_at_ms,
      addedAtMs: row.added_at_ms,
      resident: row.resident === 1,
      reserved: row.reserved === 1,
      heldEver: row.held_ever === 1,
    };
  }

  function write(entry: ResidentEntry): void {
    addStmt.run(
      entry.objectStorageKey,
      entry.recordId,
      entry.sizeBytes,
      entry.sizeClass,
      entry.budgetLineKey,
      entry.namespace,
      entry.pinned ? 1 : 0,
      entry.protectedLocally ? 1 : 0,
      entry.requiresDurabilityProof ? 1 : 0,
      entry.recencyAtMs,
      entry.lastOpenedAtMs,
      entry.addedAtMs,
      entry.resident ? 1 : 0,
      entry.reserved ? 1 : 0,
      entry.heldEver ? 1 : 0,
    );
  }

  /**
   * Worst-to-keep first, until `targetBytes` is covered.
   *
   * Paged rather than read whole. The query is `ORDER BY` over a line, and
   * `.all()` on it was a full materialization of that line — the same
   * 300k-rows-into-memory problem this file exists to avoid, one level up.
   *
   * The page size has to be a guess because bytes are not rows: the caller
   * asks for bytes and the `LIMIT` counts rows, and the average object size
   * that would relate them is exactly what varies (a library of screenshots
   * and a library of ProRAW have wildly different answers). So it starts from
   * a fixed page, doubles on each pass, and stops when the target is covered or
   * the line runs out. In the ordinary case — a pass freeing a few percent of a
   * budget — that is one query.
   *
   * A free function rather than only a method, because `displaceableBytes`
   * calls it and a method reaching for a sibling through `this` breaks the
   * moment somebody destructures the index.
   */
  function evictionCandidates(query: EvictionCandidateQuery): ResidentEntry[] {
    const out: ResidentEntry[] = [];
    let collected = 0;
    let limit = CANDIDATE_PAGE_ROWS;
    for (;;) {
      const rows = candidatesStmt.all(query.budgetLineKey, limit) as unknown as Row[];
      out.length = 0;
      collected = 0;
      for (const row of rows) {
        if (collected >= query.targetBytes) break;
        const entry = toEntry(row);
        out.push(entry);
        collected += entry.sizeBytes;
      }
      // Enough bytes, or the line has no more rows to offer — either way this
      // is the whole answer.
      if (collected >= query.targetBytes || rows.length < limit) return out;
      limit *= 2;
    }
  }

  return {
    evictionCandidates,

    add(entry: ResidentArrival): void {
      write({ ...entry, resident: true, reserved: false, heldEver: true });
    },

    reserve(entry: ResidentArrival): void {
      // Already resident for accounting purposes — the whole point is that the
      // *next* decision, in another engine, sees these bytes charged before they
      // arrive. Re-reserving a key that has already landed is a no-op rather
      // than a demotion: `add` cleared the flag, and putting it back would make
      // a real row releasable.
      const existing = getStmt.get(entry.objectStorageKey) as Row | undefined;
      if (existing !== undefined && existing.resident === 1 && existing.reserved === 0) {
        return;
      }
      // `heldEver: true` on a reservation, not because the bytes are here, but
      // because they are charged to a budget as though they were — the same
      // reading `resident: true` takes two lines up. A reservation that failed
      // is deleted by `release`, so this value is only ever observed by a row
      // that went on to land.
      write({ ...entry, resident: true, reserved: true, heldEver: true });
    },

    release(objectStorageKey: string): void {
      // Only a reservation is dropped. A row that has since been `add`ed is real
      // — the bytes landed — and a failed sibling transfer must not delete it.
      const row = getStmt.get(objectStorageKey) as Row | undefined;
      if (row !== undefined && row.reserved === 1) removeStmt.run(objectStorageKey);
    },

    defer(entry: ResidentArrival): void {
      deferStmt.run(
        entry.objectStorageKey,
        entry.recordId,
        entry.sizeBytes,
        entry.sizeClass,
        entry.budgetLineKey,
        entry.namespace,
        entry.pinned ? 1 : 0,
        entry.protectedLocally ? 1 : 0,
        entry.requiresDurabilityProof ? 1 : 0,
        entry.recencyAtMs,
        entry.lastOpenedAtMs,
        entry.addedAtMs,
      );
    },

    deferredCandidates(query: DeferredCandidateQuery): ResidentEntry[] {
      return (
        deferredCandidatesStmt.all(query.budgetLineKey, query.limit) as unknown as Row[]
      ).map(toEntry);
    },

    dropDeferred(objectStorageKey: string): void {
      dropDeferredStmt.run(objectStorageKey);
    },

    remove(objectStorageKey: string): void {
      removeStmt.run(objectStorageKey);
    },

    markDeparted(objectStorageKey: string): void {
      markDepartedStmt.run(objectStorageKey);
    },

    wasEvicted(objectStorageKey: string): boolean {
      const row = getStmt.get(objectStorageKey) as Row | undefined;
      // `held_ever` is what keeps this from answering "held and gone" for a
      // deferred row, which is not resident either and names bytes that were
      // never here.
      return row !== undefined && row.resident === 0 && row.held_ever === 1;
    },

    async reconcile(storage): Promise<ReconcileReport> {
      // What the index believes, before storage is asked.
      const believed = new Set(
        (residentKeysStmt.all() as unknown as Array<{ object_storage_key: string }>).map(
          (r) => r.object_storage_key,
        ),
      );

      const held = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await storage.list("", cursor ? { cursor } : {});
        for (const key of page.keys) held.add(key);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      let confirmed = 0;
      let corrected = 0;
      for (const key of believed) {
        if (held.has(key)) {
          confirmed += 1;
          continue;
        }
        // The index claimed bytes storage does not have — the crash-between-two-
        // writes case the module note calls self-correcting, finally corrected.
        // Marked departed rather than deleted: this node did hold them.
        markDepartedStmt.run(key);
        corrected += 1;
      }

      // The other direction, which this module cannot fix on its own: bytes on
      // disk that arrived by some route other than a sync pull — an imported
      // original, a derived rendition, anything a watcher wrote. They are real
      // disk use and no budget knows about them, which is the whole of R2. What
      // they cannot be given here is a size class, because that needs the record
      // row and the platform is not allowed to learn what a size class is.
      const unknownKeys: string[] = [];
      for (const key of held) {
        if (believed.has(key)) continue;
        if ((getStmt.get(key) as Row | undefined) !== undefined) continue;
        unknownKeys.push(key);
      }

      return { confirmed, corrected, unknownKeys };
    },

    get(objectStorageKey: string): ResidentEntry | null {
      const row = getStmt.get(objectStorageKey) as Row | undefined;
      return row ? toEntry(row) : null;
    },

    usageOf(budgetLineKey: string): number {
      const row = usageStmt.get(budgetLineKey) as { total: number | null } | undefined;
      return row?.total ?? 0;
    },

    usageByNamespace(): Record<string, number> {
      const rows = usageByNamespaceStmt.all() as Array<{ namespace: string; total: number }>;
      return Object.fromEntries(rows.map((r) => [r.namespace, r.total]));
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

    displaceableBytes(budgetLineKey: string, rank: EvictionRank, bytesNeeded: number): boolean {
      if (bytesNeeded <= 0) return true;
      let freeable = 0;
      // `evictionCandidates` returns worst-first, so the first entry the
      // candidate does not beat ends the walk — everything after it is better
      // still. Asking for `bytesNeeded` bounds the page: the walk cannot read
      // more of the line than an eviction pass freeing the same bytes would.
      for (const entry of evictionCandidates({ budgetLineKey, targetBytes: bytesNeeded })) {
        if (
          compareEvictionRank(
            { lastOpenedAtMs: entry.lastOpenedAtMs, recencyAtMs: entry.recencyAtMs },
            rank,
          ) >= 0
        ) {
          return false;
        }
        freeable += entry.sizeBytes;
        if (freeable >= bytesNeeded) return true;
      }
      return false;
    },

    unevictableBytesOf(budgetLineKey: string): number {
      const row = unevictableStmt.get(budgetLineKey) as { total: number | null } | undefined;
      return row?.total ?? 0;
    },

    entriesOf(sizeClass: string): ResidentEntry[] {
      return (entriesOfStmt.all(sizeClass) as unknown as Row[]).map(toEntry);
    },

    entriesOfRecord(recordId: string): ResidentEntry[] {
      return (entriesOfRecordStmt.all(recordId) as unknown as Row[]).map(toEntry);
    },
  };
}
