/**
 * Which user a node's library belongs to, and the database half of binding it.
 *
 * One node serves one cloud user. Every object key carries its owner's segment
 * (`shared/<userId>/...`, `apps/<appId>/<userId>/syncable/...`), and a library
 * no cloud has bound yet writes under `LOCAL_USER_SEGMENT`. The first time the
 * node signs in, the ID token's `sub` names the user, and binding renames the
 * `local` segment to that user's id before the first sync:
 * on disk, which each host does its own way, and in every stored key, which
 * this file does for every host. After that, a cloud that names a different
 * user stops sync rather than mixing two users' data.
 *
 * ## The order a host binds in
 *
 * 1. {@link checkLibraryBindable}, which refuses a library bound elsewhere.
 * 2. Move the files under `local` to the user's segment.
 * 3. {@link commitLibraryBinding}, which rewrites the stored keys and stores
 *    the user last, in one transaction.
 *
 * A crash part-way leaves the library unbound, so the next start runs the
 * pass again. Every step is idempotent: a file move merges into one already
 * made, and the key rewrites match only keys that still carry `local`.
 *
 * ## The sweep
 *
 * The pass also runs for a library already bound to the same user. A write
 * that built its key under `local` before the pass and landed after it is
 * moved and rewritten by the next pass.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, step 4.9.
 */

import { sql } from "kysely";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { LOCAL_USER_SEGMENT, USER_SEGMENT_PATTERN } from "@starkeep/protocol-primitives";
import { compiler as qb } from "./query-builder.js";

const OWNER_TABLE = "library_owner";

function ensureOwnerTable(db: RawDatabase): void {
  db.exec(
    qb.schema
      .createTable(OWNER_TABLE)
      .ifNotExists()
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("user_id", "text", (c) => c.notNull())
      .compile().sql,
  );
}

/** The user this library is bound to, or null while unbound. */
export function boundUserId(db: RawDatabase): string | null {
  ensureOwnerTable(db);
  const row = db
    .prepare(
      qb.selectFrom(OWNER_TABLE).select("user_id").where("id", "=", sql.lit(0)).compile().sql,
    )
    .get() as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

/** The segment this library writes keys under: its bound user, or `local`. */
export function libraryUserSegment(db: RawDatabase): string {
  return boundUserId(db) ?? LOCAL_USER_SEGMENT;
}

/** A column that can hold a `local` key. */
export interface LibraryKeyColumn {
  readonly table: string;
  readonly column: string;
  /** Whether the column is the table's primary key, so a rewrite can collide. */
  readonly primaryKey: boolean;
}

/**
 * The key columns every SQLite node has: records, availability, the resident
 * set, and each app's file index, which stores the full key as its row id.
 * Only the tables this database holds.
 */
export function libraryKeyColumns(db: RawDatabase): LibraryKeyColumn[] {
  return coreKeyColumns(db).filter(({ table }) => tableExists(db, table));
}

function coreKeyColumns(db: RawDatabase): LibraryKeyColumn[] {
  const columns: LibraryKeyColumn[] = [
    { table: "shared_records", column: "object_storage_key", primaryKey: false },
    { table: "shared_object_availability", column: "object_storage_key", primaryKey: true },
    { table: "resident_keys", column: "object_storage_key", primaryKey: true },
    { table: "resident_keys", column: "record_id", primaryKey: false },
  ];
  const tables = db
    .prepare(
      qb.selectFrom("sqlite_master").select("name").where("type", "=", sql.lit("table")).compile()
        .sql,
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    if (name.endsWith("__starkeep_sync_records")) {
      columns.push(
        { table: name, column: "id", primaryKey: true },
        { table: name, column: "object_storage_key", primaryKey: false },
      );
    }
  }
  return columns;
}

function tableExists(db: RawDatabase, table: string): boolean {
  return (
    db
      .prepare(
        qb
          .selectFrom("sqlite_master")
          .select("name")
          .where("type", "=", sql.lit("table"))
          .where("name", "=", sql.lit(table))
          .compile().sql,
      )
      .get() !== undefined
  );
}

/**
 * The two key namespaces, each as the pattern a `local` key matches and the
 * same key under `userId`.
 */
function namespaces(column: string, userId: string) {
  return [
    {
      local: sql.lit(`shared/${LOCAL_USER_SEGMENT}/%`),
      // Keeps the slash after `local`, so `shared/local/x` becomes `shared/<userId>/x`.
      rebound: sql<string>`'shared/' || ${sql.lit(userId)} || substr(${sql.ref(column)}, ${sql.lit(`shared/${LOCAL_USER_SEGMENT}`.length + 1)})`,
    },
    // apps/<appId>/local/syncable/... — the app id is the segment before `local`.
    {
      local: sql.lit(`apps/%/${LOCAL_USER_SEGMENT}/syncable/%`),
      rebound: sql<string>`replace(${sql.ref(column)}, ${sql.lit(`/${LOCAL_USER_SEGMENT}/syncable/`)}, ${sql.lit(`/${userId}/syncable/`)})`,
    },
  ];
}

/**
 * Rewrite one key column from the `local` segment to `userId`, in both key
 * namespaces. Keys without the `local` segment are untouched. In a primary-key
 * column, a `local` row whose rewritten key already exists is a duplicate a
 * sweep found, and is dropped: the same key names the same object.
 */
function rebindColumn(
  db: RawDatabase,
  { table, column, primaryKey }: LibraryKeyColumn,
  userId: string,
): number {
  let changed = 0;
  for (const { local, rebound } of namespaces(column, userId)) {
    if (primaryKey) {
      const duplicates = qb
        .deleteFrom(table)
        .where(sql.ref(column), "like", local)
        .where(
          sql<boolean>`${rebound} in (${qb.selectFrom(table).select(sql.ref(column).as("k"))})`,
        )
        .compile();
      db.prepare(duplicates.sql).run(...duplicates.parameters);
    }
    const update = qb
      .updateTable(table)
      .set({ [column]: rebound })
      .where(sql.ref(column), "like", local)
      .compile();
    const result = db.prepare(update.sql).run(...update.parameters) as {
      changes?: number | bigint;
    };
    changed += Number(result.changes ?? 0);
  }
  return changed;
}

/** The cloud names a different user than the one this library belongs to. */
export class LibraryBoundElsewhereError extends Error {
  constructor(
    readonly boundTo: string,
    readonly cloudSays: string,
  ) {
    super(
      `This library belongs to user ${boundTo}, but the cloud says this device syncs for user ${cloudSays}. ` +
        `Sync stays off so the two libraries do not mix.`,
    );
    this.name = "LibraryBoundElsewhereError";
  }
}

/**
 * Refuse to bind the library to `userId` when it cannot be: the id is not a
 * user segment, or the library belongs to someone else. Runs before a host
 * moves any file.
 */
export function checkLibraryBindable(db: RawDatabase, userId: string): void {
  if (!USER_SEGMENT_PATTERN.test(userId) || userId === LOCAL_USER_SEGMENT) {
    throw new Error(`cannot bind the library to ${JSON.stringify(userId)}`);
  }
  const current = boundUserId(db);
  if (current !== null && current !== userId) throw new LibraryBoundElsewhereError(current, userId);
}

/**
 * Rewrite every stored key from `local` to `userId`, then store the user, in
 * one transaction. A host passes the key columns of its own tables in
 * `extraKeyColumns`. Returns how many keys changed.
 */
export function commitLibraryBinding(
  db: RawDatabase,
  userId: string,
  extraKeyColumns: readonly LibraryKeyColumn[] = [],
): number {
  checkLibraryBindable(db, userId);
  const columns = [...coreKeyColumns(db), ...extraKeyColumns].filter(({ table }) =>
    tableExists(db, table),
  );
  let rewritten = 0;
  db.exec("BEGIN");
  try {
    for (const column of columns) rewritten += rebindColumn(db, column, userId);
    db.prepare(
      qb
        .insertInto(OWNER_TABLE)
        .values({ id: sql.lit(0), user_id: sql.raw("?") })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({ user_id: eb.ref("excluded.user_id") })),
        )
        .compile().sql,
    ).run(userId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rewritten;
}
