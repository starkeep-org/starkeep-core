import { describe, it, expect } from "vitest";
import { createHLCClock } from "../src/hlc/clock.js";
import { createDataRecord } from "../src/records/builders.js";
import { MAX_RECORD_ID_FILTER, parseRecordIdFilter } from "../src/records/id-filter.js";

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

  it("matches createdAt and updatedAt on initial create", () => {
    const record = createDataRecord(baseInput, clock);
    expect(record.createdAt).toEqual(record.updatedAt);
  });

  it("gives one id to one file, and different ids to different files", () => {
    // Ids are content-addressed, so "unique per call" is exactly what this must
    // not be: two calls describing one file are one record, which is what lets
    // two nodes produce it independently without colliding. Uniqueness is over
    // files rather than over calls. See `identifiers/content-id.ts`.
    expect(createDataRecord(baseInput, clock).id).toBe(
      createDataRecord(baseInput, clock).id,
    );
    expect(
      createDataRecord({ ...baseInput, originalFilename: "sunrise.jpg" }, clock).id,
    ).not.toBe(createDataRecord(baseInput, clock).id);
  });
});

describe("parseRecordIdFilter", () => {
  it("deduplicates and sorts IDs", () => {
    expect(parseRecordIdFilter("b,a,b")).toEqual({ ok: true, ids: ["a", "b"] });
  });

  it("rejects malformed and oversized filters", () => {
    expect(parseRecordIdFilter("a,,b")).toMatchObject({ ok: false });
    expect(
      parseRecordIdFilter(
        Array.from({ length: MAX_RECORD_ID_FILTER + 1 }, (_, index) => `id-${index}`).join(","),
      ),
    ).toMatchObject({ ok: false });
  });
});

// Note there is no successor to the old `labelHasValidPrefix` squatting test.
// `appId` is a server-set column rather than a string prefix, so there is no
// request that can express another app's namespace — the attack it guarded
// against is unrepresentable rather than rejected.
