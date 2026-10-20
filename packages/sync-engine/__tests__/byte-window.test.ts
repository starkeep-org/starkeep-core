/**
 * The transfer planner and the bytes-watermark arithmetic, on their own.
 *
 * Both transfer passes and the responder's walk rest on these two functions, so
 * their edge cases are pinned here rather than inferred from round behaviour:
 * the always-taken first head file, round-robin across authors, the skip rule,
 * whole-timestamp advancement, and the ceilings a truncated scan imposes.
 */

import { describe, expect, it } from "vitest";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { planByteWindow } from "../src/byte-window.js";
import { advanceBytesWatermark, clampToRows } from "../src/file-rows.js";

const at = (nodeId: string, wallTime: number, counter = 0): HLCTimestamp => ({
  wallTime,
  counter,
  nodeId,
});

const item = (name: string, nodeId: string, wallTime: number, bytes: number) => ({
  value: name,
  hlc: at(nodeId, wallTime),
  bytes,
});

describe("planByteWindow", () => {
  it("takes the head in timestamp order, whatever order the files arrive in", () => {
    const plan = planByteWindow(
      [item("c", "A", 3, 10), item("a", "A", 1, 10), item("b", "A", 2, 10)],
      { headBytes: 100, opportunisticBytes: 0 },
    );
    expect(plan.head).toEqual(["a", "b", "c"]);
    expect(plan.leftOver).toBe(0);
  });

  it("always takes the first head file, however large", () => {
    const plan = planByteWindow([item("video", "A", 1, 400), item("thumb", "A", 2, 1)], {
      headBytes: 10,
      opportunisticBytes: 0,
    });
    expect(plan.head).toEqual(["video"]);
    expect(plan.leftOver).toBe(1);
  });

  it("stops an author's head at the first file that does not fit, and lets small files past it", () => {
    const plan = planByteWindow(
      [item("a1", "A", 1, 5), item("a2", "A", 2, 50), item("a3", "A", 3, 1), item("a4", "A", 4, 2)],
      { headBytes: 10, opportunisticBytes: 10 },
    );
    // a3 is not head: a2 before it is still owed.
    expect(plan.head).toEqual(["a1"]);
    // Smallest first, skipping a2 because it does not fit.
    expect(plan.opportunistic).toEqual(["a3", "a4"]);
    expect(plan.leftOver).toBe(1);
  });

  it("shares the head round-robin across authors", () => {
    const plan = planByteWindow(
      [
        item("a1", "A", 1, 4),
        item("a2", "A", 2, 4),
        item("a3", "A", 3, 4),
        item("b1", "B", 1, 4),
        item("b2", "B", 2, 4),
      ],
      { headBytes: 16, opportunisticBytes: 0 },
    );
    // One per author per pass, so a large backlog from A does not starve B.
    expect(plan.head.sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("caps the opportunistic allotment by file count", () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`f${i}`, "A", i + 2, 1));
    const plan = planByteWindow([item("head", "A", 1, 1_000), ...items], {
      headBytes: 1,
      opportunisticBytes: 1_000,
      opportunisticMaxFiles: 3,
    });
    expect(plan.opportunistic).toHaveLength(3);
    expect(plan.leftOver).toBe(7);
  });

  it("orders the opportunistic allotment by the caller's preference before size", () => {
    const plan = planByteWindow(
      [
        item("head", "A", 1, 100),
        item("small-missing", "A", 2, 1),
        item("larger-available", "A", 3, 5),
      ],
      {
        headBytes: 1,
        opportunisticBytes: 100,
        opportunisticOrder: (name) => (name === "larger-available" ? 0 : 1),
      },
    );
    expect(plan.opportunistic).toEqual(["larger-available", "small-missing"]);
  });

  it("leaves a skipped file out of both allotments and out of the left-over count", () => {
    const plan = planByteWindow([item("a1", "A", 1, 1), item("a2", "A", 2, 1)], {
      headBytes: 100,
      opportunisticBytes: 100,
      skip: (name) => name === "a1",
    });
    expect(plan.head).toEqual(["a2"]);
    expect(plan.opportunistic).toEqual([]);
    expect(plan.leftOver).toBe(0);
  });

  it("plans nothing for nothing", () => {
    expect(planByteWindow([], { headBytes: 1, opportunisticBytes: 1 })).toEqual({
      head: [],
      opportunistic: [],
      leftOver: 0,
    });
  });
});

describe("advanceBytesWatermark", () => {
  const row = (nodeId: string, wallTime: number, satisfied: boolean, counter = 0) => ({
    hlc: at(nodeId, wallTime, counter),
    satisfied,
  });

  it("advances over a contiguous satisfied run and stops at the first unsatisfied row", () => {
    const next = advanceBytesWatermark(
      {},
      [row("A", 1, true), row("A", 2, true), row("A", 3, false), row("A", 4, true)],
      new Map(),
    );
    expect(next["A"]).toEqual(at("A", 2));
  });

  it("keeps authors independent", () => {
    const next = advanceBytesWatermark(
      {},
      [row("A", 1, false), row("B", 1, true), row("B", 2, true)],
      new Map(),
    );
    expect(next["A"]).toBeUndefined();
    expect(next["B"]).toEqual(at("B", 2));
  });

  it("moves in whole timestamps: one unsatisfied row holds every row sharing its time", () => {
    const shared = at("A", 5);
    const next = advanceBytesWatermark(
      { A: at("A", 1) },
      [
        { hlc: shared, satisfied: true },
        { hlc: shared, satisfied: false },
      ],
      new Map(),
    );
    expect(next["A"]).toEqual(at("A", 1));
  });

  it("never passes an author's ceiling, and advances nothing under a null one", () => {
    const rows = [row("A", 1, true), row("A", 2, true), row("A", 3, true), row("B", 1, true)];
    const next = advanceBytesWatermark(
      {},
      rows,
      new Map([
        ["A", at("A", 2)],
        ["B", null],
      ]),
    );
    expect(next["A"]).toEqual(at("A", 2));
    expect(next["B"]).toBeUndefined();
  });

  it("never lowers a value", () => {
    const next = advanceBytesWatermark({ A: at("A", 9) }, [row("A", 3, true)], new Map());
    expect(next["A"]).toEqual(at("A", 9));
  });
});

describe("clampToRows", () => {
  it("lowers a bytes watermark to the rows watermark and drops authors with no rows", () => {
    const clamped = clampToRows(
      { A: at("A", 9), B: at("B", 2), C: at("C", 4) },
      { A: at("A", 5), B: at("B", 7) },
    );
    expect(clamped).toEqual({ A: at("A", 5), B: at("B", 2) });
  });
});
