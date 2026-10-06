/**
 * The resident-set index: which blobs this node holds, which it held and let
 * go, and which it wants and lacks.
 *
 * ## This deliberately amends a stated design decision
 *
 * The sync engine's design says there is no persisted per-record status, and
 * that residency is *derived* — `localStorage.has(key)` per record. Three
 * questions cannot be answered that way, and this table exists for exactly
 * those, never for sync status:
 *
 *   - **What did this node let go?** "Free up space" removes a file after its
 *     round completed, so no round will offer it again. `residencyOf` needs to
 *     say `evicted` rather than `staged` for it, and only a record of the
 *     departure can tell the two apart.
 *   - **What does this node want and lack?** A raised ceiling or a new pin
 *     makes a file wanted long after the round that declined it. The catalogue
 *     scan writes those files down here and the acquisition pass fetches them.
 *   - **How many bytes of each kind does this node hold?** The storage reports
 *     ask it over the whole library, which probing would answer one file at a
 *     time.
 *
 * The index is a cache of a fact the filesystem also knows, so it can be
 * rebuilt by walking storage. It must never become the *authority* on whether
 * bytes exist: "Free up space" deletes through the storage adapter and updates
 * the index after, so a crash between the two leaves a stale row rather than a
 * phantom file, and {@link ResidentSetIndex.reconcile} corrects the row.
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

/** One blob this node holds, held, or wants. */
export interface ResidentEntry {
  readonly recordId: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  /**
   * What kind of file this is, for reporting: `stand-in:<category>`,
   * `original:<category>` for an original a stand-in can replace, or `kept`
   * for a file no stand-in can replace.
   */
  readonly group: string;
  readonly addedAtMs: number;
  /** Whether this node holds these bytes **now**. */
  readonly resident: boolean;
  /**
   * Whether this node has ever held these bytes. A row that is not resident
   * and was held is a *departure*; one that was never held is only wanted.
   */
  readonly heldEver: boolean;
  /** Whether the acquisition pass should fetch these bytes. */
  readonly wanted: boolean;
  /**
   * Whether the departure was deliberate — the person let these bytes go.
   *
   * Two things make a row not resident and they do not mean the same thing. The
   * person running "Free up space", or deleting a watched file from its folder,
   * is a *decision*: the acquisition pass must not fetch the file back, and a
   * read is the only thing that brings it here again. {@link reconcile} finding
   * bytes the index believed and storage does not have is a *discovery*: nobody
   * chose it, and re-acquiring the file is the repair the reconcile exists to
   * start.
   *
   * Collapsing the two would cost one of the two behaviours. Honouring every
   * departure as a decision would make a node that lost bytes to a wiped object
   * store never fetch them again; honouring none would re-download the file the
   * person just deleted on any node that keeps originals.
   */
  readonly released: boolean;
}

/** What {@link ResidentSetIndex.reconcile} found when it walked storage. */
export interface ReconcileReport {
  /** Rows the index believed, and storage confirmed. */
  readonly confirmed: number;
  /** Rows the index believed and storage does not have. Marked departed. */
  readonly corrected: number;
  /**
   * Keys storage holds that the index has never seen — locally imported
   * originals, derived stand-ins, anything a watcher wrote. The catalogue scan
   * adopts each one it reaches, because only it has the record row.
   */
  readonly unknownKeys: readonly string[];
}

/**
 * What a caller supplies about a blob. The lifecycle flags are set by the
 * index itself — `add` means resident and held, `defer` means wanted, `release`
 * means let go — so a caller cannot state them inconsistently with the call it is
 * making.
 */
export type ResidentArrival = Omit<
  ResidentEntry,
  "resident" | "heldEver" | "wanted" | "released"
>;

export interface ResidentSetIndex {
  /** Record that bytes are here. Idempotent on `objectStorageKey`. */
  add(entry: ResidentArrival): void;
  /**
   * Write down a blob this node wants and lacks — the acquisition queue's only
   * write path. A resident row is left alone; a departed row keeps its
   * departure and becomes wanted again.
   */
  defer(entry: ResidentArrival): void;
  /** Wanted blobs this node lacks, oldest first. */
  deferredCandidates(limit: number): ResidentEntry[];
  /**
   * Stop wanting a blob. A row that was never held goes; a departed row stays,
   * because it is the record that these bytes were once here.
   */
  dropDeferred(objectStorageKey: string): void;
  /** Forget a blob entirely. Use this only when the *record* is gone. */
  remove(objectStorageKey: string): void;
  /**
   * Note that this node no longer holds these bytes, keeping the row.
   *
   * A discovery rather than a decision — what {@link reconcile} writes. The row
   * stops being wanted now, and the next catalogue scan may want it again, which
   * is how a node that lost bytes repairs itself. For a departure the person
   * chose, call {@link release}.
   */
  markDeparted(objectStorageKey: string): void;
  /**
   * Note that this node let these bytes go on purpose.
   *
   * "Free up space", and a watched file deleted from its folder. Beyond
   * {@link markDeparted}, this stops the acquisition pass wanting the key at all,
   * however the policy reads: a read through `ensureLocalBytes` is what brings
   * the file back, and that arrival clears the mark. See {@link ResidentEntry.released}.
   */
  release(objectStorageKey: string): void;
  /** Whether this node held these bytes and let them go. */
  wasEvicted(objectStorageKey: string): boolean;
  /** Reconcile the index against what storage actually holds. */
  reconcile(storage: ObjectStorageAdapter): Promise<ReconcileReport>;
  get(objectStorageKey: string): ResidentEntry | null;
  /** Bytes held per group. */
  usageByGroup(): Record<string, number>;
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

/**
 * Named apart from the `resident_files` table this replaced, which in turn was
 * named apart from the budgeted `resident_blobs` before it — for the same reason
 * both times. The index is a cache of a fact the filesystem also knows, so a new
 * column is cheaper to take as a new table than to migrate: an empty index is
 * repopulated by the next `reconcile`, whose `unknownKeys` the catalogue scan
 * adopts. The older tables are left behind; drop the database to remove them.
 */
const TABLE = "resident_keys";

interface Row {
  record_id: string;
  object_storage_key: string;
  size_bytes: number;
  group_key: string;
  added_at_ms: number;
  resident: number;
  held_ever: number;
  wanted: number;
  released: number;
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
      .addColumn("group_key", "text", (c) => c.notNull())
      .addColumn("added_at_ms", "integer", (c) => c.notNull())
      .addColumn("resident", "integer", (c) => c.notNull())
      .addColumn("held_ever", "integer", (c) => c.notNull())
      .addColumn("wanted", "integer", (c) => c.notNull())
      .addColumn("released", "integer", (c) => c.notNull().defaultTo(0))
      .compile().sql,
  );
  // The acquisition queue: wanted, not here, oldest first.
  db.exec(
    qb.schema
      .createIndex(`${TABLE}_queue`)
      .ifNotExists()
      .on(TABLE)
      .columns(["wanted", "resident", "added_at_ms"])
      .compile().sql,
  );

  const addStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({
        object_storage_key: sql.raw("?"),
        record_id: sql.raw("?"),
        size_bytes: sql.raw("?"),
        group_key: sql.raw("?"),
        added_at_ms: sql.raw("?"),
        resident: sql.lit(1),
        held_ever: sql.lit(1),
        wanted: sql.lit(0),
        released: sql.lit(0),
      })
      .onConflict((oc) =>
        oc.column("object_storage_key").doUpdateSet((eb) => ({
          record_id: eb.ref("excluded.record_id"),
          size_bytes: eb.ref("excluded.size_bytes"),
          group_key: eb.ref("excluded.group_key"),
          resident: sql.lit(1),
          held_ever: sql.lit(1),
          wanted: sql.lit(0),
          // The bytes are here again, so the release is spent. A read is what
          // brings back a file the person let go, and this is that arrival.
          released: sql.lit(0),
        })),
      )
      .compile().sql,
  );
  // Never touches a resident row: wanting bytes that are here means nothing.
  const deferStmt = db.prepare(
    qb
      .insertInto(TABLE)
      .values({
        object_storage_key: sql.raw("?"),
        record_id: sql.raw("?"),
        size_bytes: sql.raw("?"),
        group_key: sql.raw("?"),
        added_at_ms: sql.raw("?"),
        resident: sql.lit(0),
        held_ever: sql.lit(0),
        wanted: sql.lit(1),
        released: sql.lit(0),
      })
      .onConflict((oc) =>
        oc
          .column("object_storage_key")
          .doUpdateSet({ wanted: sql.lit(1) })
          .where("resident", "=", sql.lit(0)),
      )
      .compile().sql,
  );
  const deferredCandidatesStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .selectAll()
      .where("wanted", "=", sql.lit(1))
      .where("resident", "=", sql.lit(0))
      .orderBy("added_at_ms", "asc")
      .limit(sql.raw("?") as never)
      .compile().sql,
  );
  const dropNeverHeldStmt = db.prepare(
    qb
      .deleteFrom(TABLE)
      .where("object_storage_key", "=", sql.raw("?"))
      .where("resident", "=", sql.lit(0))
      .where("held_ever", "=", sql.lit(0))
      .compile().sql,
  );
  const unwantStmt = db.prepare(
    qb
      .updateTable(TABLE)
      .set({ wanted: sql.lit(0) })
      .where("object_storage_key", "=", sql.raw("?"))
      .compile().sql,
  );
  const removeStmt = db.prepare(
    qb.deleteFrom(TABLE).where("object_storage_key", "=", sql.raw("?")).compile().sql,
  );
  const markDepartedStmt = db.prepare(
    qb
      .updateTable(TABLE)
      .set({ resident: sql.lit(0), wanted: sql.lit(0) })
      .where("object_storage_key", "=", sql.raw("?"))
      .compile().sql,
  );
  const releaseStmt = db.prepare(
    qb
      .updateTable(TABLE)
      .set({ resident: sql.lit(0), wanted: sql.lit(0), released: sql.lit(1) })
      .where("object_storage_key", "=", sql.raw("?"))
      .compile().sql,
  );
  const getStmt = db.prepare(
    qb.selectFrom(TABLE).selectAll().where("object_storage_key", "=", sql.raw("?")).compile().sql,
  );
  const residentKeysStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(["object_storage_key"])
      .where("resident", "=", sql.lit(1))
      .compile().sql,
  );
  const usageByGroupStmt = db.prepare(
    qb
      .selectFrom(TABLE)
      .select(({ fn }) => ["group_key", fn.sum<number>("size_bytes").as("total")])
      .where("resident", "=", sql.lit(1))
      .groupBy("group_key")
      .compile().sql,
  );

  function toEntry(row: Row): ResidentEntry {
    return {
      recordId: row.record_id,
      objectStorageKey: row.object_storage_key,
      sizeBytes: row.size_bytes,
      group: row.group_key,
      addedAtMs: row.added_at_ms,
      resident: row.resident === 1,
      heldEver: row.held_ever === 1,
      wanted: row.wanted === 1,
      released: row.released === 1,
    };
  }

  function args(entry: ResidentArrival): unknown[] {
    return [entry.objectStorageKey, entry.recordId, entry.sizeBytes, entry.group, entry.addedAtMs];
  }

  return {
    add(entry) {
      addStmt.run(...args(entry));
    },
    defer(entry) {
      deferStmt.run(...args(entry));
    },
    deferredCandidates(limit) {
      return (deferredCandidatesStmt.all(limit) as unknown as Row[]).map(toEntry);
    },
    dropDeferred(objectStorageKey) {
      dropNeverHeldStmt.run(objectStorageKey);
      unwantStmt.run(objectStorageKey);
    },
    remove(objectStorageKey) {
      removeStmt.run(objectStorageKey);
    },
    markDeparted(objectStorageKey) {
      markDepartedStmt.run(objectStorageKey);
    },
    release(objectStorageKey) {
      releaseStmt.run(objectStorageKey);
    },
    wasEvicted(objectStorageKey) {
      const row = getStmt.get(objectStorageKey) as Row | undefined;
      return row !== undefined && row.resident === 0 && row.held_ever === 1;
    },
    async reconcile(storage) {
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
        markDepartedStmt.run(key);
        corrected += 1;
      }
      const unknownKeys: string[] = [];
      for (const key of held) {
        if (believed.has(key)) continue;
        if ((getStmt.get(key) as Row | undefined) !== undefined) continue;
        unknownKeys.push(key);
      }
      return { confirmed, corrected, unknownKeys };
    },
    get(objectStorageKey) {
      const row = getStmt.get(objectStorageKey) as Row | undefined;
      return row ? toEntry(row) : null;
    },
    usageByGroup() {
      const rows = usageByGroupStmt.all() as Array<{ group_key: string; total: number }>;
      return Object.fromEntries(rows.map((r) => [r.group_key, r.total]));
    },
  };
}
