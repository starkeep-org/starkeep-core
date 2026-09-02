/**
 * `round-cut.ts` at unit level.
 *
 * The integration tests in `contiguity.test.ts` prove the invariant holds
 * end-to-end; these pin the pieces, because the lattice in `computeCeilings` has
 * cases (`null` beating any timestamp, absent meaning unbounded) that are easy
 * to get subtly backwards and hard to read off a sync scenario.
 */

import { describe, it, expect } from "vitest";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { computeCeilings, cutRound, type RoundItem } from "../src/round-cut.js";

const at = (nodeId: string, wallTime: number): HLCTimestamp => ({
  wallTime,
  counter: 0,
  nodeId,
});

const item = (nodeId: string, wallTime: number, bytes = 0): RoundItem<string> => ({
  value: `${nodeId}@${wallTime}`,
  hlc: at(nodeId, wallTime),
  bytes,
});

const taken = (result: { taken: RoundItem<string>[] }) => result.taken.map((t) => t.value);

const budget = (maxItems: number, maxBytes = Number.MAX_SAFE_INTEGER) => ({
  maxItems,
  maxBytes,
});

describe("computeCeilings", () => {
  it("has no opinion about an author every stream enumerated", () => {
    expect(computeCeilings([{}, {}]).size).toBe(0);
  });

  it("takes the lowest ceiling across streams", () => {
    // The point of the whole module: an author is only safe up to the earliest
    // point *any* stream stopped at, because the streams share one watermark.
    const ceilings = computeCeilings([{ a: at("a", 50) }, { a: at("a", 20) }]);
    expect(ceilings.get("a")).toEqual(at("a", 20));
  });

  it("lets a stream that read nothing veto an author outright", () => {
    // `null` is the floor of the lattice. A stream that could not read an author
    // knows nothing about it, and one stream's confident timestamp is not
    // permission to ship past rows another stream never looked at.
    expect(computeCeilings([{ a: at("a", 50) }, { a: null }]).get("a")).toBeNull();
    expect(computeCeilings([{ a: null }, { a: at("a", 50) }]).get("a")).toBeNull();
  });

  it("keeps authors independent", () => {
    const ceilings = computeCeilings([{ a: at("a", 10) }, { b: null }]);
    expect(ceilings.get("a")).toEqual(at("a", 10));
    expect(ceilings.get("b")).toBeNull();
    expect(ceilings.has("c")).toBe(false);
  });
});

describe("cutRound", () => {
  it("ships everything when nothing is bounded", () => {
    const result = cutRound(
      [item("a", 2), item("a", 1), item("b", 5)],
      new Map(),
      budget(10),
    );
    // Sorted by HLC, because a later item shipping ahead of an earlier one is
    // exactly the gap the watermark cannot express.
    expect(taken(result)).toEqual(["a@1", "a@2", "b@5"]);
    expect(result.hasMore).toBe(false);
  });

  it("drops items above their author's ceiling and leaves other authors alone", () => {
    const result = cutRound(
      [item("a", 1), item("a", 9), item("b", 5)],
      new Map([["a", at("a", 1)]]),
      budget(10),
    );
    expect(taken(result)).toEqual(["a@1", "b@5"]);
    expect(result.hasMore).toBe(true);
  });

  it("ships nothing for an author under a null ceiling", () => {
    const result = cutRound(
      [item("a", 1), item("b", 5)],
      new Map([["a", null]]),
      budget(10),
    );
    expect(taken(result)).toEqual(["b@5"]);
    expect(result.hasMore).toBe(true);
  });

  it("reports more even when the ceiling filtered nothing visible", () => {
    // The common case, and the one that reads wrong: the scan stopped *at* the
    // ceiling, so every candidate it produced is under it and nothing appears to
    // be held back. The backlog is still sitting in the table.
    const result = cutRound([item("a", 1)], new Map([["a", at("a", 1)]]), budget(10));
    expect(taken(result)).toEqual(["a@1"]);
    expect(result.hasMore).toBe(true);
  });

  it("spends the byte budget in HLC order and stops", () => {
    const result = cutRound(
      [item("a", 1, 400), item("a", 2, 400), item("a", 3, 400)],
      new Map(),
      { maxItems: 10, maxBytes: 1000 },
    );
    expect(taken(result)).toEqual(["a@1", "a@2"]);
    expect(result.hasMore).toBe(true);
  });

  it("charges nothing for items carrying no blob", () => {
    // What lets one pair of budgets serve a photo channel and a caption channel
    // without a per-app knob.
    const result = cutRound(
      [item("a", 1, 0), item("a", 2, 0), item("a", 3, 0)],
      new Map(),
      { maxItems: 10, maxBytes: 1 },
    );
    expect(taken(result)).toHaveLength(3);
    expect(result.hasMore).toBe(false);
  });

  it("takes one oversized item rather than stalling the channel forever", () => {
    const result = cutRound([item("a", 1, 10_000)], new Map(), {
      maxItems: 10,
      maxBytes: 100,
    });
    expect(taken(result)).toEqual(["a@1"]);
    expect(result.hasMore).toBe(false);
  });

  it("does not let an oversized first item drag the rest of the round with it", () => {
    const result = cutRound(
      [item("a", 1, 10_000), item("a", 2, 1)],
      new Map(),
      { maxItems: 10, maxBytes: 100 },
    );
    expect(taken(result)).toEqual(["a@1"]);
    expect(result.hasMore).toBe(true);
  });

  it("honours the item cap independently of bytes", () => {
    const result = cutRound(
      [item("a", 1), item("a", 2), item("a", 3)],
      new Map(),
      budget(2),
    );
    expect(taken(result)).toEqual(["a@1", "a@2"]);
    expect(result.hasMore).toBe(true);
  });

  it("leaves a contiguous per-author prefix when both budgets bite at once", () => {
    // The property everything else exists to preserve, stated directly: for
    // every author, what ships is an unbroken run from the bottom.
    const items = [
      item("a", 1, 300),
      item("a", 2, 300),
      item("a", 3, 300),
      item("b", 4, 300),
      item("b", 5, 300),
    ];
    const result = cutRound(items, new Map([["a", at("a", 2)]]), {
      maxItems: 3,
      maxBytes: 900,
    });
    const perAuthor = new Map<string, number[]>();
    for (const t of result.taken) {
      perAuthor.set(t.hlc.nodeId, [...(perAuthor.get(t.hlc.nodeId) ?? []), t.hlc.wallTime]);
    }
    for (const [nodeId, times] of perAuthor) {
      const all = items
        .filter((i) => i.hlc.nodeId === nodeId)
        .map((i) => i.hlc.wallTime)
        .sort((x, y) => x - y);
      expect(times, nodeId).toEqual(all.slice(0, times.length));
    }
  });
});

/**
 * The receiver's watermark is one HLC per author meaning "everything at or
 * below this is applied", and the next round asks for strictly more. So a
 * timestamp is the smallest thing a shipment can be cut at: ship half of one
 * and the other half becomes unnameable forever.
 *
 * This is the unit-level pin for the failure found on a handset — two rendition
 * records whose `photos/rendition` label carried the same HLC as the record and
 * was cut away behind it.
 */
describe("cutRound treats one author's timestamp as indivisible", () => {
  /** Two items sharing one author's timestamp, as a record and its label do. */
  const pair = (nodeId: string, wallTime: number, bytes = 0): RoundItem<string>[] => [
    { value: `${nodeId}@${wallTime}:record`, hlc: at(nodeId, wallTime), bytes },
    { value: `${nodeId}@${wallTime}:label`, hlc: at(nodeId, wallTime), bytes: 0 },
  ];

  it("holds a whole timestamp back rather than shipping part of it", () => {
    // An item budget of 3 lands mid-pair. Taking the third item would advance
    // the peer past a timestamp whose fourth item was never sent.
    const result = cutRound(
      [...pair("a", 10), ...pair("a", 20)],
      new Map(),
      budget(3),
    );
    expect(taken(result)).toEqual(["a@10:record", "a@10:label"]);
    expect(result.hasMore).toBe(true);
  });

  it("does the same when the byte budget is what runs out", () => {
    const result = cutRound(
      [...pair("a", 10, 100), ...pair("a", 20, 900)],
      new Map(),
      budget(10, 500),
    );
    expect(taken(result)).toEqual(["a@10:record", "a@10:label"]);
    expect(result.hasMore).toBe(true);
  });

  it("still ships an oversized first timestamp, so a channel cannot stall", () => {
    // The first-item rule, widened to the first timestamp: refusing this would
    // not make rounds smaller, it would mean this pair never moves.
    const result = cutRound(pair("a", 10, 5_000), new Map(), budget(1, 10));
    expect(taken(result)).toEqual(["a@10:record", "a@10:label"]);
  });

  it("does not group equal wall times belonging to different authors", () => {
    // Watermarks are per author, so `b`'s row at the same instant is not part
    // of `a`'s timestamp and may be cut away from it freely.
    const result = cutRound(
      [...pair("a", 10), item("b", 10)],
      new Map(),
      budget(2),
    );
    expect(taken(result)).toEqual(["a@10:record", "a@10:label"]);
  });
});
