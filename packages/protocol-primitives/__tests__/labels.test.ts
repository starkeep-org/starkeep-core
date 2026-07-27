import { describe, it, expect } from "vitest";
import {
  LABEL_VALUE_MAX_BYTES,
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
  it("accepts null — a bare flag is a first-class label", () => {
    expect(isValidLabelValue(null)).toBe(true);
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
    expect(validateLabelWrite({ key: "needs-review", value: null })).toBeNull();
    expect(validateLabelWrite({ key: "quality", value: "high" })).toBeNull();
  });

  it("names the offending key when the key is malformed", () => {
    const err = validateLabelWrite({ key: "Needs Review", value: null });
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
