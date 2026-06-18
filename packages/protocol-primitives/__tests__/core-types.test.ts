import { describe, it, expect } from "vitest";
import {
  TYPES,
  TYPE_IDS,
  EXTENSIONS,
  OTHER_TYPE_ID,
  CATEGORY_IDS,
  APP_GRANTABLE_CATEGORIES,
  isKnownType,
  getType,
  typeCategory,
  defaultTypeForExtension,
} from "../src/types/core-types.js";

describe("TYPES registry", () => {
  it("every type id is `<category>/<format>` with a real category prefix", () => {
    for (const t of TYPES) {
      expect(t.id).toBe(`${t.category}/${t.format}`);
      expect(CATEGORY_IDS).toContain(t.category);
      expect(typeCategory(t.id)).toBe(t.category);
    }
  });

  it("type ids are unique", () => {
    expect(TYPE_IDS.size).toBe(TYPES.length);
  });

  it("includes the terminal other/other type, which is not app-grantable", () => {
    expect(isKnownType(OTHER_TYPE_ID)).toBe(true);
    expect(typeCategory(OTHER_TYPE_ID)).toBe("other");
    expect(APP_GRANTABLE_CATEGORIES).not.toContain("other");
  });
});

describe("isKnownType", () => {
  it("accepts registered types and rejects unknown / malformed ids", () => {
    expect(isKnownType("image/jpeg")).toBe(true);
    expect(isKnownType("archive/zip")).toBe(true);
    expect(isKnownType("image/bogus")).toBe(false);
    expect(isKnownType("jpg")).toBe(false); // bare extension is not a type
    expect(isKnownType("image")).toBe(false); // bare category is not a type
  });
});

describe("typeCategory", () => {
  it("returns the prefix for type ids and bare category ids alike", () => {
    expect(typeCategory("image/jpeg")).toBe("image");
    expect(typeCategory("document/markdown")).toBe("document");
    expect(typeCategory("image")).toBe("image"); // bare category passes through
  });

  it("falls back to other for unprefixed / unknown ids", () => {
    expect(typeCategory("jpg")).toBe("other");
    expect(typeCategory("")).toBe("other");
    expect(typeCategory("nope/whatever")).toBe("other");
  });
});

describe("defaultTypeForExtension (advisory)", () => {
  it("maps extensions to their canonical type, collapsing aliases", () => {
    // jpg and jpeg collapse to one canonical type.
    expect(defaultTypeForExtension("jpg")).toBe("image/jpeg");
    expect(defaultTypeForExtension("jpeg")).toBe("image/jpeg");
    expect(defaultTypeForExtension("tif")).toBe("image/tiff");
    expect(defaultTypeForExtension("tiff")).toBe("image/tiff");
    expect(defaultTypeForExtension("yml")).toBe("text/yaml");
    expect(defaultTypeForExtension("yaml")).toBe("text/yaml");
    expect(defaultTypeForExtension("md")).toBe("document/markdown");
  });

  it("normalizes case and a leading dot", () => {
    expect(defaultTypeForExtension(".JPG")).toBe("image/jpeg");
    expect(defaultTypeForExtension("PNG")).toBe("image/png");
  });

  it("maps unmapped / empty extensions to other/other", () => {
    expect(defaultTypeForExtension("xyz")).toBe(OTHER_TYPE_ID);
    expect(defaultTypeForExtension("")).toBe(OTHER_TYPE_ID);
  });
});

describe("EXTENSIONS advisory map", () => {
  it("every advisory extension points at a registered type", () => {
    for (const typeId of Object.values(EXTENSIONS)) {
      expect(isKnownType(typeId)).toBe(true);
    }
  });

  it("getType round-trips a known id", () => {
    expect(getType("image/jpeg")).toEqual({ id: "image/jpeg", category: "image", format: "jpeg" });
    expect(getType("image/bogus")).toBeUndefined();
  });
});
