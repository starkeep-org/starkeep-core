import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql } from "kysely";
import { compiler as k } from "../query-builder.js";
import { appSyncableTableName } from "./namespace.js";
import {
  FILE_RECORDS_TABLE,
  FILE_RECORDS_COLUMNS,
  syncableIndexName,
  type DeclaredColumn,
} from "@starkeep/shared-space-api";
import { sqliteColumnType } from "@starkeep/protocol-primitives";

export interface DeclaredSyncableTable {
  readonly name: string;
  readonly columns: readonly DeclaredColumn[];
  readonly indexes?: readonly { columns: string[] }[];
}

interface SyncableColumnDef {
  name: string;
  /** The emitted SQL type, from `sqliteColumnType`. */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  /**
   * True when the app declared this column `boolean`.
   *
   * `sqliteColumnType` maps `boolean` onto INTEGER, since SQLite has no
   * boolean type, and the physical type is all the rest of this shape needs.
   * The domain constraint does need the distinction, so it is carried
   * separately rather than recovered by guessing which integers are flags.
   */
  boolean?: boolean;
}

/**
 * Emits the CREATE TABLE / CREATE INDEX statements shared by manifest-declared
 * syncable tables and the reserved file-records table. updated_at, node_id
 * (denormalized from updated_at by the applier) and deleted_at are reserved by
 * the sync runtime for inline-HLC change tracking; they are appended
 * automatically and must not be declared in the manifest. (node_id, updated_at)
 * backs the responder's per-node coverage watermark query.
 */
function createSyncableTable(
  db: RawDatabase,
  fullName: string,
  columns: SyncableColumnDef[],
  indexes: readonly { columns: string[] }[] = [],
): void {
  let tb = k.schema.createTable(fullName).ifNotExists();
  for (const c of columns) {
    tb = tb.addColumn(c.name, sql.raw(c.type), (col) => {
      const withNull = c.notNull || c.primaryKey ? col.notNull() : col;
      // A declared `boolean` is physically an INTEGER here, so nothing but this
      // holds it to 0 and 1. The platform's own write path already checks the
      // value, but the sync-apply path does not: a wire row goes straight to the
      // applier, so a peer running different code can put anything in the
      // column. DSQL needs no equivalent — its native `boolean` *is* the domain
      // — and DSQL could not gain one later anyway, since it rejects
      // `ALTER TABLE ADD CONSTRAINT` (probed 2026-09-10).
      return c.boolean ? withNull.check(sql`${sql.ref(c.name)} in (0, 1)`) : withNull;
    });
  }
  tb = tb
    .addColumn("updated_at", "text", (col) => col.notNull())
    .addColumn("node_id", "text", (col) => col.notNull())
    .addColumn("deleted_at", "text");
  // `syncableTableSchema` refuses a table with no primary key
  // (`admin-manifest/src/schema.ts`), so this branch is now unreachable through
  // any manifest-driven install. It stays because a table created without a
  // constraint is *silently* wrong rather than loudly wrong: the applier's
  // UPSERT would have nothing to conflict on, so every replay of a wire entry —
  // a repair round, a re-ship after a lost response, a watermark reset —
  // inserts the row again, and a tombstone could never name the row it retracts.
  const pks = columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (pks.length > 0) {
    tb = tb.addPrimaryKeyConstraint(`pk_${fullName}`, pks as never[]);
  }
  db.exec(tb.compile().sql);
  db.exec(
    k.schema
      .createIndex(`idx_${fullName}_updated_at`)
      .ifNotExists()
      .on(fullName)
      .column("updated_at")
      .compile().sql,
  );
  db.exec(
    k.schema
      .createIndex(`idx_${fullName}_node_watermark`)
      .ifNotExists()
      .on(fullName)
      .columns(["node_id", "updated_at"])
      .compile().sql,
  );
  // App-declared indexes. The query grammar makes an expensive question cheap
  // to ask; these are what make it cheap to answer, and without a matching one
  // a new filter or a grouped count is a full scan.
  //
  // Named the same way the DSQL side names them, so the two backends carry the
  // same index under the same name and a reader comparing them is comparing
  // like with like.
  for (const index of indexes) {
    db.exec(
      k.schema
        .createIndex(syncableIndexName(fullName, index.columns))
        .ifNotExists()
        .on(fullName)
        .columns(index.columns)
        .compile().sql,
    );
  }
}

export function createAppSyncableTables(
  db: RawDatabase,
  appId: string,
  tables: readonly DeclaredSyncableTable[],
): void {
  for (const table of tables) {
    createSyncableTable(
      db,
      appSyncableTableName(appId, table.name),
      table.columns.map((c) => ({
        name: c.name,
        type: sqliteColumnType(c.type),
        notNull: Boolean(c.notNull),
        primaryKey: Boolean(c.primaryKey),
        boolean: c.type === "boolean",
      })),
      table.indexes,
    );
  }
}

/**
 * Create the framework-owned `_starkeep_sync_records` table for an app that
 * opted into `filesEnabled`. Same column shape as the manifest-declared
 * syncable tables (plus the standard updated_at/deleted_at HLC columns) so
 * the LWW applier can treat it uniformly.
 */
export function createReservedFileRecordsTable(db: RawDatabase, appId: string): void {
  createSyncableTable(
    db,
    appSyncableTableName(appId, FILE_RECORDS_TABLE),
    // Through the one mapping, like `createAppSyncableTables` above. This was a
    // hand-written ternary whose Postgres twin in `dsql-ddl.ts` answered
    // `bigint` where this one answered `integer`, for one declared type.
    FILE_RECORDS_COLUMNS.map((c) => ({
      name: c.name,
      type: sqliteColumnType(c.type),
      notNull: Boolean(c.notNull),
      primaryKey: Boolean(c.primaryKey),
    })),
  );
}
