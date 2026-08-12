/**
 * The acquisition queue as it lives in the resident set — `defer`,
 * `deferredCandidates`, `dropDeferred`, and the `held_ever` column all three
 * turn on.
 *
 * The bar here is the mirror of `eviction.test.ts`'s: every case that asserts a
 * row is *left alone* would, if the guard it covers were removed, either take
 * bytes that are on disk out of their budget or erase the only record that this
 * node once held something and let it go.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createSqliteResidentSetIndex,
  type ResidentArrival,
  type ResidentSetIndex,
} from "../src/resident-set.js";
import { compareEvictionRank } from "../src/residency-policy.js";

const LINE = "photos:image-medium";

function newIndex(): ResidentSetIndex {
  return createSqliteResidentSetIndex({ db: new DatabaseSync(":memory:") as never });
}

function entry(over: Partial<ResidentArrival> & { objectStorageKey: string }): ResidentArrival {
  return {
    recordId: `record-of-${over.objectStorageKey}`,
    sizeBytes: 1000,
    sizeClass: LINE,
    budgetLineKey: LINE,
    namespace: "photos",
    pinned: false,
    protectedLocally: false,
    requiresDurabilityProof: false,
    recencyAtMs: null,
    lastOpenedAtMs: null,
    addedAtMs: 1,
    ...over,
  };
}

describe("what a deferred row is, and what it is not", () => {
  it("does not count toward the line's usage and is not an eviction candidate", () => {
    const index = newIndex();
    index.defer(entry({ objectStorageKey: "k1" }));

    // The two facts that make a queue row a hint rather than a claim about
    // disk. A deferred row that counted would charge a budget for bytes nobody
    // has, and one offered for eviction would have the pass delete a key that
    // was never written.
    expect(index.usageOf(LINE)).toBe(0);
    expect(index.evictionCandidates({ budgetLineKey: LINE, targetBytes: 1e9 })).toEqual([]);
  });

  /**
   * The reason `held_ever` exists at all.
   *
   * `resident = 0` used to mean exactly one thing — held and let go — and
   * `residencyOf` reads it as `evicted`, its one unrecoverable state. A queue
   * row is also not resident, so without the narrowing every blob waiting to be
   * acquired would report as gone for good.
   */
  it("does not report as evicted, where a departed row does", () => {
    const index = newIndex();
    index.defer(entry({ objectStorageKey: "queued" }));
    index.add(entry({ objectStorageKey: "departed" }));
    index.markDeparted("departed");

    expect(index.wasEvicted("queued")).toBe(false);
    expect(index.wasEvicted("departed")).toBe(true);
  });

  it("becomes a held row when the bytes actually arrive", () => {
    const index = newIndex();
    index.defer(entry({ objectStorageKey: "k1" }));
    index.add(entry({ objectStorageKey: "k1" }));

    const row = index.get("k1");
    expect(row?.resident).toBe(true);
    expect(row?.heldEver).toBe(true);
    expect(index.usageOf(LINE)).toBe(1000);
    // And having been held, it is now an eviction record if it ever goes.
    index.markDeparted("k1");
    expect(index.wasEvicted("k1")).toBe(true);
  });
});

describe("defer cannot damage a row it did not write", () => {
  it("leaves a resident row resident", () => {
    const index = newIndex();
    index.add(entry({ objectStorageKey: "k1", sizeBytes: 4000 }));

    index.defer(entry({ objectStorageKey: "k1", sizeBytes: 4000 }));

    // If the guard were missing this would read 0: bytes on disk, out of their
    // budget, and the next eviction pass working to a target it had passed.
    expect(index.usageOf(LINE)).toBe(4000);
    expect(index.get("k1")?.resident).toBe(true);
    expect(index.wasEvicted("k1")).toBe(false);
  });

  it("leaves a reservation charged", () => {
    const index = newIndex();
    index.reserve(entry({ objectStorageKey: "k1", sizeBytes: 4000 }));

    index.defer(entry({ objectStorageKey: "k1", sizeBytes: 4000 }));

    expect(index.usageOf(LINE)).toBe(4000);
    expect(index.get("k1")?.reserved).toBe(true);
  });

  it("leaves a departed row an eviction record", () => {
    const index = newIndex();
    index.add(entry({ objectStorageKey: "k1" }));
    index.markDeparted("k1");

    index.defer(entry({ objectStorageKey: "k1" }));

    // The departure is the only durable evidence that no round will resend
    // these bytes. Overwriting it would make `residencyOf` report a blob the
    // peer considers delivered as merely queued.
    expect(index.wasEvicted("k1")).toBe(true);
    expect(index.get("k1")?.heldEver).toBe(true);
  });

  it("refreshes a row that is already deferred", () => {
    const index = newIndex();
    index.defer(entry({ objectStorageKey: "k1", sizeBytes: 10, budgetLineKey: "photos:*" }));
    index.defer(entry({ objectStorageKey: "k1", sizeBytes: 20, budgetLineKey: LINE }));

    // A policy edit can move a rung between lines, and re-queueing is when the
    // caller has re-resolved it — the same reasoning `add` applies on arrival.
    const row = index.get("k1");
    expect(row?.sizeBytes).toBe(20);
    expect(row?.budgetLineKey).toBe(LINE);
  });

  it("keeps the node-local state a re-queue has no business forgetting", () => {
    const index = newIndex();
    index.defer(entry({ objectStorageKey: "k1" }));
    index.setPinned("k1", true);
    index.markOpened("k1", 5_000);

    index.defer(entry({ objectStorageKey: "k1", lastOpenedAtMs: null }));

    const row = index.get("k1");
    expect(row?.pinned).toBe(true);
    expect(row?.lastOpenedAtMs).toBe(5_000);
  });
});

describe("dropDeferred", () => {
  it("forgets a queued row", () => {
    const index = newIndex();
    index.defer(entry({ objectStorageKey: "k1" }));
    index.dropDeferred("k1");
    expect(index.get("k1")).toBeNull();
  });

  it("refuses to forget an eviction record", () => {
    const index = newIndex();
    index.add(entry({ objectStorageKey: "k1" }));
    index.markDeparted("k1");

    index.dropDeferred("k1");

    // The pass tidying its own queue must not be able to delete the fact that
    // these bytes were here — that fact is what stops `residencyOf` promising a
    // round will bring them back.
    expect(index.wasEvicted("k1")).toBe(true);
  });

  it("refuses to forget a resident row", () => {
    const index = newIndex();
    index.add(entry({ objectStorageKey: "k1" }));
    index.dropDeferred("k1");
    expect(index.get("k1")?.resident).toBe(true);
  });
});

describe("the queue is the eviction order read backwards", () => {
  /**
   * Ranks chosen so no two rows tie under `compareEvictionRank` — a total
   * order, so "the reverse of the sort" and "sorted by the reversed
   * comparison" are the same list and the assertion has one meaning.
   *
   * Nulls appear on both terms deliberately. SQLite sorts NULL first
   * ascending, so the whole of the queue's null placement is inherited from
   * reversing the direction, and the two orderings agreeing about undated and
   * never-opened material is exactly the property that could silently drift.
   */
  const ranks = [
    { lastOpenedAtMs: null, recencyAtMs: null },
    { lastOpenedAtMs: null, recencyAtMs: 100 },
    { lastOpenedAtMs: null, recencyAtMs: 900 },
    { lastOpenedAtMs: 10, recencyAtMs: null },
    { lastOpenedAtMs: 10, recencyAtMs: 400 },
    { lastOpenedAtMs: 700, recencyAtMs: null },
    { lastOpenedAtMs: 700, recencyAtMs: 200 },
    { lastOpenedAtMs: 900, recencyAtMs: 5 },
  ];

  it("returns the exact reverse of compareEvictionRank over a shuffled fixture", () => {
    const index = newIndex();
    // Shuffled by a fixed permutation rather than at random: a flaky ordering
    // test is worse than none, and the property does not need entropy.
    const insertionOrder = [4, 7, 0, 5, 2, 6, 1, 3];
    for (const i of insertionOrder) {
      index.defer(entry({ objectStorageKey: `k${i}`, ...ranks[i]! }));
    }

    const worstFirst = [...ranks.keys()]
      .sort((a, b) => compareEvictionRank(ranks[a]!, ranks[b]!))
      .map((i) => `k${i}`);

    expect(
      index.deferredCandidates({ budgetLineKey: LINE, limit: 100 }).map((e) => e.objectStorageKey),
    ).toEqual([...worstFirst].reverse());
  });

  it("offers departed rows alongside deferred ones", () => {
    const index = newIndex();
    index.add(entry({ objectStorageKey: "evicted", lastOpenedAtMs: 900 }));
    index.markDeparted("evicted");
    index.defer(entry({ objectStorageKey: "queued", lastOpenedAtMs: 10 }));

    // A blob this node held and let go is a queue entry with better provenance
    // than most. Skipping it would leave every evicted blob with no route home
    // but a user tapping it, which is the population the acquisition pass
    // exists for.
    expect(
      index.deferredCandidates({ budgetLineKey: LINE, limit: 10 }).map((e) => e.objectStorageKey),
    ).toEqual(["evicted", "queued"]);
  });

  it("offers neither resident rows nor reservations", () => {
    const index = newIndex();
    index.add(entry({ objectStorageKey: "here" }));
    index.reserve(entry({ objectStorageKey: "coming" }));
    index.defer(entry({ objectStorageKey: "queued" }));

    expect(
      index.deferredCandidates({ budgetLineKey: LINE, limit: 10 }).map((e) => e.objectStorageKey),
    ).toEqual(["queued"]);
  });

  it("only ever answers about one budget line", () => {
    const index = newIndex();
    index.defer(entry({ objectStorageKey: "mine", budgetLineKey: LINE }));
    index.defer(entry({ objectStorageKey: "theirs", budgetLineKey: "photos:image-large" }));

    expect(
      index.deferredCandidates({ budgetLineKey: LINE, limit: 10 }).map((e) => e.objectStorageKey),
    ).toEqual(["mine"]);
  });

  it("pages rather than reading the line", () => {
    const index = newIndex();
    for (let i = 0; i < 20; i += 1) {
      index.defer(entry({ objectStorageKey: `k${i}`, lastOpenedAtMs: i }));
    }
    expect(index.deferredCandidates({ budgetLineKey: LINE, limit: 3 })).toHaveLength(3);
  });
});

describe("the queue query is served by an index", () => {
  /**
   * A background pass over a cold library asks this question every tick, and a
   * cold library's queue is the whole library. Sorting it in a temp b-tree is
   * the 300k-rows-into-a-handset's-heap problem this whole file exists to
   * avoid, arrived at from the other direction.
   */
  it("does not build a temporary b-tree for the ordering", () => {
    const db = new DatabaseSync(":memory:");
    createSqliteResidentSetIndex({ db: db as never });
    const plan = (
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM resident_blobs WHERE budget_line = ? " +
            "AND resident = 0 AND reserved = 0 " +
            "ORDER BY last_opened_at_ms DESC, recency_at_ms DESC LIMIT 10",
        )
        .all() as unknown as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join("\n");

    expect(plan).toContain("resident_blobs_deferred");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
