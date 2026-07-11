import { describe, it, expect } from "vitest";
import { createHLCClock } from "../src/hlc/clock.js";
import { createDataRecord } from "../src/records/builders.js";
import { labelHasValidPrefix } from "../src/records/label.js";

describe("createDataRecord", () => {
  const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });

  const baseInput = {
    type: "@test/photo",
    originAppId: "test",
    contentHash: "sha256:abc123",
    objectStorageKey: "shared/@test/photo/ab/sha256:abc123",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
  };

  it("populates the file-backed record fields", () => {
    const record = createDataRecord(
      { ...baseInput, originalFilename: "sunset.jpg" },
      clock,
    );

    expect(record.kind).toBe("data");
    expect(record.type).toBe("@test/photo");
    expect(record.id).toHaveLength(26);
    expect(record.version).toBe(1);
    expect(record.deletedAt).toBeNull();
    expect(record.contentHash).toBe("sha256:abc123");
    expect(record.objectStorageKey).toBe("shared/@test/photo/ab/sha256:abc123");
    expect(record.mimeType).toBe("image/jpeg");
    expect(record.sizeBytes).toBe(1024);
    expect(record.originalFilename).toBe("sunset.jpg");
    expect(record.parentId).toBeNull();
  });

  it("defaults label to null and passes a supplied label through", () => {
    expect(createDataRecord(baseInput, clock).label).toBeNull();
    expect(
      createDataRecord({ ...baseInput, label: "photos/thumbnail" }, clock).label,
    ).toBe("photos/thumbnail");
  });

  it("matches createdAt and updatedAt on initial create", () => {
    const record = createDataRecord(baseInput, clock);
    expect(record.createdAt).toEqual(record.updatedAt);
  });

  it("generates unique IDs for each record", () => {
    const r1 = createDataRecord(baseInput, clock);
    const r2 = createDataRecord(baseInput, clock);
    expect(r1.id).not.toBe(r2.id);
  });
});

describe("labelHasValidPrefix", () => {
  it("accepts a well-formed label owned by the app", () => {
    expect(labelHasValidPrefix("photos/thumbnail", "photos")).toBe(true);
    // Purpose segment may itself contain slashes.
    expect(labelHasValidPrefix("photos/derived/thumbnail", "photos")).toBe(true);
  });

  it("rejects a label whose prefix is another app (namespace squatting)", () => {
    expect(labelHasValidPrefix("photos/thumbnail", "notes")).toBe(false);
  });

  it("rejects malformed labels (no slash, empty prefix, empty purpose)", () => {
    expect(labelHasValidPrefix("thumbnail", "photos")).toBe(false);
    expect(labelHasValidPrefix("/thumbnail", "photos")).toBe(false);
    expect(labelHasValidPrefix("photos/", "photos")).toBe(false);
    expect(labelHasValidPrefix("", "photos")).toBe(false);
  });
});
