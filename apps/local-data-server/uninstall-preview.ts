/**
 * What an uninstall would actually destroy, read before the operator commits.
 *
 * ## Why this exists
 *
 * `uninstallLocal` is not the reversible "remove the app, keep the data" step
 * its name suggests. Shared records do survive it — that is the platform's
 * standing rule — but everything in the app's *own* syncable namespace does
 * not: `drop_syncable_tables` drops the manifest-declared tables outright, and
 * `delete_syncable_files` rm -rf's the `apps/<appId>/syncable/` object-storage
 * subtree. For Photos that is every caption and title the user typed; there is
 * no tombstone, no trash, and no re-sync that brings them back, because the
 * peers get the same teardown.
 *
 * A confirmation prompt can only be honest about that if it can name what is
 * in there, so this reads the namespace and reports counts plus a handful of
 * real values. Samples, not totals alone: "1,284 rows" reads like bookkeeping,
 * while seeing three of one's own captions is what makes the loss concrete.
 *
 * ## Why it counts live rows only
 *
 * App-syncable tables are soft-deleted — a retracted row stays behind with
 * `deleted_at` set so the tombstone can ship to peers. Counting those would
 * inflate the warning against data the user already threw away, so every query
 * here filters them out.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql } from "kysely";
import {
  appSyncableTableName,
  sqliteCompiler as qb,
} from "../../packages/storage-sqlite/src/index.js";
import { FILE_RECORDS_TABLE } from "../../packages/shared-space-api/src/app-syncable/reserved.js";
import type { AppSyncableNamespace } from "../../packages/shared-space-api/src/index.js";

/** Columns the installer appends to every syncable table; never sample-worthy. */
const HLC_COLUMNS = new Set(["updated_at", "node_id", "deleted_at"]);

const MAX_SAMPLES = 3;
const MAX_SAMPLE_CHARS = 80;

export interface UninstallPreviewTable {
  /** Manifest-declared table name, e.g. `image_enriched`. */
  name: string;
  /** Live (non-tombstoned) row count. */
  rowCount: number;
  /** Up to three one-line renderings of real rows. */
  samples: string[];
}

export interface UninstallPreviewFiles {
  count: number;
  totalBytes: number;
  samples: Array<{ name: string; sizeBytes: number }>;
}

export interface UninstallPreview {
  appId: string;
  /** False when the app has no syncable namespace registered. */
  installed: boolean;
  /** Manifest-declared syncable tables; the reserved file table is excluded. */
  tables: UninstallPreviewTable[];
  /** Null when the app never opted into `appSpecificSyncable.files`. */
  files: UninstallPreviewFiles | null;
}

/**
 * Read the app's syncable namespace and summarize what uninstall would drop.
 *
 * Best-effort by design: a table named in the namespace but missing from the
 * database (a half-finished install, a hand-repaired DB) is reported as zero
 * rows rather than failing the whole preview. Refusing to render the warning
 * is strictly worse than rendering an incomplete one, because the operator's
 * alternative is to uninstall with no warning at all.
 */
export function buildUninstallPreview(
  db: RawDatabase,
  appId: string,
  namespace: AppSyncableNamespace | null,
): UninstallPreview {
  if (!namespace) {
    return { appId, installed: false, tables: [], files: null };
  }

  const tables: UninstallPreviewTable[] = [];
  for (const name of namespace.tableNames) {
    if (name === FILE_RECORDS_TABLE) continue;
    tables.push(previewTable(db, appId, name));
  }

  const files = namespace.filesEnabled ? previewFiles(db, appId) : null;

  return { appId, installed: true, tables, files };
}

function previewTable(db: RawDatabase, appId: string, name: string): UninstallPreviewTable {
  const physical = appSyncableTableName(appId, name);
  if (!tableExists(db, physical)) return { name, rowCount: 0, samples: [] };

  const rowCount = countLive(db, physical);
  if (rowCount === 0) return { name, rowCount: 0, samples: [] };

  const columns = sampleColumns(db, physical);
  const rows = all<Record<string, unknown>>(
    db,
    qb
      .selectFrom(physical)
      .selectAll()
      .where("deleted_at", "is", null)
      .limit(MAX_SAMPLES)
      .compile(),
  );
  const samples: string[] = [];
  for (const row of rows) {
    const rendered = renderRow(row, columns);
    if (rendered) samples.push(rendered);
  }
  return { name, rowCount, samples };
}

function previewFiles(db: RawDatabase, appId: string): UninstallPreviewFiles {
  const physical = appSyncableTableName(appId, FILE_RECORDS_TABLE);
  if (!tableExists(db, physical)) return { count: 0, totalBytes: 0, samples: [] };

  const totals = first<{ n: unknown; bytes: unknown }>(
    db,
    qb
      .selectFrom(physical)
      .select([
        ({ fn }) => fn.countAll().as("n"),
        () => sql<number>`coalesce(sum(size_bytes), 0)`.as("bytes"),
      ])
      .where("deleted_at", "is", null)
      .compile(),
  );

  // Largest first: the operator cares more about the 40 MB video than about
  // the three thumbnails that happen to sort first by id.
  const rows = all<Record<string, unknown>>(
    db,
    qb
      .selectFrom(physical)
      .select(["original_filename", "object_storage_key", "size_bytes"])
      .where("deleted_at", "is", null)
      .orderBy("size_bytes", "desc")
      .limit(MAX_SAMPLES)
      .compile(),
  );

  return {
    count: numberOf(totals?.n),
    totalBytes: numberOf(totals?.bytes),
    samples: rows.map((r) => ({ name: fileLabel(r), sizeBytes: numberOf(r.size_bytes) })),
  };
}

/**
 * Column names worth showing to a human: the app's own columns, minus the
 * primary key and the HLC bookkeeping, in declaration order.
 *
 * The primary key goes because it is an opaque record id in every real app —
 * showing the operator `01JB…7Z` teaches them nothing about what they are
 * about to lose, whereas the column after it is usually the human-written one.
 */
function sampleColumns(db: RawDatabase, physical: string): string[] {
  const info = all<{ name: unknown; pk: unknown }>(
    db,
    sql`pragma table_info(${sql.table(physical)})`.compile(qb),
  );
  return info
    .filter((c) => Number(c.pk) === 0 && !HLC_COLUMNS.has(String(c.name)))
    .map((c) => String(c.name));
}

/**
 * One line for one row: the first non-empty value among the app's own
 * columns, truncated. A row whose only content is its primary key (a bare
 * association row, an all-null enrichment) renders as nothing and is skipped
 * by the caller, because a list of empty quotes is worse than a shorter list.
 */
function renderRow(row: Record<string, unknown>, columns: string[]): string | null {
  for (const col of columns) {
    const value = row[col];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === "") continue;
    return text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS - 1)}…` : text;
  }
  return null;
}

function fileLabel(row: Record<string, unknown>): string {
  const original = row.original_filename;
  if (typeof original === "string" && original.trim() !== "") return original;
  const key = typeof row.object_storage_key === "string" ? row.object_storage_key : "";
  return key.split("/").pop() || "(unnamed file)";
}

function countLive(db: RawDatabase, physical: string): number {
  const row = first<{ n: unknown }>(
    db,
    qb
      .selectFrom(physical)
      .select(({ fn }) => fn.countAll().as("n"))
      .where("deleted_at", "is", null)
      .compile(),
  );
  return numberOf(row?.n);
}

function tableExists(db: RawDatabase, physical: string): boolean {
  const row = first<{ name: string }>(
    db,
    qb
      .selectFrom("sqlite_master")
      .select("name")
      .where("type", "=", "table")
      .where("name", "=", physical)
      .compile(),
  );
  return row !== null;
}

interface Compiled {
  sql: string;
  parameters: readonly unknown[];
}

function all<T>(db: RawDatabase, compiled: Compiled): T[] {
  return db.prepare(compiled.sql).all(...compiled.parameters) as T[];
}

function first<T>(db: RawDatabase, compiled: Compiled): T | null {
  return (db.prepare(compiled.sql).get(...compiled.parameters) as T | undefined) ?? null;
}

/** COUNT/SUM come back as number or bigint depending on the driver. */
function numberOf(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}
