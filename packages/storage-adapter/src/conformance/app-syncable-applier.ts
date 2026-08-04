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
  /** Ids of rows that are present and not tombstoned, sorted ascending. */
  liveIds(): Promise<string[]>;
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
    },
  },
];
