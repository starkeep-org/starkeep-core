import { describe, it, expect } from "vitest";
import {
  dedupeLabelWrites,
  planLabelWrites,
  planLabelRetractions,
  LABEL_VALUE_MAX_BYTES,
  LABEL_VALUES_PER_KEY_MAX,
  labelValueSetKey,
  formatLabelRef,
  isValidLabelKey,
  isValidLabelValue,
  labelValueByteLength,
  parseLabelRef,
  validateLabelWrite,
} from "../src/records/labels.js";

describe("isValidLabelKey", () => {
  it("accepts identifier-shaped keys", () => {
    for (const key of ["ocr-available", "face-count", "quality", "v2.index", "a", "x_y"]) {
      expect(isValidLabelKey(key), key).toBe(true);
    }
  });

  it("rejects keys that are content rather than identifiers", () => {
    // Uppercase, spaces, slashes and punctuation are all out: a key is schema,
    // and an app that can put arbitrary text in one is using keys as data.
    for (const key of ["OCR", "has text", "a/b", "café", "needs review!", ""]) {
      expect(isValidLabelKey(key), key).toBe(false);
    }
  });

  it("rejects a key that does not start alphanumeric", () => {
    for (const key of ["-lead", ".lead", "_lead"]) {
      expect(isValidLabelKey(key), key).toBe(false);
    }
  });

  it("caps key length at 64 characters", () => {
    expect(isValidLabelKey("a".repeat(64))).toBe(true);
    expect(isValidLabelKey("a".repeat(65))).toBe(false);
  });
});

describe("isValidLabelValue", () => {
  it("accepts the empty string — a bare flag is a first-class label", () => {
    // There is no null in the label model: 0 bytes is trivially within the
    // limit, and row-present vs row-absent is what carries the meaning.
    expect(isValidLabelValue("")).toBe(true);
  });

  it("accepts values up to 128 bytes", () => {
    expect(isValidLabelValue("a".repeat(LABEL_VALUE_MAX_BYTES))).toBe(true);
    expect(isValidLabelValue("a".repeat(LABEL_VALUE_MAX_BYTES + 1))).toBe(false);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 43 emoji × 4 bytes = 172 bytes, but only 43 code points. Measuring
    // characters here would let a value nearly a third over the limit through.
    const emoji = "🙂".repeat(43);
    expect(emoji.length).toBeLessThan(LABEL_VALUE_MAX_BYTES);
    expect(labelValueByteLength(emoji)).toBeGreaterThan(LABEL_VALUE_MAX_BYTES);
    expect(isValidLabelValue(emoji)).toBe(false);
  });
});

describe("validateLabelWrite", () => {
  it("returns null for a well-formed flag and a well-formed valued label", () => {
    expect(validateLabelWrite({ key: "needs-review", value: "" })).toBeNull();
    expect(validateLabelWrite({ key: "quality", value: "high" })).toBeNull();
  });

  it("names the offending key when the key is malformed", () => {
    const err = validateLabelWrite({ key: "Needs Review", value: "" });
    expect(err).toContain("Needs Review");
  });

  it("reports the actual byte count when the value is too long", () => {
    const err = validateLabelWrite({ key: "ocr", value: "a".repeat(200) });
    expect(err).toContain("200 bytes");
    expect(err).toContain(String(LABEL_VALUE_MAX_BYTES));
  });
});

describe("label ref wire form", () => {
  it("round-trips appId and key", () => {
    const ref = { appId: "alpha", key: "ocr-available" };
    expect(formatLabelRef(ref)).toBe("alpha/ocr-available");
    expect(parseLabelRef("alpha/ocr-available")).toEqual(ref);
  });

  it("rejects malformed refs", () => {
    for (const ref of ["ocr-available", "/ocr", "alpha/", "", "alpha"]) {
      expect(parseLabelRef(ref), ref).toBeNull();
    }
  });

  it("rejects a ref whose key half is not a valid key", () => {
    // Splitting on the first slash means "alpha/a/b" yields key "a/b", which
    // is not a valid key — so it fails rather than being reinterpreted as
    // appId "alpha", key "a" with a stray suffix.
    expect(parseLabelRef("alpha/a/b")).toBeNull();
    expect(parseLabelRef("alpha/Needs Review")).toBeNull();
  });
});

describe("planLabelWrites", () => {
  const base = {
    recordTypes: new Map([["rec1", "image/jpeg"], ["rec2", "image/png"]]),
    declaredKeys: new Set(["ocr-available", "quality"]),
    canReadType: (t: string) => t === "image/jpeg",
  };

  it("plans a flag and a valued write, filling in the denormalized record type", () => {
    const plan = planLabelWrites({
      ...base,
      entries: [
        { recordId: "rec1" as never, key: "ocr-available" },
        { recordId: "rec1" as never, key: "quality", value: "high" },
      ],
    });
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.writes).toEqual([
      { recordId: "rec1", key: "ocr-available", value: "", recordType: "image/jpeg" },
      { recordId: "rec1", key: "quality", value: "high", recordType: "image/jpeg" },
    ]);
  });

  it("rejects a key the manifest does not declare", () => {
    const plan = planLabelWrites({
      ...base,
      entries: [{ recordId: "rec1" as never, key: "undeclared" }],
    });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.status).toBe(400);
    expect(!plan.ok && plan.error).toContain("not declared");
  });

  it("rejects a write against a record that does not exist", () => {
    // Nothing backs record_id with a foreign key, so without this the write
    // would silently create an orphan.
    const plan = planLabelWrites({
      ...base,
      entries: [{ recordId: "nope" as never, key: "quality", value: "high" }],
    });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toContain("does not exist");
  });

  it("allows a write with only a READ grant on the type", () => {
    // The central authorization decision: requiring readwrite would force an
    // OCR service to hold destructive power over photos it only reads.
    const plan = planLabelWrites({
      ...base,
      canReadType: (t) => t === "image/jpeg", // read-only; no write notion here at all
      entries: [{ recordId: "rec1" as never, key: "ocr-available" }],
    });
    expect(plan.ok).toBe(true);
  });

  it("403s a write against a type the caller cannot read", () => {
    const plan = planLabelWrites({
      ...base,
      entries: [{ recordId: "rec2" as never, key: "quality", value: "high" }],
    });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.status).toBe(403);
  });

  it("rejects the whole batch on one bad entry rather than partially applying", () => {
    const plan = planLabelWrites({
      ...base,
      entries: [
        { recordId: "rec1" as never, key: "quality", value: "high" },
        { recordId: "rec1" as never, key: "Bad Key" },
      ],
    });
    expect(plan.ok).toBe(false);
  });
});

describe("dedupeLabelWrites", () => {
  // Not a tidiness measure. A multi-row INSERT … ON CONFLICT DO UPDATE that
  // touches one row twice is an ERROR on Postgres/DSQL (21000) and silently
  // last-wins on SQLite, so an undeduped batch is one that passes every
  // offline test and 500s against the cloud.
  it("keeps the last write for a repeated (recordId, key, value)", () => {
    const deduped = dedupeLabelWrites([
      { recordId: "rec1" as never, key: "quality", value: "high" },
      { recordId: "rec1" as never, key: "quality", value: "high" },
    ]);
    expect(deduped).toEqual([{ recordId: "rec1", key: "quality", value: "high" }]);
  });

  // The whole point of the set-valued primary key: two values of one key are two
  // rows. Deduping these together would silently turn every multi-valued write
  // into a single-valued one, with no error and plausible-looking output.
  it("does NOT collapse two values of the same key on one record", () => {
    const deduped = dedupeLabelWrites([
      { recordId: "rec1" as never, key: "faces", value: "Alice" },
      { recordId: "rec1" as never, key: "faces", value: "Bob" },
    ]);
    expect(deduped).toHaveLength(2);
  });

  // A single-character separator would let ("a b","c") and ("a","b c") collide.
  it("does not collide on values containing the separator", () => {
    const deduped = dedupeLabelWrites([
      { recordId: "rec1" as never, key: "k", value: "a b" },
      { recordId: "rec1" as never, key: "k", value: "a" },
    ]);
    expect(deduped).toHaveLength(2);
  });

  // Omitted value is the bare flag, i.e. "" — and must not merge with a real
  // value that happens to be adjacent in the tuple encoding.
  it("treats an omitted value as distinct from a valued write", () => {
    const deduped = dedupeLabelWrites([
      { recordId: "rec1" as never, key: "k" },
      { recordId: "rec1" as never, key: "k", value: "v" },
    ]);
    expect(deduped).toHaveLength(2);
  });

  it("does not collapse the same key on different records, or different keys", () => {
    const entries = [
      { recordId: "rec1" as never, key: "quality" },
      { recordId: "rec2" as never, key: "quality" },
      { recordId: "rec1" as never, key: "other" },
    ];
    expect(dedupeLabelWrites(entries)).toHaveLength(3);
  });

  it("preserves first-appearance order so a batch stays predictable", () => {
    const deduped = dedupeLabelWrites([
      { recordId: "a" as never, key: "k", value: "1" },
      { recordId: "b" as never, key: "k", value: "2" },
      { recordId: "a" as never, key: "k", value: "1" },
    ]);
    expect(deduped.map((e) => e.recordId)).toEqual(["a", "b"]);
  });
});

describe("planLabelWrites deduping", () => {
  const base = {
    recordTypes: new Map([["rec1", "image/jpeg"]]),
    declaredKeys: new Set(["quality", "bad"]),
    canReadType: () => true,
  };

  // Two values of one key are two rows, not a last-wins overwrite. An app that
  // means "replace" says so explicitly — see the replace-mode write path — because
  // nothing here can tell a single-valued key from a set-valued one.
  it("emits one write per (record, key, value)", () => {
    const plan = planLabelWrites({
      ...base,
      entries: [
        { recordId: "rec1" as never, key: "quality", value: "high" },
        { recordId: "rec1" as never, key: "quality", value: "low" },
      ],
    });
    expect(plan.ok && plan.writes).toEqual([
      { recordId: "rec1", key: "quality", value: "high", recordType: "image/jpeg" },
      { recordId: "rec1", key: "quality", value: "low", recordType: "image/jpeg" },
    ]);
  });

  it("rejects more than LABEL_VALUES_PER_KEY_MAX values for one key on one record", () => {
    const plan = planLabelWrites({
      ...base,
      entries: Array.from({ length: LABEL_VALUES_PER_KEY_MAX + 1 }, (_, i) => ({
        recordId: "rec1" as never,
        key: "quality",
        value: `v${i}`,
      })),
    });
    expect(plan.ok).toBe(false);
  });

  it("does not charge a repeated row twice against the value cap", () => {
    const plan = planLabelWrites({
      ...base,
      entries: Array.from({ length: LABEL_VALUES_PER_KEY_MAX + 5 }, () => ({
        recordId: "rec1" as never,
        key: "quality",
        value: "same",
      })),
    });
    expect(plan.ok).toBe(true);
  });

  it("counts stored values against the cap, not just the batch's", () => {
    // A cap that only saw the batch would be cleared by sending 32 values
    // thirty times — which is exactly the smuggling channel it exists to close,
    // and it would pass every test that only ever writes one batch.
    const existingValues = new Map([
      [
        labelValueSetKey("rec1" as never, "quality"),
        new Set(Array.from({ length: LABEL_VALUES_PER_KEY_MAX - 1 }, (_, i) => `stored${i}`)),
      ],
    ]);
    const oneMore = (values: string[]) =>
      planLabelWrites({
        ...base,
        existingValues,
        entries: values.map((value) => ({
          recordId: "rec1" as never,
          key: "quality",
          value,
        })),
      });

    // 31 stored + 1 new = 32, exactly at the cap.
    expect(oneMore(["new"]).ok).toBe(true);
    // 31 stored + 2 new = 33, over it.
    expect(oneMore(["new", "newer"]).ok).toBe(false);
    // Re-writing a value already stored takes no new slot: a slot is a value,
    // not a write, so an idempotent re-run of a full batch must not fail.
    expect(oneMore(["stored0", "stored1"]).ok).toBe(true);
  });

  it("counts each key separately, and each record separately", () => {
    const plan = planLabelWrites({
      ...base,
      recordTypes: new Map([
        ["rec1", "image/jpeg"],
        ["rec2", "image/jpeg"],
      ]),
      entries: [
        ...Array.from({ length: LABEL_VALUES_PER_KEY_MAX }, (_, i) => ({
          recordId: "rec1" as never,
          key: "quality",
          value: `v${i}`,
        })),
        ...Array.from({ length: LABEL_VALUES_PER_KEY_MAX }, (_, i) => ({
          recordId: "rec1" as never,
          key: "bad",
          value: `v${i}`,
        })),
        ...Array.from({ length: LABEL_VALUES_PER_KEY_MAX }, (_, i) => ({
          recordId: "rec2" as never,
          key: "quality",
          value: `v${i}`,
        })),
      ],
    });
    expect(plan.ok).toBe(true);
  });

  it("still validates every entry before deduping", () => {
    // The repeat must not be a way to smuggle a bad entry past validation by
    // having it collapsed away.
    const plan = planLabelWrites({
      ...base,
      entries: [
        { recordId: "rec1" as never, key: "quality", value: "high" },
        { recordId: "rec1" as never, key: "quality", value: "x".repeat(200) },
      ],
    });
    expect(plan.ok).toBe(false);
  });
});

describe("planLabelRetractions", () => {
  it("accepts a retraction whose key is no longer declared", () => {
    // An uninstall or a key-dropping upgrade revokes the declaration while the
    // rows survive. Validating the key here would strand an app's own rows
    // permanently out of its reach — the bug the obvious implementation has.
    const plan = planLabelRetractions([{ recordId: "rec1" as never, key: "long-gone" }]);
    expect(plan.ok).toBe(true);
  });

  it("accepts a retraction against a record that no longer exists", () => {
    const plan = planLabelRetractions([{ recordId: "deleted" as never, key: "k" }]);
    expect(plan.ok).toBe(true);
  });

  it("still rejects a structurally invalid key", () => {
    const plan = planLabelRetractions([{ recordId: "rec1" as never, key: "Bad Key" }]);
    expect(plan.ok).toBe(false);
  });
});
