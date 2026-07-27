/**
 * The stored shape of a label row. One conversion pair, shared by both SQL
 * backends — it used to be two identical copies, one per adapter.
 */
import { describe, it, expect } from "vitest";
import {
  createHLCClock,
  createStarkeepId,
  serializeHLC,
  type RecordLabel,
} from "@starkeep/protocol-primitives";
import { labelToRow, rowToLabel } from "../src/index.js";

let tick = 0;
const clock = createHLCClock({ nodeId: "nodeA", wallClockFunction: () => 1000 + tick++ });
const recordId = createStarkeepId("01J00000000000000000000001");

function label(over: Partial<RecordLabel> = {}): RecordLabel {
  const createdAt = clock.now();
  return {
    recordId,
    appId: "alpha",
    key: "quality",
    value: "high",
    recordType: "image/jpeg",
    createdAt,
    updatedAt: createdAt,
    nodeId: createdAt.nodeId,
    deletedAt: null,
    ...over,
  };
}

describe("label row serialization", () => {
  it("round-trips a valued live label", () => {
    const original = label();
    expect(rowToLabel(labelToRow(original))).toEqual(original);
  });

  it("round-trips a bare flag — a null value is not an absent one", () => {
    const original = label({ value: null });
    const row = labelToRow(original);
    expect(row.value).toBeNull();
    expect(rowToLabel(row)).toEqual(original);
  });

  it("round-trips a tombstone", () => {
    const deletedAt = clock.now();
    const original = label({ deletedAt, updatedAt: deletedAt });
    expect(rowToLabel(labelToRow(original)).deletedAt).toEqual(deletedAt);
  });

  it("writes node_id from updatedAt, not from the label's own field", () => {
    // The column is a denormalization of the LWW timestamp's node. Taking it
    // from the separate field would let a malformed snapshot write a row whose
    // node_id and updated_at disagree — and the sync watermark is grouped by
    // node_id, so that row would be filed under a node that never wrote it.
    const updatedAt = clock.now();
    const row = labelToRow(label({ updatedAt, nodeId: "someone-else" }));
    expect(row.node_id).toBe(updatedAt.nodeId);
  });

  it("maps every column to its field", () => {
    const row = {
      record_id: recordId,
      app_id: "gamma",
      key: "face-count",
      value: "3",
      record_type: "image/png",
      created_at: serializeHLC(clock.now()),
      updated_at: serializeHLC(clock.now()),
      node_id: "nodeB",
      deleted_at: null,
    };
    const parsed = rowToLabel(row);
    expect(parsed.appId).toBe("gamma");
    expect(parsed.key).toBe("face-count");
    expect(parsed.value).toBe("3");
    expect(parsed.recordType).toBe("image/png");
    expect(parsed.nodeId).toBe("nodeB");
    expect(parsed.deletedAt).toBeNull();
  });
});
