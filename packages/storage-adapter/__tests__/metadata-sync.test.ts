/**
 * The wire shaping either side of a metadata ride-along, tested directly.
 *
 * The round-trip behaviour lives in `sync-engine`'s own suite. What is pinned
 * here is the pair of rules everything there depends on: a null column never
 * goes on the wire, and a column the receiving build does not recognize never
 * reaches an INSERT.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createStarkeepId, type StarkeepId } from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter } from "../src/mock/mock-database-adapter.js";
import {
  applyRecordMetadata,
  deleteRecordMetadata,
  loadMetadataForRecords,
  restoreRecordMetadata,
} from "../src/database/metadata-sync.js";
import type { SoftDeletedScope } from "../src/database/app-query-types.js";

const PHOTO: StarkeepId = createStarkeepId("01AAAAAAAAAAAAAAAAAAAAAAAA");
const OTHER: StarkeepId = createStarkeepId("01BBBBBBBBBBBBBBBBBBBBBBBB");
const photo = { id: PHOTO, type: "image/jpeg" };
/** One deletion's clock reading, which is what a metadata tombstone carries. */
const DELETED_AT = { wallTime: 1_700_000_000_000, counter: 0, nodeId: "node-a" };

let db: MockDatabaseAdapter;

beforeEach(async () => {
  db = new MockDatabaseAdapter();
  await db.init();
});

describe("loadMetadataForRecords", () => {
  it("strips null columns, so absence on the wire means one thing", async () => {
    await db.putMetadata("image/jpeg", {
      recordId: PHOTO,
      width: 4032,
      height: null,
      thumb_hash: null,
    });

    const wire = (await loadMetadataForRecords(db, [photo])).get(PHOTO)!;

    expect(wire["width"]).toBe(4032);
    expect("height" in wire).toBe(false);
    expect("thumb_hash" in wire).toBe(false);
  });

  it("omits a record whose row holds nothing but nulls", async () => {
    await db.putMetadata("image/jpeg", { recordId: PHOTO, width: null });
    expect((await loadMetadataForRecords(db, [photo])).has(PHOTO)).toBe(false);
  });

  it("skips `other`, which has no metadata table", async () => {
    const loaded = await loadMetadataForRecords(db, [{ id: OTHER, type: "other/other" }]);
    expect(loaded.size).toBe(0);
  });

  it("sends a timestamp as an ISO string, so both transports write the same value", async () => {
    // Postgres hands back a `Date`; SQLite a string. JSON.stringify would
    // normalize one of those on an HTTP round and leave an in-process round
    // writing the other, so the conversion happens here instead.
    await db.putMetadata("image/jpeg", {
      recordId: PHOTO,
      captured_at: new Date("2026-01-02T03:04:05.000Z"),
    });
    const wire = (await loadMetadataForRecords(db, [photo])).get(PHOTO)!;
    expect(wire["captured_at"]).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("applyRecordMetadata", () => {
  it("merges the named columns and leaves the rest alone", async () => {
    await db.putMetadata("image/jpeg", { recordId: PHOTO, width: 4032, height: 3024 });

    await applyRecordMetadata(db, photo, { thumb_hash: "TH" }, { detectOwedBack: true });

    const row = (await db.getMetadata("image", PHOTO))!;
    expect(row["width"]).toBe(4032);
    expect(row["height"]).toBe(3024);
    expect(row["thumb_hash"]).toBe("TH");
  });

  it("derives record_type from the record, never from the wire", async () => {
    // Metadata is a sync passenger: it rides on the record, applied with the
    // record, with null columns stripped so a node knowing less cannot erase a
    // peer's columns. That per-column merge is right for a derived fact and
    // wrong for a grant discriminant — a peer supplying it would be asserting
    // who may read the row.
    await applyRecordMetadata(
      db,
      photo,
      { width: 4032, record_type: "image/svg" },
      { detectOwedBack: false },
    );
    const row = (await db.getMetadata("image", PHOTO))!;
    expect(row["record_type"]).toBe(photo.type);
    expect(row["width"]).toBe(4032);
  });

  it("drops a column the category does not declare", async () => {
    // A peer on a newer build may name a column this one has never heard of.
    // Letting it through would put an unknown identifier in an INSERT, which
    // throws — and a shared-record apply that throws aborts the whole exchange.
    await applyRecordMetadata(
      db,
      photo,
      { width: 4032, invented_column: 7 },
      { detectOwedBack: false },
    );

    const row = (await db.getMetadata("image", PHOTO))!;
    expect(row["width"]).toBe(4032);
    expect("invented_column" in row).toBe(false);
  });

  it("reports the sender as owed when this node holds a column the snapshot omits", async () => {
    await db.putMetadata("image/jpeg", { recordId: PHOTO, thumb_hash: "TH" });

    const owedBack = await applyRecordMetadata(
      db,
      photo,
      { width: 4032 },
      { detectOwedBack: true },
    );

    expect(owedBack).toBe(true);
  });

  it("reports nothing owed once the snapshot names everything held", async () => {
    await db.putMetadata("image/jpeg", { recordId: PHOTO, thumb_hash: "TH" });

    const owedBack = await applyRecordMetadata(
      db,
      photo,
      { width: 4032, thumb_hash: "TH" },
      { detectOwedBack: true },
    );

    // The reply to an owed-back re-ship names the union, so the same test is
    // false on both sides and the exchange settles. This is what stops the
    // conditional bump from becoming the unconditional one the design rules out.
    expect(owedBack).toBe(false);
  });

  it("reads nothing when the caller does not ask", async () => {
    await db.putMetadata("image/jpeg", { recordId: PHOTO, thumb_hash: "TH" });

    // A first sync arrives with thousands of records none of which this node
    // has seen, and a responder declines the question outright — see the note
    // on `applyRecordMetadata`. Both pass `false`, and neither pays the read.
    const owedBack = await applyRecordMetadata(
      db,
      photo,
      { width: 4032 },
      { detectOwedBack: false },
    );

    expect(owedBack).toBe(false);
  });

  it("ignores a payload that is not an object", async () => {
    for (const junk of ["nope", 7, null, [1, 2]]) {
      await applyRecordMetadata(db, photo, junk, { detectOwedBack: false });
    }
    expect(await db.getMetadata("image", PHOTO)).toBeNull();
  });
});

describe("deleteRecordMetadata", () => {
  it("tombstones the row, the way a local delete already cascades", async () => {
    await db.putMetadata("image/jpeg", { recordId: PHOTO, width: 4032 });
    await deleteRecordMetadata(db, photo, DELETED_AT);
    // The columns survive, which is the whole point: dimensions and a ThumbHash
    // are reported by an app over the bytes and the platform cannot re-derive
    // either, so destroying them here made a restore permanently incomplete.
    expect(await db.getMetadata("image", PHOTO)).toMatchObject({ recordId: PHOTO, width: 4032 });
    expect(await rowsVisibleTo("exclude")).toEqual([]);
    expect(await rowsVisibleTo("only")).toEqual([PHOTO]);
  });

  it("is lifted again by restoreRecordMetadata", async () => {
    await db.putMetadata("image/jpeg", { recordId: PHOTO, width: 4032 });
    await deleteRecordMetadata(db, photo, DELETED_AT);
    await restoreRecordMetadata(db, photo);
    expect(await rowsVisibleTo("exclude")).toEqual([PHOTO]);
    expect(await rowsVisibleTo("only")).toEqual([]);
  });

  it("is lifted by a fresh metadata write, so an app re-reporting is enough", async () => {
    await db.putMetadata("image/jpeg", { recordId: PHOTO, width: 4032 });
    await deleteRecordMetadata(db, photo, DELETED_AT);
    await db.putMetadata("image/jpeg", { recordId: PHOTO, thumb_hash: "TH" });
    expect(await rowsVisibleTo("exclude")).toEqual([PHOTO]);
  });
});

/** The record ids a metadata query returns on one side of the tombstone. */
async function rowsVisibleTo(softDeleted: SoftDeletedScope): Promise<string[]> {
  const result = await db.queryShared(
    { kind: "metadata", category: "image" },
    {
      mode: "rows",
      table: "record_image_metadata",
      select: ["record_id"],
      where: [],
      order: [],
      limit: 10,
      pageToken: null,
      include: [],
    },
    { softDeleted },
  );
  if (result.mode !== "rows") throw new Error("expected rows");
  return result.rows.map((r) => String(r["record_id"]));
}

describe("MockDatabaseAdapter.putMetadata", () => {
  it("upserts the supplied columns, matching both SQL adapters", async () => {
    // Both SQL adapters compile `ON CONFLICT DO UPDATE SET <supplied columns>`.
    // The mock replaced the whole row until this was fixed, which made it the
    // one backend where writing a partial row erased the rest — and the
    // metadata a sync round carries is deliberately partial.
    await db.putMetadata("image/jpeg", { recordId: PHOTO, width: 4032, height: 3024 });
    await db.putMetadata("image/jpeg", { recordId: PHOTO, thumb_hash: "TH" });

    const row = (await db.getMetadata("image", PHOTO))!;
    expect(row["width"]).toBe(4032);
    expect(row["thumb_hash"]).toBe("TH");
  });
});
