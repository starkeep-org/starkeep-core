/**
 * The label scan cursor.
 *
 * The sync outbound scan's token, keyed on the primary key
 * `(record_id, app_id, key, value)`. What is pinned here is that all four parts
 * survive a round trip — dropping `value` silently lost every sibling value of
 * a key from the sync stream — and that a token a caller hand-edited degrades
 * to "first page" rather than to a 500.
 *
 * The reverse index's own cursor used to sit beside this one, and most of this
 * file was about keeping the two distinguishable. The reverse query pages with
 * the grammar's `page_token` now (see `label-find.ts`), so there is one token
 * type here and nothing left to confuse it with.
 */
import { describe, it, expect } from "vitest";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import {
  compareLabelScanOrder,
  decodeLabelScanCursor,
  encodeLabelScanCursor,
  isAfterLabelScanCursor,
} from "../src/index.js";

const id = (s: string) => s as StarkeepId;

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
