/**
 * The delta scan's planner and driver, on their own.
 *
 * `delta-scan.test.ts` over in the sync engine already checks these against a
 * read-everything oracle, which is the right paranoia for the query itself.
 * What it cannot show is the *contract* — the three states of `truncated`, the
 * per-author share, and the zero-budget branch that `verify()` silently rests
 * on. Those are the parts other modules were written against, so they are the
 * parts that need to fail loudly if they change.
 */

import { describe, it, expect } from "vitest";
import { serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import { collectSince, planNodeScans, type NodeScan } from "../src/database/since-queries.js";

function hlc(wallTime: number, nodeId: string): HLCTimestamp {
  return { wallTime, counter: 0, nodeId };
}

/** A row is just its HLC here — the driver never looks at anything else. */
type Row = { hlc: HLCTimestamp };
const rowAt = (wallTime: number, nodeId: string): Row => ({ hlc: hlc(wallTime, nodeId) });

describe("planNodeScans", () => {
  it("skips an author the peer is already caught up on", () => {
    // The reason steady state costs one grouped index read and no table
    // access at all: an author with nothing newer never becomes a query.
    expect(planNodeScans({ L: hlc(5, "L") }, { L: hlc(5, "L") })).toEqual([]);
  });

  it("skips an author the peer claims to be ahead on", () => {
    expect(planNodeScans({ L: hlc(5, "L") }, { L: hlc(9, "L") })).toEqual([]);
  });

  it("scans from the peer's watermark when it is behind", () => {
    expect(planNodeScans({ L: hlc(9, "L") }, { L: hlc(5, "L") })).toEqual([
      { nodeId: "L", since: serializeHLC(hlc(5, "L")) },
    ]);
  });

  it("scans from the beginning for an author the peer has never heard of", () => {
    // `null`, not "wall time zero": the peer needs all of it, and a bound of
    // any kind would be a claim nobody made.
    expect(planNodeScans({ L: hlc(9, "L") }, {})).toEqual([
      { nodeId: "L", since: null },
    ]);
  });

  it("plans only for authors we actually hold rows from", () => {
    // The peer reporting an author we have never seen says nothing we owe.
    expect(planNodeScans({}, { C: hlc(5, "C") })).toEqual([]);
  });

  it("returns authors in a stable order", () => {
    const scans = planNodeScans(
      { c: hlc(9, "c"), a: hlc(9, "a"), b: hlc(9, "b") },
      {},
    );
    expect(scans.map((s) => s.nodeId)).toEqual(["a", "b", "c"]);
  });
});

describe("collectSince — the budget is split per author", () => {
  const scans: NodeScan[] = [
    { nodeId: "A", since: null },
    { nodeId: "B", since: null },
  ];

  /** A source with `count` rows per author, recording the share it was asked for. */
  function source(count: number, asked: number[] = []) {
    return {
      asked,
      run: async (scan: NodeScan, remaining: number) => {
        asked.push(remaining);
        // `limit + 1` is what the real query does — the extra row is how the
        // driver tells "that was everything" from "there is more".
        return Array.from({ length: Math.min(count, remaining + 1) }, (_, i) =>
          rowAt(i + 1, scan.nodeId),
        );
      },
    };
  }

  it("gives each owing author its own slice rather than spending in order", async () => {
    // Spending in author order starves: one author that cannot drain blocks
    // every author sorted after it, permanently.
    const s = source(0);
    await collectSince(scans, 10, s.run, (r) => r.hlc);
    expect(s.asked).toEqual([5, 5]);
  });

  it("gives a lone author the whole budget, so fairness costs no throughput", async () => {
    const s = source(0);
    await collectSince([scans[0]!], 10, s.run, (r) => r.hlc);
    expect(s.asked).toEqual([10]);
  });

  it("rounds the share up, so no author is ever asked for zero rows", async () => {
    // `Math.ceil` overshoots the total budget on purpose. An author asked for
    // zero would be silently skipped, which is the failure mode the split
    // exists to prevent — and overshooting costs at most one extra row each.
    const s = source(0);
    await collectSince(
      [scans[0]!, scans[1]!, { nodeId: "C", since: null }],
      2,
      s.run,
      (r) => r.hlc,
    );
    expect(s.asked).toEqual([1, 1, 1]);
  });

  it("reports no ceiling for an author it enumerated to the end", async () => {
    // Absent entry, not `null` and not a timestamp: this stream can vouch that
    // nothing older is still owed for that author.
    const page = await collectSince(
      [scans[0]!],
      10,
      async (scan) => [rowAt(1, scan.nodeId), rowAt(2, scan.nodeId)],
      (r) => r.hlc,
    );
    expect(page.truncated).toEqual({});
    expect(page.hasMore).toBe(false);
    expect(page.rows).toHaveLength(2);
  });

  it("marks the last row it actually returned when it stopped early", async () => {
    const page = await collectSince(
      [scans[0]!],
      2,
      async (scan) => [1, 2, 3].map((i) => rowAt(i, scan.nodeId)),
      (r) => r.hlc,
    );
    expect(page.rows).toHaveLength(2);
    expect(page.truncated["A"]).toEqual(hlc(2, "A"));
    expect(page.hasMore).toBe(true);
  });

  it("marks each author independently", async () => {
    // One author being cut short must not put a ceiling on another's rows —
    // the ceilings are what a shipment is cut against, and a shared one would
    // hold back a device that had nothing wrong with it.
    const page = await collectSince(
      scans,
      2,
      async (scan) =>
        scan.nodeId === "A"
          ? [1, 2, 3].map((i) => rowAt(i, "A"))
          : [rowAt(1, "B")],
      (r) => r.hlc,
    );
    expect(page.truncated["A"]).toEqual(hlc(1, "A"));
    expect(page.truncated).not.toHaveProperty("B");
  });

  it("treats a zero budget as nothing-safe, not nothing-owed", async () => {
    // The branch `verify()` rests on without saying so: it sends `limit: 0` to
    // get counts without a shipment, and this is what makes the round ship
    // nothing. `cutRound` would not — it always takes a first item regardless
    // of budget. `null` for every planned author is what stops it.
    const page = await collectSince(scans, 0, async () => [rowAt(1, "A")], (r) => r.hlc);
    expect(page.rows).toEqual([]);
    expect(page.truncated).toEqual({ A: null, B: null });
    expect(page.hasMore).toBe(true);
  });

  it("does not call the source at all for a zero budget", async () => {
    let calls = 0;
    await collectSince(
      scans,
      0,
      async () => {
        calls += 1;
        return [];
      },
      (r) => r.hlc,
    );
    expect(calls).toBe(0);
  });

  it("reports a drained channel as complete rather than as a zero-budget stop", async () => {
    // No authors owe anything, so there is nothing to put a ceiling on. The
    // empty `truncated` here means "complete", the opposite of the case above.
    const page = await collectSince([], 10, async () => [], (r: Row) => r.hlc);
    expect(page).toEqual({ rows: [], hasMore: false, truncated: {} });
  });
});

/**
 * A ceiling names an HLC and one author's HLC covers many rows — `setLabels`
 * stamps a whole batch with a single `clock.now()`. Report a ceiling from
 * inside such a run and the peer lifts its watermark to that value, after which
 * `selectUnseen` asks for strictly more and the rest of the run is unreachable.
 *
 * `round-cut.ts` refuses to split a timestamp among the candidates it is given.
 * These cover the half it cannot see: rows that never became candidates because
 * the scan stopped inside the run.
 */
describe("collectSince — a scan never stops inside one author's timestamp", () => {
  const soloScan: NodeScan[] = [{ nodeId: "A", since: null }];

  /** A source over a fixed HLC sequence, recording each window it was asked for. */
  function source(wallTimes: readonly number[]) {
    const asked: number[] = [];
    const rows = wallTimes.map((t) => rowAt(t, "A"));
    return {
      asked,
      run: async (_scan: NodeScan, remaining: number) => {
        asked.push(remaining);
        return rows.slice(0, remaining + 1);
      },
    };
  }

  it("trims back to the end of the previous run when the share lands mid-run", async () => {
    // Share 3 stops between the second and third row stamped 5. Naming 5 as the
    // ceiling would strand the third one, so the ceiling backs off to 1.
    const s = source([1, 5, 5, 5, 9]);
    const page = await collectSince(soloScan, 3, s.run, (r) => r.hlc);
    expect(page.rows).toEqual([rowAt(1, "A")]);
    expect(page.truncated["A"]).toEqual(hlc(1, "A"));
    expect(page.hasMore).toBe(true);
  });

  it("widens the read when the whole share is one timestamp", async () => {
    // Trimming would empty the page, and an empty page every round is an author
    // that never advances. The read doubles until the run ends and ships it
    // whole, overrunning the share — the same trade `cutRound` makes for an
    // oversized first group.
    const s = source([5, 5, 5, 5, 9]);
    const page = await collectSince(soloScan, 2, s.run, (r) => r.hlc);
    expect(page.rows).toEqual(Array(4).fill(rowAt(5, "A")));
    expect(page.truncated["A"]).toEqual(hlc(5, "A"));
    expect(page.hasMore).toBe(true);
    expect(s.asked).toEqual([2, 4]);
  });

  it("reports no ceiling when widening reaches the end of the author", async () => {
    const s = source([5, 5, 5]);
    const page = await collectSince(soloScan, 2, s.run, (r) => r.hlc);
    expect(page.rows).toHaveLength(3);
    expect(page.truncated).toEqual({});
    expect(page.hasMore).toBe(false);
  });

  it("still issues exactly one query when the share falls on a boundary", async () => {
    // The widening is a rare correction, not the common path. Every row here
    // carries its own timestamp, so nothing needs trimming.
    const s = source([1, 2, 3, 4, 5]);
    const page = await collectSince(soloScan, 3, s.run, (r) => r.hlc);
    expect(s.asked).toEqual([3]);
    expect(page.truncated["A"]).toEqual(hlc(3, "A"));
  });
});
