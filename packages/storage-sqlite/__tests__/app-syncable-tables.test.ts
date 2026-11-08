/**
 * An app's syncable tables, created from its manifest's `appSpecificSyncable`
 * block on any SQLite database. The desktop's local installer and Photos
 * Mobile both call this code, so the tables a phone syncs into are the ones a
 * desktop syncs into. Photos' fixture manifest is the input, because Photos
 * Mobile is the node that depends on this.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { serializeHLC } from "@starkeep/protocol-primitives";
import { fileURLToPath } from "node:url";
import { initializeLocalSchema } from "../src/schema/bootstrap.js";
import {
  SqliteAppSyncableNamespaceStore,
  appSyncableTableName,
} from "../src/app-syncable/namespace.js";
import { SqliteAppSyncableApplier } from "../src/app-syncable/apply.js";
import {
  registerAppSyncableNamespace,
  type AppSyncableDeclaration,
} from "../src/app-syncable/tables.js";

const photosSyncable = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../admin-manifest/__tests__/fixtures/photos.manifest.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { infraRequirements: { appSpecificSyncable: AppSyncableDeclaration } }
).infraRequirements.appSpecificSyncable;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initializeLocalSchema(db);
  return db;
}

describe("registerAppSyncableNamespace", () => {
  it("creates Photos' tables and registers them, with the reserved file table", () => {
    const db = freshDb();
    registerAppSyncableNamespace(db, "photos", photosSyncable);

    const ns = new SqliteAppSyncableNamespaceStore(db).get("photos");
    expect(ns?.tableNames).toEqual(["image_enriched", "_starkeep_sync_records"]);
    expect(ns?.filesEnabled).toBe(true);
    const enriched = ns!.tables.find((t) => t.name === "image_enriched")!;
    expect(enriched.pkColumns).toEqual(["record_id"]);
    expect(enriched.columns?.map((c) => c.name)).toEqual([
      "record_id",
      "caption",
      "title",
      "date_taken_override",
      "updated_at",
      "node_id",
      "deleted_at",
    ]);
  });

  it("is idempotent, so a node may run it on every start", () => {
    const db = freshDb();
    registerAppSyncableNamespace(db, "photos", photosSyncable);
    registerAppSyncableNamespace(db, "photos", photosSyncable);
    expect(new SqliteAppSyncableNamespaceStore(db).list()).toHaveLength(1);
  });

  it("creates tables the applier writes into and a reader reads back", () => {
    const db = freshDb();
    registerAppSyncableNamespace(db, "photos", photosSyncable);
    const applier = new SqliteAppSyncableApplier(db, new SqliteAppSyncableNamespaceStore(db));
    applier.apply({
      timestamp: { wallTime: 1_000, counter: 0, nodeId: "desktop" },
      appId: "photos",
      table: "image_enriched",
      op: "insert",
      row: {
        record_id: "r1",
        caption: "A cat",
        title: "Cat",
        date_taken_override: null,
        updated_at: serializeHLC({ wallTime: 1_000, counter: 0, nodeId: "desktop" }),
        deleted_at: null,
      },
    });
    const rows = db
      .prepare(
        `SELECT record_id, caption, title, node_id FROM ${appSyncableTableName("photos", "image_enriched")}`,
      )
      .all();
    expect(rows).toEqual([{ record_id: "r1", caption: "A cat", title: "Cat", node_id: "desktop" }]);
  });

  it("refuses a file-index row whose created_at is not a serialized HLC", () => {
    const db = freshDb();
    registerAppSyncableNamespace(db, "photos", photosSyncable);
    const applier = new SqliteAppSyncableApplier(db, new SqliteAppSyncableNamespaceStore(db));
    const ts = { wallTime: 1_000, counter: 0, nodeId: "phone" };
    const fileRow = (id: string, createdAt: string) => ({
      timestamp: ts,
      appId: "photos",
      table: "_starkeep_sync_records",
      op: "insert" as const,
      row: {
        id,
        object_storage_key: id,
        content_hash: "a".repeat(64),
        mime_type: "image/jpeg",
        size_bytes: 3,
        original_filename: null,
        origin_app_id: "photos",
        created_at: createdAt,
        updated_at: serializeHLC(ts),
        deleted_at: null,
      },
    });
    // An ISO instant holds two colons, so a split on `:` alone would read it
    // as a moment in 1970. The applier refuses it before anything is written.
    expect(() => applier.apply(fileRow("iso.jpg", "2026-10-27T00:00:00.000Z"))).toThrow(
      'File index row iso.jpg has created_at "2026-10-27T00:00:00.000Z", not a serialized HLC',
    );
    applier.apply(fileRow("hlc.jpg", serializeHLC(ts)));
    const ids = db
      .prepare(`SELECT id FROM ${appSyncableTableName("photos", "_starkeep_sync_records")}`)
      .all();
    expect(ids).toEqual([{ id: "hlc.jpg" }]);
  });
});
