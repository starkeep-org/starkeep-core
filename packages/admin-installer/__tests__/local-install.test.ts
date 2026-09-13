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
import { FILE_RECORDS_COLUMNS, FILE_RECORDS_TABLE } from "@starkeep/shared-space-api";
import { sqliteColumnType } from "@starkeep/protocol-primitives";

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

function install(manifest: unknown = MANIFEST) {
  const db = new DatabaseSync(":memory:") as never;
  initializeLocalSchema(db);
  installLocal(db, manifest as never);
  return db;
}

/** The same manifest with files sync on, so the reserved table gets created. */
const MANIFEST_WITH_FILES = {
  ...MANIFEST,
  infraRequirements: {
    appSpecificSyncable: {
      ...MANIFEST.infraRequirements.appSpecificSyncable,
      files: true,
    },
  },
};

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

  it("types the reserved file-records table from the one mapping", () => {
    const db = install(MANIFEST_WITH_FILES);
    const columns = (db as unknown as DatabaseSync)
      .prepare(`SELECT name, type FROM pragma_table_info(?)`)
      .all(appSyncableTableName("memo", FILE_RECORDS_TABLE)) as Array<{
      name: string;
      type: string;
    }>;
    expect(columns.length).toBeGreaterThan(0);

    // Every column's physical type is whatever `sqliteColumnType` says for its
    // declared type. Both installers used to translate this one table with a
    // hand-written ternary instead, and the two ternaries disagreed: the DSQL
    // side emitted `bigint` for `size_bytes` where this side emitted `integer`,
    // for a column the manifest-facing declaration called `integer` and neither
    // engine could be checked against.
    const emitted = Object.fromEntries(columns.map((c) => [c.name, c.type.toUpperCase()]));
    for (const column of FILE_RECORDS_COLUMNS) {
      expect(emitted[column.name]).toBe(sqliteColumnType(column.type).toUpperCase());
    }
    // SQLite's INTEGER is 64-bit either way, so `bigint` and `integer` land in
    // the same affinity here. The declaration is what the Postgres side and the
    // read-path conversion both key off, which is why it has to be true rather
    // than merely harmless locally.
    expect(emitted["size_bytes"]).toBe("INTEGER");
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

/**
 * Installing over an installed app, which is the only route a manifest change
 * has to reach one.
 *
 * `installLocal` used to return early on `status === "active"`, so a new column
 * type, a new index, a new label key or a new table was applied at first
 * install and never again. The registry rows for Memo and Photos drifted eight
 * days behind their manifests that way, and the only action that *would* have
 * applied them — Uninstall — drops the app's syncable tables.
 */
describe("reapplying an install upgrades it", () => {
  /** `MANIFEST` a version later: a new index, a new column, a new table. */
  const UPGRADED = {
    ...MANIFEST,
    version: "1.1.0",
    name: "Memo Renamed",
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
            indexes: [{ columns: ["deck_id", "due"] }, { columns: ["deck_id", "reps"] }],
          },
          {
            name: "review_log",
            columns: [{ name: "id", type: "text", primaryKey: true, notNull: true }],
          },
        ],
      },
    },
  };

  function reapply(db: unknown, manifest: unknown = UPGRADED) {
    installLocal(db as never, manifest as never);
    return db as DatabaseSync;
  }

  function rowOf(db: DatabaseSync, appId = "memo") {
    return db
      .prepare(`SELECT * FROM shared_app_registry WHERE app_id = ?`)
      .get(appId) as Record<string, string>;
  }

  it("refreshes the stored manifest, which nothing else can do", () => {
    const db = install() as unknown as DatabaseSync;
    expect(JSON.parse(rowOf(db).manifest!).version).toBe("1.0.0");

    reapply(db);

    const row = rowOf(db);
    expect(row.version).toBe("1.1.0");
    expect(row.name).toBe("Memo Renamed");
    expect(JSON.parse(row.manifest!).version).toBe("1.1.0");
  });

  it("keeps the HMAC secret, so every signer holding it stays valid", () => {
    const db = install() as unknown as DatabaseSync;
    const before = rowOf(db).hmac_secret;

    const result = installLocal(db as never, UPGRADED as never);

    expect(rowOf(db).hmac_secret).toBe(before);
    // And hands it back, so a caller rewiring the app's identity gets the
    // secret the data server will actually verify against.
    expect(result.hmacSecret).toBe(before);
  });

  it("records when the app arrived, not when it was last reconciled", () => {
    const db = install() as unknown as DatabaseSync;
    const before = rowOf(db).installed_at;
    reapply(db);
    expect(rowOf(db).installed_at).toBe(before);
  });

  it("adds a newly declared index and a newly declared table", () => {
    const db = install() as unknown as DatabaseSync;
    const cardState = appSyncableTableName("memo", "card_state");

    const indexesBefore = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .all(cardState) as Array<{ name: string }>;
    expect(indexesBefore.map((i) => i.name)).not.toContain(
      `idx_${cardState}_deck_id_reps`,
    );

    reapply(db);

    const indexesAfter = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .all(cardState) as Array<{ name: string }>;
    expect(indexesAfter.map((i) => i.name)).toContain(`idx_${cardState}_deck_id_reps`);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .all(appSyncableTableName("memo", "review_log")) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it("rewrites the namespace row the query parser validates against", () => {
    const db = install() as unknown as DatabaseSync;
    reapply(db);

    const ns = getAppSyncableNamespace(db as never, "memo");
    expect(ns?.tableNames).toContain("review_log");
    const cardState = ns?.tables.find((t) => t.name === "card_state");
    expect(cardState?.columns?.find((c) => c.name === "due")?.type).toBe("timestamp");
  });

  it("leaves every existing row alone", () => {
    const db = install() as unknown as DatabaseSync;
    const table = appSyncableTableName("memo", "card_state");
    db.prepare(
      `INSERT INTO ${table} (id, deck_id, due, reps, updated_at, node_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("card-1", "deck-1", "2026-09-13T00:00:00Z", 3, "2026-09-13T00:00:00Z", "node-1");

    reapply(db);

    const rows = db.prepare(`SELECT id, deck_id, reps FROM ${table}`).all() as Array<{
      id: string;
      deck_id: string;
      reps: number;
    }>;
    expect(rows).toEqual([{ id: "card-1", deck_id: "deck-1", reps: 3 }]);
  });

  it("is not a migration: a changed column type does not move", () => {
    const db = install() as unknown as DatabaseSync;
    // `reps` goes integer → text. Both installers create `IF NOT EXISTS`, so
    // the physical column keeps the type it was made with. An upgrade that
    // reported this as applied would be the failure the feature introduces.
    reapply(db, {
      ...UPGRADED,
      infraRequirements: {
        appSpecificSyncable: {
          files: false,
          tables: [
            {
              name: "card_state",
              columns: [
                { name: "id", type: "text", primaryKey: true, notNull: true },
                { name: "reps", type: "text" },
              ],
            },
          ],
        },
      },
    });

    const columns = db
      .prepare(`SELECT name, type FROM pragma_table_info(?)`)
      .all(appSyncableTableName("memo", "card_state")) as Array<{ name: string; type: string }>;
    expect(columns.find((c) => c.name === "reps")?.type.toUpperCase()).toBe("INTEGER");
  });
});
