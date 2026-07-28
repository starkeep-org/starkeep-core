/**
 * The label pagination cursors.
 *
 * Two token types that look alike — both base64url JSON arrays — and mean
 * different orders: `LabelCursor` keys on the reverse index's
 * `(value, record_id)`, `LabelScanCursor` on the primary key. Most of what is
 * pinned here is that they stay distinguishable, and that a token a caller
 * hand-edited degrades to "first page" rather than to a 500.
 */
import { describe, it, expect } from "vitest";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import {
  compareLabelOrder,
  compareLabelScanOrder,
  decodeLabelCursor,
  decodeLabelScanCursor,
  encodeLabelCursor,
  encodeLabelScanCursor,
  isAfterLabelCursor,
  isAfterLabelScanCursor,
} from "../src/index.js";

const id = (s: string) => s as StarkeepId;

describe("LabelCursor", () => {
  it("round-trips a valued cursor", () => {
    const cursor = { value: "high", recordId: id("rec1") };
    expect(decodeLabelCursor(encodeLabelCursor(cursor))).toEqual(cursor);
  });

  it("round-trips an empty value — a bare flag is a first-class label", () => {
    // The case a bare record-id cursor gets wrong, and the one a JSON round
    // trip is most likely to turn into undefined or null.
    const cursor = { value: "", recordId: id("rec1") };
    expect(decodeLabelCursor(encodeLabelCursor(cursor))).toEqual(cursor);
  });

  it("rejects a null value — there is no null in the label model", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    expect(decodeLabelCursor(b64([null, "rec1"]))).toBeNull();
  });

  it("round-trips values containing the characters an ad-hoc encoding would break on", () => {
    for (const value of ["a/b", "a,b", "=", '{"json":true}', "🙂", " "]) {
      const cursor = { value, recordId: id("rec1") };
      expect(decodeLabelCursor(encodeLabelCursor(cursor)), value).toEqual(cursor);
    }
  });

  it("returns null for a malformed token rather than throwing", () => {
    // A caller who hand-edits an opaque token gets the first page, not a 500.
    for (const token of ["", "not-base64url!!", "!!!!", "e30", "bm90LWpzb24"]) {
      expect(decodeLabelCursor(token), token).toBeNull();
    }
  });

  it("rejects a well-formed token whose contents are the wrong shape", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    expect(decodeLabelCursor(b64(["only-one"]))).toBeNull();
    expect(decodeLabelCursor(b64(["a", "b", "c"]))).toBeNull();
    expect(decodeLabelCursor(b64([5, "rec1"]))).toBeNull();
    expect(decodeLabelCursor(b64(["v", 5]))).toBeNull();
    expect(decodeLabelCursor(b64(["v", ""]))).toBeNull();
    expect(decodeLabelCursor(b64({ value: "v", recordId: "r" }))).toBeNull();
  });

  it("does not accept a scan cursor — the two orders are not interchangeable", () => {
    // Both are base64url JSON arrays, so this is exactly the confusion that
    // would decode into the wrong sort order and page silently wrongly.
    const scan = encodeLabelScanCursor({
      recordId: id("rec1"),
      appId: "alpha",
      key: "k",
      value: "v",
    });
    expect(decodeLabelCursor(scan)).toBeNull();
  });
});

describe("LabelScanCursor", () => {
  it("round-trips all four primary-key parts", () => {
    // `value` included: without it the scan cursor is not unique, and every
    // sibling value of a key after the first would be skipped — losing rows
    // from the sync stream, silently, since a short page is not an error.
    const cursor = {
      recordId: id("rec1"),
      appId: "alpha",
      key: "ocr-available",
      value: "",
    };
    expect(decodeLabelScanCursor(encodeLabelScanCursor(cursor))).toEqual(cursor);
  });

  it("returns null for malformed or wrong-shaped tokens", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    expect(decodeLabelScanCursor("garbage!!")).toBeNull();
    expect(decodeLabelScanCursor(b64(["rec1", "alpha"]))).toBeNull();
    expect(decodeLabelScanCursor(b64(["rec1", "alpha", "k"]))).toBeNull();
    expect(decodeLabelScanCursor(b64(["rec1", "alpha", "k", 5]))).toBeNull();
  });

  it("does not accept a reverse cursor", () => {
    const reverse = encodeLabelCursor({ value: "", recordId: id("rec1") });
    expect(decodeLabelScanCursor(reverse)).toBeNull();
  });
});

describe("compareLabelOrder", () => {
  // This is the order the SQL adapters' reverse index produces, and an
  // in-memory adapter has to match it or it pages correctly against itself and
  // disagrees with both real backends. Bare flags ("") sort first naturally,
  // which is what dropping NULL bought: the two backends now agree without the
  // reverse query having to spell an ordering out on one of them.
  it("sorts by value — empty first — then by record id", () => {
    const rows = [
      { value: "zebra", recordId: id("r1") },
      { value: "", recordId: id("r9") },
      { value: "apple", recordId: id("r5") },
      { value: "", recordId: id("r2") },
      { value: "apple", recordId: id("r3") },
    ];
    expect([...rows].sort(compareLabelOrder).map((r) => r.recordId)).toEqual([
      "r2",
      "r9",
      "r3",
      "r5",
      "r1",
    ]);
  });

  it("is consistent with isAfterLabelCursor for both flags and values", () => {
    const flagCursor = { value: "", recordId: id("r5") };
    expect(isAfterLabelCursor({ value: "", recordId: id("r6") }, flagCursor)).toBe(true);
    expect(isAfterLabelCursor({ value: "", recordId: id("r4") }, flagCursor)).toBe(false);
    // Every non-empty value is past a bare-flag cursor.
    expect(isAfterLabelCursor({ value: "a", recordId: id("r1") }, flagCursor)).toBe(true);

    const valued = { value: "m", recordId: id("r5") };
    expect(isAfterLabelCursor({ value: "n", recordId: id("r1") }, valued)).toBe(true);
    expect(isAfterLabelCursor({ value: "m", recordId: id("r6") }, valued)).toBe(true);
    expect(isAfterLabelCursor({ value: "m", recordId: id("r5") }, valued)).toBe(false);
    // A flag can never follow a valued cursor.
    expect(isAfterLabelCursor({ value: "", recordId: id("r9") }, valued)).toBe(false);
  });
});

describe("compareLabelScanOrder", () => {
  it("orders by record id, then app id, then key, then value", () => {
    const rows = [
      { recordId: id("r2"), appId: "alpha", key: "a", value: "" },
      { recordId: id("r1"), appId: "gamma", key: "a", value: "" },
      { recordId: id("r1"), appId: "alpha", key: "z", value: "" },
      { recordId: id("r1"), appId: "alpha", key: "a", value: "Bob" },
      { recordId: id("r1"), appId: "alpha", key: "a", value: "Alice" },
    ];
    expect(
      [...rows]
        .sort(compareLabelScanOrder)
        .map((r) => `${r.recordId}/${r.appId}/${r.key}=${r.value}`),
    ).toEqual([
      "r1/alpha/a=Alice",
      "r1/alpha/a=Bob",
      "r1/alpha/z=",
      "r1/gamma/a=",
      "r2/alpha/a=",
    ]);
  });

  it("agrees with isAfterLabelScanCursor at every tie-break level", () => {
    const cursor = { recordId: id("r1"), appId: "alpha", key: "m", value: "m" };
    expect(isAfterLabelScanCursor({ ...cursor, key: "n" }, cursor)).toBe(true);
    expect(isAfterLabelScanCursor({ ...cursor, key: "l" }, cursor)).toBe(false);
    expect(isAfterLabelScanCursor({ ...cursor, appId: "beta", key: "a" }, cursor)).toBe(true);
    expect(isAfterLabelScanCursor({ ...cursor, recordId: id("r0"), key: "z" }, cursor)).toBe(
      false,
    );
    // The value tie-break: two values of one key, which is the case that
    // silently dropped rows before `value` joined the cursor.
    expect(isAfterLabelScanCursor({ ...cursor, value: "n" }, cursor)).toBe(true);
    expect(isAfterLabelScanCursor({ ...cursor, value: "l" }, cursor)).toBe(false);
    expect(isAfterLabelScanCursor(cursor, cursor)).toBe(false);
  });
});
