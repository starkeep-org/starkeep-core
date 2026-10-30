/**
 * The cloud's node watermark tables: their shape, and the backfill that fills
 * them from the rows already in the database.
 *
 * Each entry holds the highest `updated_at` that has landed in its source
 * table for one user, author and type or table. The broker raises entries
 * inside every write's transaction and reads coverage from them, so an idle
 * sync tick reads one row per author instead of every row the user owns. See
 * `@starkeep/storage-aurora-dsql`, `node-watermarks.ts`.
 *
 * The backfill runs on every install, right after each table's `CREATE`. It
 * folds each source table's grouped maximum into the entries with the same
 * monotonic raise the broker uses, so re-running it while writes continue is
 * safe, and it re-raises any entry a missed raise left low. It writes one row
 * per user, author and type or table, far below DSQL's 3,000-row limit for one
 * transaction at today's author counts.
 */

import { sql, type Kysely } from "kysely";
import { OWNER_COLUMN } from "@starkeep/protocol-primitives";
import { NODE_WATERMARKS_TABLE } from "@starkeep/shared-space-api";

export { NODE_WATERMARKS_TABLE };

export const RECORD_WATERMARKS_TABLE = "shared.node_watermarks_records";
export const LABEL_WATERMARKS_TABLE = "shared.node_watermarks_labels";

type AnyDb = Kysely<Record<string, Record<string, unknown>>>;

/**
 * Create a watermark table keyed by `(user_id, <keyColumn>, node_id)`. The
 * owner leads the key, as on every owned table.
 */
export async function createNodeWatermarkTable<DB>(
  db: Kysely<DB>,
  table: string,
  keyColumn: string,
  constraintName: string,
): Promise<void> {
  await db.schema
    .createTable(table)
    .ifNotExists()
    .addColumn(OWNER_COLUMN, "text", (c) => c.notNull())
    .addColumn(keyColumn, "text", (c) => c.notNull())
    .addColumn("node_id", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint(constraintName, [OWNER_COLUMN, keyColumn, "node_id"] as never[])
    .execute();
}

/**
 * Fold `rows`' per-author maxima into `entries`. `key` names the key column
 * and what fills it: a column of `rows` (`type`, `record_type`), or for an
 * app table the table's own name as a literal.
 */
export async function backfillNodeWatermarks<DB>(
  db: Kysely<DB>,
  entries: string,
  rows: string,
  key: { readonly column: "type" | "record_type" } | { readonly tableName: string },
): Promise<void> {
  const k = db as unknown as AnyDb;
  const keyColumn = "column" in key ? key.column : "table_name";
  await k
    .insertInto(entries)
    .columns([OWNER_COLUMN, keyColumn, "node_id", "updated_at"])
    .expression((eb) => {
      const select = eb
        .selectFrom(rows)
        .select(({ fn }) => [
          OWNER_COLUMN,
          "column" in key
            ? sql.ref<string>(key.column).as(key.column)
            : sql<string>`${sql.lit(key.tableName)}`.as("table_name"),
          "node_id",
          fn.max<string>("updated_at").as("updated_at"),
        ])
        .groupBy([OWNER_COLUMN, "node_id"]);
      return "column" in key ? select.groupBy(key.column) : select;
    })
    .onConflict((oc) =>
      oc
        .columns([OWNER_COLUMN, keyColumn, "node_id"])
        .doUpdateSet((eb) => ({ updated_at: eb.ref("excluded.updated_at") }))
        .where(sql.ref("excluded.updated_at"), ">", sql.ref(`${entries}.updated_at`)),
    )
    .execute();
}
