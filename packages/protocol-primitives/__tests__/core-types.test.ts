import { describe, it, expect } from "vitest";
import {
  checkMetadataValues,
  pgColumnType,
  sqliteColumnType,
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

describe("checkMetadataValues", () => {
  it("accepts a canonical timestamp", () => {
    expect(checkMetadataValues("image", { captured_at: "2026-09-01T12:34:56.789Z" }))
      .toEqual({ ok: true });
  });

  it("accepts null, which means the value was never derived", () => {
    expect(checkMetadataValues("image", { captured_at: null })).toEqual({ ok: true });
  });

  it("rejects a zoneless timestamp, which is what parseExifDate can emit", () => {
    // Photos' `parseExifDate` string branch returns `YYYY-MM-DDTHH:MM:SS`. The
    // physical column silently accepts it, so this is the only gate.
    const result = checkMetadataValues("image", { captured_at: "2026-09-01T12:34:56" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-UTC offset, which Postgres would silently truncate", () => {
    // `+05:00` denotes 19:00 UTC the previous day; a naive column stores the
    // 00:00 and loses the offset with no error at all.
    const result = checkMetadataValues("image", { captured_at: "2026-09-01T00:00:00.000+05:00" });
    expect(result.ok).toBe(false);
  });

  it("rejects a timestamp with no milliseconds, because ordering is lexical", () => {
    // `...T00:00:00Z` and `...T00:00:00.000Z` are the same instant and sort
    // apart, so only one spelling can be legal.
    expect(checkMetadataValues("image", { captured_at: "2026-09-01T00:00:00Z" }).ok).toBe(false);
  });

  it("still rejects an undeclared column", () => {
    const result = checkMetadataValues("image", { not_a_column: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not_a_column");
  });

  it("leaves non-timestamp columns alone", () => {
    // Deliberately narrow: widening to every declared type would reject writes
    // that succeed today. See the note on checkMetadataValues.
    expect(checkMetadataValues("image", { width: "1024" })).toEqual({ ok: true });
  });
});

describe("physical column types", () => {
  it("maps real to double precision, never Postgres real", () => {
    // Postgres `real` is float4 and rounds 37.774929496 to 37.77493, while
    // SQLite's REAL is always 8-byte IEEE.
    expect(pgColumnType("real")).toBe("double precision");
    expect(sqliteColumnType("real")).toBe("REAL");
  });

  it("maps timestamp to a zoneless type on both engines", () => {
    // Everything persisted is UTC and no column carries a zone.
    expect(pgColumnType("timestamp")).toBe("timestamp");
    expect(sqliteColumnType("timestamp")).toBe("TEXT");
  });
});
