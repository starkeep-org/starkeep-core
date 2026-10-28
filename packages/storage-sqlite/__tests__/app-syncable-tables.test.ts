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
});
