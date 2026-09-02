/**
 * The behaviour every `AppSyncableApplier` must have, as executable cases that
 * each implementation runs against itself.
 *
 * ## Why this exists
 *
 * There are three implementations of this contract — SQLite, Aurora DSQL, and
 * the in-memory mock the sync-engine tests run on — and they had drifted apart
 * in ways nothing could see. The mock stored *wire entries* in a map keyed by
 * primary key, one entry per key, which cannot express a `WHERE`-less statement
 * at all. So the sync-engine suite could exercise app-syncable rows in every
 * scenario it had and still never notice that the SQL appliers turned a single
 * tombstone into "soft-delete every row in the table", or that a failed scan
 * reported itself as a complete enumeration.
 *
 * A mock is allowed to be simpler than the thing it stands in for. It is not
 * allowed to be *differently behaved* on the questions its callers depend on,
 * and the only way to keep that true over time is to ask all three the same
 * questions.
 *
 * ## Why it is not written in a test framework
 *
 * This package is published. Importing `vitest` here would put a test runner in
 * the dependency graph of every consumer, so each case is a plain async
 * function that throws, and each package's test file wires them into whatever
 * `describe`/`it` it already uses:
 *
 * ```ts
 * for (const testCase of appSyncableApplierConformance) {
 *   it(testCase.name, () => testCase.run(makeHarness()));
 * }
 * ```
 *
 * ## What a harness has to provide
 *
 * The cases speak only in rows and primary keys, never in SQL or in storage
 * layout, so a harness is small: create the table, apply entries, and report
 * what is live. See {@link ConformanceHarness}.
 */

import { serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import type { KeyedRowEntry } from "../database/app-syncable-rows.js";
import type { DigestBucket } from "../database/digest-queries.js";

/** The applier surface these cases exercise. */
export interface ConformanceApplier {
  apply(entry: KeyedRowEntry): Promise<void> | void;
  scanSince(
    appId: string,
    table: string,
    peerWatermarks: Record<string, HLCTimestamp>,
    limit: number,
  ): Promise<{
    rows: KeyedRowEntry[];
    hasMore: boolean;
    truncated: Record<string, HLCTimestamp | null>;
  }>;
  getNodeWatermarks(
    appId: string,
    table: string,
  ): Promise<Record<string, HLCTimestamp>>;
  bucketDigest(
    appId: string,
    table: string,
    prefixLength?: number,
  ): Promise<DigestBucket[]>;
}

/**
 * One implementation, ready to be asked questions.
 *
 * `liveIds` is the only read-back a case needs: every assertion below is about
 * which rows survive, which is the property a tombstone bug destroys and the one
 * a storage-shape difference must not change.
 */
export interface ConformanceHarness {
  readonly applier: ConformanceApplier;
  readonly appId: string;
  /** A table whose primary key is the single column `id`. */
  readonly table: string;
  /**
   * A second declared table whose primary key is `(tenant, id)`.
   *
   * A composite key is not an exotic configuration — it is what any table
   * scoped by owner, workspace or device looks like — and it is the one shape
   * where "name the row" can go *partly* right. `keyedWhereFor` returns null
   * rather than a partial `where` for exactly that reason, and until this table
   * existed no test reached the branch: a `where` naming one of two key columns
   * matches every row sharing that column's value, so a tombstone for one row
   * would retract a whole tenant.
   *
   * Its columns are `tenant`, `id`, `payload`, plus the three the protocol owns.
   */
  readonly compositeTable: string;
  /** Ids of rows that are present and not tombstoned, sorted ascending. */
  liveIds(): Promise<string[]>;
  /**
   * Make {@link table} exist but refuse to read.
   *
   * The contract distinguishes three answers and only two of them were ever
   * asked for: a table that is *absent* answers empty, a table that is *present*
   * answers its contents, and a table that is present and **will not read** must
   * throw. The third is what every "I could not count it" guard upstream is
   * waiting for, and no test could reach it because no real applier ever threw —
   * both SQL appliers used to swallow the error and return the empty value,
   * which is the wire value for "this table holds nothing".
   *
   * Implementation-specific by nature, so the harness supplies it. Dropping a
   * column the applier's own queries name is the usual way: the table still
   * exists, and every read of it fails.
   */
  breakReads(): Promise<void>;
  /** A second, independent instance of the same implementation — the "peer". */
  peer(): Promise<ConformanceHarness>;
}

export interface ConformanceCase {
  readonly name: string;
  run(harness: ConformanceHarness): Promise<void>;
}

// ---------------------------------------------------------------------------
// Assertions. Deliberately tiny — see the module note on not importing vitest.
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`[app-syncable conformance] ${message}`);
}

function equalIds(actual: string[], expected: string[], what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${what}: expected ${e}, got ${a}`);
}

async function expectRejection(
  what: string,
  body: () => Promise<void> | void,
): Promise<void> {
  try {
    await body();
  } catch {
    return;
  }
  fail(`${what}: expected a rejection, but the statement was accepted`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTHOR = "conformance-node";

function hlc(wallTime: number, nodeId: string = AUTHOR): HLCTimestamp {
  return { wallTime, counter: 0, nodeId };
}

/**
 * The real serializer, not a lookalike.
 *
 * `updated_at` *is* the serialized HLC — the column every scan bound, every
 * bucket prefix and every LWW comparison reads as a string — so a fixture that
 * spelled it differently would be testing a format nothing else uses.
 */
const serialized = serializeHLC;

function insertEntry(
  h: ConformanceHarness,
  id: string,
  ts: HLCTimestamp,
  extra: Record<string, unknown> = {},
): KeyedRowEntry {
  return {
    timestamp: ts,
    appId: h.appId,
    table: h.table,
    op: "insert",
    row: {
      id,
      payload: `payload-${id}`,
      ...extra,
      updated_at: serialized(ts),
      deleted_at: null,
    },
  };
}

async function seed(
  h: ConformanceHarness,
  ids: readonly string[],
  startWallTime = 1,
): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await h.applier.apply(insertEntry(h, id, hlc(startWallTime + index)));
  }
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export const appSyncableApplierConformance: readonly ConformanceCase[] = [
  {
    name: "stores an inserted row and reports it live",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      equalIds(await h.liveIds(), ["r1", "r2", "r3"], "after three inserts");
    },
  },

  {
    name: "a local delete retracts only the row it names",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      await h.applier.apply({
        timestamp: hlc(10),
        appId: h.appId,
        table: h.table,
        op: "delete",
        row: { updated_at: serialized(hlc(10)) },
        where: { id: "r2" },
      });
      equalIds(await h.liveIds(), ["r1", "r3"], "after deleting r2");
    },
  },

  {
    // The regression test for the tombstone that wiped the peer's table. The
    // scan is what puts a delete on the wire, so the scan is where the key has
    // to survive — an entry without one degrades to "every row older than this".
    name: "a scanned tombstone carries the row's primary key",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      await h.applier.apply({
        timestamp: hlc(10),
        appId: h.appId,
        table: h.table,
        op: "delete",
        row: { updated_at: serialized(hlc(10)) },
        where: { id: "r2" },
      });

      const page = await h.applier.scanSince(h.appId, h.table, {}, 100);
      const tombstone = page.rows.find((e) => e.op === "delete");
      if (!tombstone) fail("scan returned no tombstone for the deleted row");
      if (!tombstone.where || Object.keys(tombstone.where).length === 0) {
        fail("scanned tombstone carries no `where` — it would match every row");
      }
      if (tombstone.where["id"] !== "r2") {
        fail(
          `scanned tombstone names the wrong row: ${JSON.stringify(tombstone.where)}`,
        );
      }
    },
  },

  {
    // The same defect seen from the receiving end, which is where it did its
    // damage. Everything a scan produces has to be safe to apply verbatim.
    name: "applying a scanned page reproduces the sender's rows exactly",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      await h.applier.apply({
        timestamp: hlc(10),
        appId: h.appId,
        table: h.table,
        op: "delete",
        row: { updated_at: serialized(hlc(10)) },
        where: { id: "r2" },
      });

      const page = await h.applier.scanSince(h.appId, h.table, {}, 100);
      const peer = await h.peer();
      // Oldest first, the order the sync engine applies a round in.
      const ordered = [...page.rows].sort((a, b) =>
        String(a.row?.["updated_at"] ?? "").localeCompare(
          String(b.row?.["updated_at"] ?? ""),
        ),
      );
      for (const entry of ordered) await peer.applier.apply(entry);

      equalIds(await peer.liveIds(), ["r1", "r3"], "peer after applying the page");
    },
  },

  {
    name: "refuses a delete that names no row",
    async run(h) {
      await seed(h, ["r1", "r2"]);
      await expectRejection("keyless delete", () =>
        h.applier.apply({
          timestamp: hlc(10),
          appId: h.appId,
          table: h.table,
          op: "delete",
          row: { updated_at: serialized(hlc(10)) },
        }),
      );
      equalIds(await h.liveIds(), ["r1", "r2"], "after a refused keyless delete");
    },
  },

  {
    name: "refuses an update that names no row",
    async run(h) {
      await seed(h, ["r1", "r2"]);
      await expectRejection("keyless update", () =>
        h.applier.apply({
          timestamp: hlc(10),
          appId: h.appId,
          table: h.table,
          op: "update",
          row: { payload: "clobbered", updated_at: serialized(hlc(10)) },
        }),
      );
      equalIds(await h.liveIds(), ["r1", "r2"], "after a refused keyless update");
    },
  },

  {
    // LWW is the whole conflict story, so a replayed or reordered entry has to
    // be inert. A applier that took the last write it *saw* rather than the
    // last write that *happened* would pass every happy-path sync test.
    name: "an insert older than the stored row does not overwrite it",
    async run(h) {
      await h.applier.apply(insertEntry(h, "r1", hlc(20), { payload: "new" }));
      await h.applier.apply(insertEntry(h, "r1", hlc(5), { payload: "old" }));
      const page = await h.applier.scanSince(h.appId, h.table, {}, 100);
      const row = page.rows.find((e) => e.row?.["id"] === "r1");
      if (!row) fail("r1 vanished");
      if (row.row?.["payload"] !== "new") {
        fail(`older insert overwrote the newer row: ${String(row.row?.["payload"])}`);
      }
    },
  },

  {
    name: "an update older than the stored row does not overwrite it",
    async run(h) {
      await h.applier.apply(insertEntry(h, "r1", hlc(20), { payload: "new" }));
      await h.applier.apply({
        timestamp: hlc(5),
        appId: h.appId,
        table: h.table,
        op: "update",
        row: { payload: "old", updated_at: serialized(hlc(5)) },
        where: { id: "r1" },
      });
      const page = await h.applier.scanSince(h.appId, h.table, {}, 100);
      const row = page.rows.find((e) => e.row?.["id"] === "r1");
      if (row?.row?.["payload"] !== "new") {
        fail(`older update overwrote the newer row: ${String(row?.row?.["payload"])}`);
      }
    },
  },

  {
    name: "a delete older than the stored row does not retract it",
    async run(h) {
      await h.applier.apply(insertEntry(h, "r1", hlc(20)));
      await h.applier.apply({
        timestamp: hlc(5),
        appId: h.appId,
        table: h.table,
        op: "delete",
        row: { updated_at: serialized(hlc(5)) },
        where: { id: "r1" },
      });
      equalIds(await h.liveIds(), ["r1"], "after a stale delete");
    },
  },

  {
    name: "skips rows the peer already reports holding",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      const page = await h.applier.scanSince(
        h.appId,
        h.table,
        { [AUTHOR]: hlc(2) },
        100,
      );
      equalIds(
        page.rows.map((e) => String(e.row?.["id"])).sort(),
        ["r3"],
        "delta above the peer's watermark",
      );
    },
  },

  {
    // `truncated` is what `round-cut.ts` builds every shipment's ceiling from,
    // so "how far did you get" has to be answered by every implementation the
    // same way: absent means complete, a timestamp means complete only to there.
    name: "marks how far a truncated scan actually got",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      const page = await h.applier.scanSince(h.appId, h.table, {}, 2);
      if (page.rows.length !== 2) {
        fail(`expected the limit to bind at 2, got ${page.rows.length} rows`);
      }
      if (!page.hasMore) fail("a truncated scan must report hasMore");
      const mark = page.truncated[AUTHOR];
      if (mark === undefined) {
        fail("a truncated author must carry a ceiling, not be reported complete");
      }
      if (mark === null) fail("the author was read, so its ceiling is not null");
      if (mark.wallTime !== 2) {
        fail(`ceiling should be the last row returned (2), got ${mark.wallTime}`);
      }
    },
  },

  {
    // A ceiling names an HLC, and one author's HLC can cover many rows — a
    // batch of labels is stamped with a single `clock.now()`. Report a ceiling
    // inside such a run and the peer lifts its watermark to that exact value,
    // after which `selectUnseen`, which asks for strictly more, can never offer
    // the rest of the run again. Silent and permanent.
    name: "never reports a ceiling that splits one timestamp",
    async run(h) {
      // Four rows at wall time 5, then one above it. Any limit that binds
      // inside the run of four must not name 5 as the ceiling.
      for (const id of ["r1", "r2", "r3", "r4"]) {
        await h.applier.apply(insertEntry(h, id, hlc(5)));
      }
      await h.applier.apply(insertEntry(h, "r5", hlc(9)));

      for (const limit of [1, 2, 3, 4]) {
        const page = await h.applier.scanSince(h.appId, h.table, {}, limit);
        const mark = page.truncated[AUTHOR];
        if (mark == null) continue; // complete enumeration imposes no ceiling
        if (mark.wallTime === 5) {
          fail(
            `limit ${limit} named 5 as a ceiling, but 5 covers four rows and ` +
              `only ${page.rows.length} were returned — the rest become unreachable`,
          );
        }
      }
    },
  },

  {
    // The companion to the case above: refusing to split the run must not turn
    // into refusing to move. An author whose next timestamp is wider than the
    // whole budget still has to drain, so the scan overruns rather than
    // returning a page that can never grow.
    name: "still advances when one timestamp is wider than the limit",
    async run(h) {
      for (const id of ["r1", "r2", "r3", "r4"]) {
        await h.applier.apply(insertEntry(h, id, hlc(5)));
      }
      const page = await h.applier.scanSince(h.appId, h.table, {}, 2);
      if (page.rows.length === 0) {
        fail("a limit smaller than the run returned nothing, so the author can never advance");
      }
      const mark = page.truncated[AUTHOR];
      if (mark !== undefined && mark !== null && mark.wallTime === 5) {
        fail("the whole run was the author's history, so it is complete, not capped at 5");
      }
    },
  },

  {
    name: "claims no ceiling when it enumerated everything",
    async run(h) {
      await seed(h, ["r1", "r2"]);
      const page = await h.applier.scanSince(h.appId, h.table, {}, 100);
      if (Object.keys(page.truncated).length !== 0) {
        fail(`a complete scan must impose no ceiling: ${JSON.stringify(page.truncated)}`);
      }
      if (page.hasMore) fail("a complete scan must not report hasMore");
    },
  },

  {
    // A zero budget means "I returned none of what you are owed", which is not
    // the same as "you are owed nothing" — and only the second is safe to ship
    // other streams against.
    name: "treats a zero budget as nothing-safe rather than nothing-owed",
    async run(h) {
      await seed(h, ["r1", "r2"]);
      const page = await h.applier.scanSince(h.appId, h.table, {}, 0);
      if (page.rows.length !== 0) fail("a zero budget must return no rows");
      if (page.truncated[AUTHOR] !== null) {
        fail(
          `a zero budget must pin the author's ceiling to null, got ${JSON.stringify(
            page.truncated[AUTHOR],
          )}`,
        );
      }
      if (!page.hasMore) fail("a zero budget with rows owed must report hasMore");
    },
  },

  {
    name: "reports per-author watermarks over stored rows, tombstones included",
    async run(h) {
      await seed(h, ["r1", "r2"]);
      await h.applier.apply({
        timestamp: hlc(30),
        appId: h.appId,
        table: h.table,
        op: "delete",
        row: { updated_at: serialized(hlc(30)) },
        where: { id: "r1" },
      });
      const watermarks = await h.applier.getNodeWatermarks(h.appId, h.table);
      const mark = watermarks[AUTHOR];
      if (!mark) fail("no watermark reported for the only author");
      if (mark.wallTime !== 30) {
        fail(`watermark must include the tombstone (30), got ${mark.wallTime}`);
      }
    },
  },

  {
    name: "reports nothing for a table it does not know",
    async run(h) {
      const page = await h.applier.scanSince(h.appId, "no_such_table", {}, 100);
      if (page.rows.length !== 0) fail("an unknown table returned rows");
      if (Object.keys(page.truncated).length !== 0) {
        fail("an unknown table owes nothing, so it imposes no ceiling");
      }
      const watermarks = await h.applier.getNodeWatermarks(h.appId, "no_such_table");
      if (Object.keys(watermarks).length !== 0) {
        fail("an unknown table reported watermarks");
      }
      const digest = await h.applier.bucketDigest(h.appId, "no_such_table");
      if (digest.length !== 0) fail("an unknown table reported digest buckets");
    },
  },

  // -------------------------------------------------------------------------
  // bucketDigest — the whole of it was absent from this suite
  // -------------------------------------------------------------------------

  {
    // `verify()` compares these counts across two nodes and arms a repair off
    // the difference, so two implementations that bucket the same rows
    // differently would manufacture divergence between a phone and a laptop
    // holding identical data. Nothing checked that they agreed.
    name: "buckets rows by author and by updated_at prefix",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      const digest = await h.applier.bucketDigest(h.appId, h.table, 4);

      const total = digest.reduce((n, b) => n + b.count, 0);
      if (total !== 3) fail(`three rows must produce three counted rows, got ${total}`);
      if (digest.some((b) => b.nodeId !== AUTHOR)) {
        fail(`every bucket belongs to the only author: ${JSON.stringify(digest)}`);
      }
      for (const bucket of digest) {
        if (bucket.bucket.length !== 4) {
          fail(`bucket key must be the requested prefix width: "${bucket.bucket}"`);
        }
      }
    },
  },

  {
    // Two nodes counting at different widths compare buckets that mean
    // different things, which the engine refuses — but only if both sides
    // honour the width they were handed.
    name: "honours the prefix width it was given",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      for (const width of [2, 6, 10]) {
        const digest = await h.applier.bucketDigest(h.appId, h.table, width);
        for (const bucket of digest) {
          if (bucket.bucket.length !== width) {
            fail(`asked for width ${width}, got "${bucket.bucket}"`);
          }
        }
      }
    },
  },

  {
    /**
     * A tombstone is a row, and the digest counts rows.
     *
     * The alternative reading — a digest over *live* rows — is the one that
     * looks natural and breaks the comparison: a node that has applied a
     * deletion and one that has not would then report the same count, so the
     * one integrity check that can see a lost tombstone reports agreement. The
     * counts are an integrity comparison between two stores, not a user-facing
     * item count.
     */
    name: "counts tombstones, because a deletion is a row the peer must also hold",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      const before = (await h.applier.bucketDigest(h.appId, h.table, 4)).reduce(
        (n, b) => n + b.count,
        0,
      );
      await h.applier.apply({
        timestamp: hlc(10),
        appId: h.appId,
        table: h.table,
        op: "delete",
        row: { updated_at: serialized(hlc(10)) },
        where: { id: "r2" },
      });
      equalIds(await h.liveIds(), ["r1", "r3"], "after deleting r2");

      const after = (await h.applier.bucketDigest(h.appId, h.table, 4)).reduce(
        (n, b) => n + b.count,
        0,
      );
      if (after !== before) {
        fail(`a tombstone must not change the row count: ${before} → ${after}`);
      }
    },
  },

  {
    // The property the digest exists for, stated across two stores rather than
    // within one: identical contents ⇒ identical buckets. An implementation
    // that was self-consistent and disagreed with its peer would pass every
    // case above.
    name: "two stores holding the same rows produce the same buckets",
    async run(h) {
      await seed(h, ["r1", "r2", "r3"]);
      await h.applier.apply({
        timestamp: hlc(10),
        appId: h.appId,
        table: h.table,
        op: "delete",
        row: { updated_at: serialized(hlc(10)) },
        where: { id: "r2" },
      });

      const page = await h.applier.scanSince(h.appId, h.table, {}, 100);
      const peer = await h.peer();
      const ordered = [...page.rows].sort((a, b) =>
        String(a.row?.["updated_at"] ?? "").localeCompare(
          String(b.row?.["updated_at"] ?? ""),
        ),
      );
      for (const entry of ordered) await peer.applier.apply(entry);

      const key = (buckets: DigestBucket[]) =>
        JSON.stringify(
          buckets
            .map((b) => [b.nodeId, b.bucket, b.count])
            .sort((a, b) => String(a).localeCompare(String(b))),
        );
      const mine = key(await h.applier.bucketDigest(h.appId, h.table, 4));
      const theirs = key(await peer.applier.bucketDigest(peer.appId, peer.table, 4));
      if (mine !== theirs) {
        fail(`two stores with the same rows disagree:\n  ours   ${mine}\n  theirs ${theirs}`);
      }
    },
  },

  // -------------------------------------------------------------------------
  // "I could not read it" is not "there is nothing there"
  // -------------------------------------------------------------------------

  {
    /**
     * The distinction three separate guards upstream are waiting for, asserted
     * as a contract rather than per-engine.
     *
     * Both SQL appliers used to answer an unreadable table with the *empty*
     * value — `[]` from `bucketDigest`, `{}` from `getNodeWatermarks` — which is
     * the wire value for "this table holds nothing". So the engine's
     * `complete: false` and `supported: false` paths existed, were tested with
     * injected failures, and were unreachable on every production path, because
     * no real applier ever threw.
     *
     * `getNodeWatermarks` is the sharper of the two: `scanSince` plans its
     * authors from that map, so an unreadable table answering `{}` produced no
     * scans at all and the scan then reported "nothing owed, every author
     * complete" — silent loss under a watermark claiming coverage.
     */
    name: "throws rather than answering empty when a table it has will not read",
    async run(h) {
      await seed(h, ["r1", "r2"]);
      await h.breakReads();

      await expectRejection("bucketDigest over an unreadable table", () =>
        h.applier.bucketDigest(h.appId, h.table, 4).then(() => undefined),
      );
      await expectRejection("getNodeWatermarks over an unreadable table", () =>
        h.applier.getNodeWatermarks(h.appId, h.table).then(() => undefined),
      );
    },
  },

  {
    // …and the absent table still answers empty, so the two cases have not
    // simply been collapsed into "throw on everything". Absent really does mean
    // nothing here, and a node that has not installed an app must not read as a
    // node whose storage is broken.
    name: "still answers empty for a table it does not have at all",
    async run(h) {
      await seed(h, ["r1", "r2"]);
      await h.breakReads();

      const digest = await h.applier.bucketDigest(h.appId, "no_such_table", 4);
      if (digest.length !== 0) fail("an absent table must answer with no buckets");
      const watermarks = await h.applier.getNodeWatermarks(h.appId, "no_such_table");
      if (Object.keys(watermarks).length !== 0) {
        fail("an absent table must answer with no watermarks");
      }
    },
  },

  // -------------------------------------------------------------------------
  // Composite primary keys
  // -------------------------------------------------------------------------

  {
    name: "stores and retracts one row of a composite-key table",
    async run(h) {
      const insert = (tenant: string, id: string, ts: HLCTimestamp): KeyedRowEntry => ({
        timestamp: ts,
        appId: h.appId,
        table: h.compositeTable,
        op: "insert",
        row: {
          tenant,
          id,
          payload: `${tenant}/${id}`,
          updated_at: serialized(ts),
          deleted_at: null,
        },
      });
      await h.applier.apply(insert("acme", "r1", hlc(1)));
      await h.applier.apply(insert("acme", "r2", hlc(2)));
      await h.applier.apply(insert("globex", "r1", hlc(3)));

      await h.applier.apply({
        timestamp: hlc(10),
        appId: h.appId,
        table: h.compositeTable,
        op: "delete",
        row: { updated_at: serialized(hlc(10)) },
        where: { tenant: "acme", id: "r1" },
      });

      const page = await h.applier.scanSince(h.appId, h.compositeTable, {}, 100);
      const live = page.rows
        .filter((e) => e.op === "insert")
        .map((e) => `${String(e.row?.["tenant"])}/${String(e.row?.["id"])}`)
        .sort();
      // Only the named row went. `globex/r1` shares the `id` and `acme/r2`
      // shares the `tenant`, so either half of the key alone would have taken
      // one of them with it.
      equalIds(live, ["acme/r2", "globex/r1"], "live rows after a composite delete");
    },
  },

  {
    /**
     * The branch `keyedWhereFor` exists for, and the reason it returns null
     * rather than a partial `where`.
     *
     * A tombstone that names `tenant` but not `id` matches *every row of that
     * tenant* — quieter than the keyless tombstone that wiped a whole table, and
     * worse to diagnose, because the damage is bounded and looks like a
     * legitimate bulk delete. So a row that cannot name itself does not
     * propagate its retraction at all: the deletion stays local, which loses one
     * node's intent rather than another node's data.
     */
    name: "will not propagate a tombstone that can only name part of a composite key",
    async run(h) {
      const ts = hlc(1);
      await h.applier.apply({
        timestamp: ts,
        appId: h.appId,
        table: h.compositeTable,
        op: "insert",
        row: {
          tenant: "acme",
          id: "r1",
          payload: "p",
          updated_at: serialized(ts),
          deleted_at: null,
        },
      });
      await h.applier.apply({
        timestamp: hlc(2),
        appId: h.appId,
        table: h.compositeTable,
        op: "insert",
        row: {
          tenant: "acme",
          id: "r2",
          payload: "p",
          updated_at: serialized(hlc(2)),
          deleted_at: null,
        },
      });

      // A partial `where` is refused on the way *in* as well, for the same
      // reason: it names more rows than the one it came from.
      await expectRejection("a delete naming only part of a composite key", () =>
        h.applier.apply({
          timestamp: hlc(10),
          appId: h.appId,
          table: h.compositeTable,
          op: "delete",
          row: { updated_at: serialized(hlc(10)) },
          where: { tenant: "acme" },
        }),
      );

      const page = await h.applier.scanSince(h.appId, h.compositeTable, {}, 100);
      const live = page.rows.filter((e) => e.op === "insert");
      if (live.length !== 2) {
        fail(`a refused partial delete must leave both rows: got ${live.length}`);
      }
    },
  },

  {
    // A scanned tombstone from a composite table carries *both* columns, since
    // the receiving side applies it verbatim and a half-named row is what the
    // case above refuses.
    name: "a scanned composite tombstone names every key column",
    async run(h) {
      const ts = hlc(1);
      await h.applier.apply({
        timestamp: ts,
        appId: h.appId,
        table: h.compositeTable,
        op: "insert",
        row: {
          tenant: "acme",
          id: "r1",
          payload: "p",
          updated_at: serialized(ts),
          deleted_at: null,
        },
      });
      await h.applier.apply({
        timestamp: hlc(10),
        appId: h.appId,
        table: h.compositeTable,
        op: "delete",
        row: { updated_at: serialized(hlc(10)) },
        where: { tenant: "acme", id: "r1" },
      });

      const page = await h.applier.scanSince(h.appId, h.compositeTable, {}, 100);
      const tombstone = page.rows.find((e) => e.op === "delete");
      if (!tombstone) fail("scan returned no tombstone for the composite row");
      const where = tombstone.where ?? {};
      if (where["tenant"] !== "acme" || where["id"] !== "r1") {
        fail(`composite tombstone names ${JSON.stringify(where)}, not both columns`);
      }
    },
  },
];
