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
    const row = columnsToMetadataRow(id, "image/jpeg", {
      record_id: "should-be-dropped",
      width: 800,
      height: 600,
      color_space: null,
    });
    expect(row).toEqual({ recordId: id, width: 800, height: 600, color_space: null });
  });

  // The defect this exists for: Postgres renders a `timestamp` as
  // `YYYY-MM-DD HH:MM:SS`, which `new Date` reads as *local* time. A row that
  // leaves this function unconverted moves every capture time in the library by
  // the reader's UTC offset.
  it("puts a timestamp column back into canonical UTC", () => {
    const id = createStarkeepId("0123456789abcdefghjkmnpqrs");
    const row = columnsToMetadataRow(id, "image/jpeg", {
      record_id: id,
      captured_at: "2026-08-30 19:17:55",
    });
    expect(row.captured_at).toBe("2026-08-30T19:17:55.000Z");
  });

  it("leaves a null timestamp null and an already-canonical one untouched", () => {
    const id = createStarkeepId("0123456789abcdefghjkmnpqrs");
    const row = columnsToMetadataRow(id, "image/jpeg", {
      record_id: id,
      captured_at: null,
    });
    expect(row.captured_at).toBeNull();
    const canonical = columnsToMetadataRow(id, "image/jpeg", {
      record_id: id,
      captured_at: "2026-08-30T19:17:55.000Z",
    });
    expect(canonical.captured_at).toBe("2026-08-30T19:17:55.000Z");
  });

  // `bigint` is `int8`, which node-postgres hands over as a string to keep
  // precision. SQLite returns a number for the same column, and an app row
  // carries whatever it got onto the sync wire verbatim.
  it("turns a bigint column back into a number", () => {
    const id = createStarkeepId("0123456789abcdefghjkmnpqrs");
    const row = columnsToMetadataRow(id, "video/mp4", {
      record_id: id,
      duration_ms: "185000",
    });
    expect(row.duration_ms).toBe(185000);
  });
});
