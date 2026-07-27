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

  it("round-trips a null value — a bare flag is a first-class label", () => {
    // The case a bare record-id cursor gets wrong, and the one a JSON round
    // trip is most likely to turn into undefined or "".
    const cursor = { value: null, recordId: id("rec1") };
    expect(decodeLabelCursor(encodeLabelCursor(cursor))).toEqual(cursor);
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
    const scan = encodeLabelScanCursor({ recordId: id("rec1"), appId: "alpha", key: "k" });
    expect(decodeLabelCursor(scan)).toBeNull();
  });
});

describe("LabelScanCursor", () => {
  it("round-trips all three primary-key parts", () => {
    const cursor = { recordId: id("rec1"), appId: "alpha", key: "ocr-available" };
    expect(decodeLabelScanCursor(encodeLabelScanCursor(cursor))).toEqual(cursor);
  });

  it("returns null for malformed or wrong-shaped tokens", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    expect(decodeLabelScanCursor("garbage!!")).toBeNull();
    expect(decodeLabelScanCursor(b64(["rec1", "alpha"]))).toBeNull();
    expect(decodeLabelScanCursor(b64(["rec1", "alpha", 5]))).toBeNull();
  });

  it("does not accept a reverse cursor with a null value", () => {
    const reverse = encodeLabelCursor({ value: null, recordId: id("rec1") });
    expect(decodeLabelScanCursor(reverse)).toBeNull();
  });
});

describe("compareLabelOrder", () => {
  // This is the order the SQL adapters' reverse index produces; an in-memory
  // adapter that sorted nulls last (the Postgres default, and the easy mistake)
  // would page correctly against itself and disagree with both real backends.
  it("sorts nulls first, then by value, then by record id", () => {
    const rows = [
      { value: "zebra", recordId: id("r1") },
      { value: null, recordId: id("r9") },
      { value: "apple", recordId: id("r5") },
      { value: null, recordId: id("r2") },
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

  it("is consistent with isAfterLabelCursor in both the null and valued cases", () => {
    const nullCursor = { value: null, recordId: id("r5") };
    expect(isAfterLabelCursor({ value: null, recordId: id("r6") }, nullCursor)).toBe(true);
    expect(isAfterLabelCursor({ value: null, recordId: id("r4") }, nullCursor)).toBe(false);
    // Every non-null value is past a null cursor.
    expect(isAfterLabelCursor({ value: "a", recordId: id("r1") }, nullCursor)).toBe(true);

    const valued = { value: "m", recordId: id("r5") };
    expect(isAfterLabelCursor({ value: "n", recordId: id("r1") }, valued)).toBe(true);
    expect(isAfterLabelCursor({ value: "m", recordId: id("r6") }, valued)).toBe(true);
    expect(isAfterLabelCursor({ value: "m", recordId: id("r5") }, valued)).toBe(false);
    // A null can never follow a non-null cursor.
    expect(isAfterLabelCursor({ value: null, recordId: id("r9") }, valued)).toBe(false);
  });
});

describe("compareLabelScanOrder", () => {
  it("orders by record id, then app id, then key", () => {
    const rows = [
      { recordId: id("r2"), appId: "alpha", key: "a" },
      { recordId: id("r1"), appId: "gamma", key: "a" },
      { recordId: id("r1"), appId: "alpha", key: "z" },
      { recordId: id("r1"), appId: "alpha", key: "a" },
    ];
    expect(
      [...rows].sort(compareLabelScanOrder).map((r) => `${r.recordId}/${r.appId}/${r.key}`),
    ).toEqual(["r1/alpha/a", "r1/alpha/z", "r1/gamma/a", "r2/alpha/a"]);
  });

  it("agrees with isAfterLabelScanCursor at every tie-break level", () => {
    const cursor = { recordId: id("r1"), appId: "alpha", key: "m" };
    expect(isAfterLabelScanCursor({ ...cursor, key: "n" }, cursor)).toBe(true);
    expect(isAfterLabelScanCursor({ ...cursor, key: "l" }, cursor)).toBe(false);
    expect(isAfterLabelScanCursor({ ...cursor, appId: "beta", key: "a" }, cursor)).toBe(true);
    expect(isAfterLabelScanCursor({ ...cursor, recordId: id("r0"), key: "z" }, cursor)).toBe(
      false,
    );
    expect(isAfterLabelScanCursor(cursor, cursor)).toBe(false);
  });
});
