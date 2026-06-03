import { describe, it, expect } from "vitest";
import { createHLCClock } from "../src/hlc/clock.js";
import { createDataRecord } from "../src/records/builders.js";

describe("createDataRecord", () => {
  const clock = createHLCClock({ nodeId: "test-node", wallClockFunction: () => 1000 });

  const baseInput = {
    type: "@test/photo",
    ownerId: "user-1",
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
    expect(record.ownerId).toBe("user-1");
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

  it("generates unique IDs for each record", () => {
    const r1 = createDataRecord(baseInput, clock);
    const r2 = createDataRecord(baseInput, clock);
    expect(r1.id).not.toBe(r2.id);
  });
});
