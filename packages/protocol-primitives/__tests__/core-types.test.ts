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
  getCategory,
  pgMetadataDdl,
  sqliteMetadataDdl,
  sqliteMetadataTableName,
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

describe("camera raw types (media plan item 29)", () => {
  // This was a live bug, not a missing feature. `.dng` fell through to
  // `other/other`, which is Drive-only and ungrantable to installable apps —
  // so ProRAW files synced fine and no app could ever be granted them. Photos
  // simply could not see them.
  it("maps every raw extension to a real image type, not the catch-all", () => {
    for (const ext of ["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"]) {
      const typeId = defaultTypeForExtension(ext);
      expect(typeId, ext).not.toBe(OTHER_TYPE_ID);
      expect(typeCategory(typeId), ext).toBe("image");
    }
  });

  it("makes them grantable to installable apps", () => {
    // The actual fix. `other` is excluded from APP_GRANTABLE_CATEGORIES, which
    // is why the old behaviour made these files unreachable.
    for (const ext of ["dng", "cr2", "nef"]) {
      const category = typeCategory(defaultTypeForExtension(ext));
      expect(APP_GRANTABLE_CATEGORIES).toContain(category);
    }
  });

  it("registers each maker's format separately", () => {
    // Not one shared `image/raw`: the embedded-preview layout derivation reads
    // differs per vendor, and a single type would leave nothing to branch on.
    // Grants are per category, so an app granted `image` still gets all of them.
    const ids = new Set(
      ["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"].map(defaultTypeForExtension),
    );
    expect(ids.size).toBe(8);
    for (const id of ids) expect(isKnownType(id)).toBe(true);
  });

  it("routes them to the image metadata table like any other image", () => {
    expect(sqliteMetadataTableName(defaultTypeForExtension("dng"))).toBe(
      "shared_record_image_metadata",
    );
  });
});

describe("derived-from-bytes metadata columns (media plan items 4 / 21)", () => {
  const imageColumns = getCategory("image")!.metadataColumns.map((c) => c.name);

  // These are metadata rather than labels because they are deterministic from
  // the bytes: a label is an app's *assertion* about a record, and anyone
  // re-deriving from the same file reproduces these exactly.
  it("carries perceptual_hash and thumb_hash on images", () => {
    expect(imageColumns).toContain("perceptual_hash");
    expect(imageColumns).toContain("thumb_hash");
  });

  // A grid mixing stills and clips must not have a hole where one kind of
  // placeholder should be.
  it("carries thumb_hash on videos too", () => {
    expect(getCategory("video")!.metadataColumns.map((c) => c.name)).toContain("thumb_hash");
  });

  // perceptual_hash matches re-encodes and resizes, which is what makes it
  // useful for import dedup and what makes it unsafe as an identity. Keeping
  // content_hash on the record row and this in metadata is the distinction:
  // one decides, the other only proposes candidates.
  it("does not displace content_hash, which is the identity", () => {
    expect(imageColumns).not.toContain("content_hash");
  });

  it("emits both in the generated DDL for both backends", () => {
    const image = getCategory("image")!;
    for (const ddl of [pgMetadataDdl(image), sqliteMetadataDdl(image)]) {
      expect(ddl).toContain("perceptual_hash");
      expect(ddl).toContain("thumb_hash");
    }
  });
});
