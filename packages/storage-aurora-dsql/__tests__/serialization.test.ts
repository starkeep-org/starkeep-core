import { describe, it, expect } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  createStarkeepId,
  serializeHLC,
  type DataRecord,
} from "@starkeep/protocol-primitives";
import { recordToRow, rowToRecord, columnsToMetadataRow } from "../src/serialization.js";

function sampleRecord(over: Partial<DataRecord> = {}): DataRecord {
  const clock = createHLCClock({ nodeId: "node-a" });
  const record = createDataRecord(
    {
      type: "jpg",
      originAppId: "photos",
      contentHash: "sha256:abc123",
      objectStorageKey: "shared/jpg/ab/abc123",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      originalFilename: "cat.jpg",
    },
    clock,
  );
  return { ...record, ...over };
}

describe("record ↔ row serialization", () => {
  it("round-trips a live record exactly", () => {
    const record = sampleRecord();
    expect(rowToRecord(recordToRow(record))).toEqual(record);
  });

  it("round-trips a tombstoned record with parentId", () => {
    const clock = createHLCClock({ nodeId: "node-a" });
    const record = sampleRecord({
      deletedAt: clock.now(),
      parentId: createStarkeepId("0123456789abcdefghjkmnpqrs"),
    });
    expect(rowToRecord(recordToRow(record))).toEqual(record);
  });

  it("serializes HLC timestamps as sortable strings and null deletions as NULL", () => {
    const record = sampleRecord();
    const row = recordToRow(record);
    expect(row.updated_at).toBe(serializeHLC(record.updatedAt));
    expect(row.deleted_at).toBeNull();
    expect(row.origin_app_id).toBe("photos");
    expect(row.parent_id).toBeNull();
  });
});

describe("columnsToMetadataRow", () => {
  it("copies columns and drops the redundant record_id key", () => {
    const id = createStarkeepId("0123456789abcdefghjkmnpqrs");
    const row = columnsToMetadataRow(id, {
      record_id: "should-be-dropped",
      width: 800,
      height: 600,
      exif_taken_at: null,
    });
    expect(row).toEqual({ recordId: id, width: 800, height: 600, exif_taken_at: null });
  });
});
