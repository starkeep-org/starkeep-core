/**
 * What `installLocal` actually creates, read back out of SQLite.
 *
 * The DSQL side has `dsql-ddl.test.ts`, which pins statement *shapes* against a
 * fake pool. This runs the real installer against a real (in-memory) database
 * and asks the schema what happened, which is the only way to catch the two
 * things that matter here and are invisible in a statement list: that the
 * declared index exists under the name both backends agree on, and that the
 * namespace registry row carries the column types the query parser reads.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeLocalSchema } from "@starkeep/storage-sqlite";
import {
  appSyncableTableName,
  getAppSyncableNamespace,
} from "@starkeep/storage-sqlite";
import { installLocal } from "../src/local/installer.js";

const MANIFEST = {
  id: "memo",
  name: "Memo",
  version: "1.0.0",
  tier: "community",
  infraRequirements: {
    appSpecificSyncable: {
      files: false,
      tables: [
        {
          name: "card_state",
          columns: [
            { name: "id", type: "text", primaryKey: true, notNull: true },
            { name: "deck_id", type: "text" },
            { name: "due", type: "timestamp" },
            { name: "reps", type: "integer" },
          ],
          indexes: [{ columns: ["deck_id", "due"] }],
        },
      ],
    },
  },
};

function install() {
  const db = new DatabaseSync(":memory:") as never;
  initializeLocalSchema(db);
  installLocal(db, MANIFEST);
  return db;
}

describe("installLocal — app-syncable schema", () => {
  it("creates the index a manifest declares, over the columns it names", () => {
    const db = install();
    const table = appSyncableTableName("memo", "card_state");
    const indexes = (db as unknown as DatabaseSync)
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .all(table) as Array<{ name: string; sql: string | null }>;

    const declared = indexes.find((i) => i.name.endsWith("_deck_id_due"));
    expect(declared, JSON.stringify(indexes.map((i) => i.name))).toBeDefined();
    expect(declared!.sql).toContain('"deck_id"');
    expect(declared!.sql).toContain('"due"');
    // No uniqueness: a unique index over existing duplicates fails or corrupts,
    // and nothing in the query grammar needs one.
    expect(declared!.sql?.toLowerCase()).not.toContain("unique");
    // No partial index either — a predicate over app data would be a second
    // grammar to validate.
    expect(declared!.sql?.toLowerCase()).not.toContain("where");
  });

  it("keeps the sync runtime's own indexes alongside the declared one", () => {
    const db = install();
    const table = appSyncableTableName("memo", "card_state");
    const names = (
      (db as unknown as DatabaseSync)
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
        .all(table) as Array<{ name: string }>
    ).map((i) => i.name);
    // The delta scan seeks `updated_at`, and the responder's per-node coverage
    // watermark seeks `(node_id, updated_at)`. An app's index must not displace
    // either of them.
    expect(names).toContain(`idx_${table}_updated_at`);
    expect(names).toContain(`idx_${table}_node_watermark`);
  });

  it("records column types in the namespace registry, protocol columns included", () => {
    const db = install();
    const ns = getAppSyncableNamespace(db, "memo");
    const table = ns?.tables.find((t) => t.name === "card_state");
    expect(table?.pkColumns).toEqual(["id"]);

    const types = Object.fromEntries((table?.columns ?? []).map((c) => [c.name, c.type]));
    // The query parser validates a filter value against its column and runs in
    // the data server, which never sees a manifest. This row is where it reads
    // the types from.
    expect(types).toMatchObject({
      id: "text",
      deck_id: "text",
      due: "timestamp",
      reps: "integer",
    });
    // The protocol's own columns are described too, because `order=updated_at.desc`
    // is a question about a real column.
    expect(types).toMatchObject({ updated_at: "text", node_id: "text", deleted_at: "text" });
  });

  it("stores a `timestamp` column as text, so no conversion layer exists", () => {
    const db = install();
    const table = appSyncableTableName("memo", "card_state");
    const columns = (db as unknown as DatabaseSync)
      .prepare(`SELECT name, type FROM pragma_table_info(?)`)
      .all(table) as Array<{ name: string; type: string }>;
    const due = columns.find((c) => c.name === "due");
    // A logical type over a physical text column. SQLite has no native
    // timestamp, so a physical type would mean two representations; canonical
    // ISO-8601 text makes lexical comparison a time comparison on both engines.
    expect(due?.type.toUpperCase()).toBe("TEXT");
  });
});
