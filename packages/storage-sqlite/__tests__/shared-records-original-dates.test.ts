/**
 * The source file's own dates on `shared_records`: a fresh table declares
 * them, the temporary guard adds them to a table created before them, and a
 * record round-trips them through the adapter's serialization.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeLocalSchema } from "../src/schema/bootstrap.js";
import { recordToRow, rowToRecord } from "../src/serialization.js";
import { createDataRecord, createHLCClock } from "@starkeep/protocol-primitives";

const DATE_COLUMNS = ["original_created_at", "original_updated_at"];

function columns(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM pragma_table_info('shared_records')").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

/** `shared_records` as it was before the date columns, with one row. */
function oldRecords(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE shared_records (
    id text PRIMARY KEY,
    type text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    node_id text NOT NULL,
    deleted_at text,
    version integer NOT NULL DEFAULT 1,
    content_hash text NOT NULL,
    object_storage_key text NOT NULL,
    mime_type text,
    size_bytes integer NOT NULL,
    original_filename text,
    origin_app_id text NOT NULL,
    parent_id text,
    stand_in_role text CHECK (stand_in_role IN ('canonical', 'smaller')),
    fidelity integer,
    canonical_threshold integer,
    self_canonical integer,
    stand_in_slot text
  )`);
  db.prepare(
    `INSERT INTO shared_records (id, type, created_at, updated_at, node_id, content_hash,
       object_storage_key, size_bytes, origin_app_id)
     VALUES ('r1', 'image/jpeg', 'c', 'u', 'n', 'h', 'k', 3, 'photos')`,
  ).run();
  return db;
}

describe("shared_records original dates", () => {
  it("are created with a fresh table", () => {
    const db = new DatabaseSync(":memory:");
    initializeLocalSchema(db);
    expect(columns(db)).toEqual(expect.arrayContaining(DATE_COLUMNS));
  });

  it("are added to a table created without them, leaving its rows intact", () => {
    const db = oldRecords();
    initializeLocalSchema(db);
    expect(columns(db)).toEqual(expect.arrayContaining(DATE_COLUMNS));
    expect(db.prepare("SELECT * FROM shared_records").all()).toEqual([
      expect.objectContaining({
        id: "r1",
        size_bytes: 3,
        original_created_at: null,
        original_updated_at: null,
      }),
    ]);
  });

  it("runs twice as a no-op", () => {
    const db = oldRecords();
    initializeLocalSchema(db);
    initializeLocalSchema(db);
    for (const column of DATE_COLUMNS) {
      expect(columns(db).filter((c) => c === column)).toHaveLength(1);
    }
  });

  it("round-trip through a record's serialization", () => {
    const record = createDataRecord(
      {
        type: "image/jpeg",
        originAppId: "starkeep-drive",
        contentHash: "a".repeat(64),
        objectStorageKey: "k",
        sizeBytes: 3,
        originalFilename: "a.jpg",
        originalCreatedAt: "2020-01-01T00:00:00.000Z",
        originalUpdatedAt: "2020-01-02T03:04:05.000Z",
      },
      createHLCClock({ nodeId: "node-a" }),
    );
    const row = recordToRow(record);
    expect(row.original_created_at).toBe("2020-01-01T00:00:00.000Z");
    expect(row.original_updated_at).toBe("2020-01-02T03:04:05.000Z");
    const back = rowToRecord(row);
    expect(back.originalCreatedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(back.originalUpdatedAt).toBe("2020-01-02T03:04:05.000Z");
  });
});
