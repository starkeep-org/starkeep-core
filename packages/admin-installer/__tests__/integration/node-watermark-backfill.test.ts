/**
 * The install-time backfill of the node watermark tables, against real SQL.
 *
 * The backfill fills each table from the rows already in its source table,
 * with the same monotonic raise the broker uses on every write. It must match
 * the grouped read it replaces on fresh data, change nothing when run again,
 * and never lower an entry: an entry above every live row is coverage the
 * cloud really had. See `src/node-watermark-ddl.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PostgresDialect } from "kysely";
import {
  LABEL_WATERMARKS_TABLE,
  RECORD_WATERMARKS_TABLE,
  backfillNodeWatermarks,
  createNodeWatermarkTable,
} from "../../src/node-watermark-ddl";

let pg: PGlite;
let db: Kysely<Record<string, never>>;

beforeEach(async () => {
  pg = new PGlite();
  await pg.waitReady;
  const query = async (text: string, values?: unknown[]) => {
    const result = await pg.query(text, values);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
      command: text.trim().split(/\s+/)[0]!.toUpperCase(),
    };
  };
  db = new Kysely({
    dialect: new PostgresDialect({
      pool: { connect: async () => ({ query, release() {} }), end: async () => {} },
    }),
  });
  await pg.exec(`
    CREATE SCHEMA shared;
    CREATE TABLE shared.records (
      user_id text NOT NULL, id text NOT NULL, type text NOT NULL,
      updated_at text NOT NULL, node_id text NOT NULL, deleted_at text,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE shared.record_labels (
      user_id text NOT NULL, record_id text NOT NULL, key text NOT NULL,
      record_type text NOT NULL, updated_at text NOT NULL, node_id text NOT NULL,
      PRIMARY KEY (user_id, record_id, key)
    );
    CREATE SCHEMA app_memo;
    CREATE TABLE app_memo.cards (
      user_id text NOT NULL, id text NOT NULL, updated_at text NOT NULL, node_id text NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `);
  await createNodeWatermarkTable(db, RECORD_WATERMARKS_TABLE, "type", "records_wm_pkey");
  await createNodeWatermarkTable(db, LABEL_WATERMARKS_TABLE, "record_type", "labels_wm_pkey");
  await createNodeWatermarkTable(
    db,
    "app_memo._starkeep_node_watermarks",
    "table_name",
    "memo_wm_pkey",
  );
});

afterEach(async () => {
  await db.destroy();
  await pg.close();
});

/** A serialized stamp: fixed-width hex wall time, counter, author. */
function stamp(wall: number, node: string): string {
  return `${wall.toString(16).padStart(12, "0")}:0000:${node}`;
}

async function seedRecords(): Promise<void> {
  const rows: [string, string, string, number, string, boolean][] = [
    ["user-a", "r1", "image/jpeg", 5, "laptop", false],
    ["user-a", "r2", "image/jpeg", 9, "laptop", true],
    ["user-a", "r3", "document/pdf", 7, "laptop", false],
    ["user-a", "r4", "image/jpeg", 3, "phone", false],
    ["user-b", "r1", "image/jpeg", 11, "laptop", false],
  ];
  for (const [user, id, type, wall, node, tombstone] of rows) {
    const at = stamp(wall, node);
    await pg.query(
      "INSERT INTO shared.records (user_id, id, type, updated_at, node_id, deleted_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [user, id, type, at, node, tombstone ? at : null],
    );
  }
}

async function entries(table: string, key: string) {
  return (
    await pg.query(
      `SELECT user_id, ${key} AS key, node_id, updated_at FROM ${table} ORDER BY 1, 2, 3`,
    )
  ).rows;
}

describe("the node watermark backfill", () => {
  it("matches the grouped read over the rows, tombstones included", async () => {
    await seedRecords();
    await backfillNodeWatermarks(db, RECORD_WATERMARKS_TABLE, "shared.records", { column: "type" });
    const grouped = (
      await pg.query(
        "SELECT user_id, type AS key, node_id, max(updated_at) AS updated_at FROM shared.records GROUP BY 1, 2, 3 ORDER BY 1, 2, 3",
      )
    ).rows;
    expect(await entries(RECORD_WATERMARKS_TABLE, "type")).toEqual(grouped);
    expect(grouped).toHaveLength(4);
  });

  it("changes nothing when run twice", async () => {
    await seedRecords();
    await backfillNodeWatermarks(db, RECORD_WATERMARKS_TABLE, "shared.records", { column: "type" });
    const once = await entries(RECORD_WATERMARKS_TABLE, "type");
    await backfillNodeWatermarks(db, RECORD_WATERMARKS_TABLE, "shared.records", { column: "type" });
    expect(await entries(RECORD_WATERMARKS_TABLE, "type")).toEqual(once);
  });

  it("raises a low entry and never lowers a high one", async () => {
    await seedRecords();
    // Low: a raise the broker missed. High: an author whose rows were all
    // superseded since its entry rose.
    await pg.query(
      `INSERT INTO ${RECORD_WATERMARKS_TABLE} VALUES ('user-a', 'image/jpeg', 'laptop', $1), ('user-a', 'image/jpeg', 'phone', $2)`,
      [stamp(1, "laptop"), stamp(99, "phone")],
    );
    await backfillNodeWatermarks(db, RECORD_WATERMARKS_TABLE, "shared.records", { column: "type" });
    const byAuthor = Object.fromEntries(
      (await entries(RECORD_WATERMARKS_TABLE, "type"))
        .filter((r) => r["user_id"] === "user-a" && r["key"] === "image/jpeg")
        .map((r) => [r["node_id"], r["updated_at"]]),
    );
    expect(byAuthor).toEqual({ laptop: stamp(9, "laptop"), phone: stamp(99, "phone") });
  });

  it("keys labels by record type and app tables by the table's name", async () => {
    await pg.query(
      "INSERT INTO shared.record_labels VALUES ('user-a', 'r1', 'k', 'image/jpeg', $1, 'laptop')",
      [stamp(4, "laptop")],
    );
    await pg.query("INSERT INTO app_memo.cards VALUES ('user-a', 'c1', $1, 'cloud-1')", [
      stamp(6, "cloud-1"),
    ]);
    await backfillNodeWatermarks(db, LABEL_WATERMARKS_TABLE, "shared.record_labels", {
      column: "record_type",
    });
    await backfillNodeWatermarks(db, "app_memo._starkeep_node_watermarks", "app_memo.cards", {
      tableName: "cards",
    });
    expect(await entries(LABEL_WATERMARKS_TABLE, "record_type")).toEqual([
      { user_id: "user-a", key: "image/jpeg", node_id: "laptop", updated_at: stamp(4, "laptop") },
    ]);
    expect(await entries("app_memo._starkeep_node_watermarks", "table_name")).toEqual([
      { user_id: "user-a", key: "cards", node_id: "cloud-1", updated_at: stamp(6, "cloud-1") },
    ]);
  });
});
