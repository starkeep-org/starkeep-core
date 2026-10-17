/**
 * One-time cutover of this machine's library to the per-user key layout.
 *
 * Libraries written before per-user keys hold `shared/<category>/...` and
 * `apps/<appId>/syncable/...` keys. The new layout carries the owner's segment
 * in every key, and an unbound library writes under `local`. This script
 * renames the old layout to the `local` segment — on disk and in every stored
 * key — so the library looks like any library written before its first cloud.
 * Binding then renames `local` to the user on the machine's first approval
 * (`apps/local-data-server/library-binding.ts`). Nothing is deleted except the
 * retired `starkeep/settings` record, which the cloud now refuses from a
 * device and which would stop the Drive channel.
 *
 * Run it with the local data server stopped:
 *
 *   npx tsx apps/local-data-server/scripts/cutover-local-library.ts            # dry run: what it would do
 *   npx tsx apps/local-data-server/scripts/cutover-local-library.ts --yes      # do it
 *
 * STARKEEP_DIR overrides `~/.starkeep`, which is how the rehearsal runs it on a
 * copy. Before changing anything it snapshots the database and the app files
 * into `<STARKEEP_DIR>/backups/`, and after it checks that every table holds
 * the same number of rows and that every app file index row has its file.
 *
 * See `~/projects/starkeep/plan-multi-user-roles-2026-10-16.md`, step 4.10.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { isCategoryId, LOCAL_USER_SEGMENT } from "../../../packages/protocol-primitives/src/index.js";
import { libraryKeyColumns, sqliteCompiler as qb } from "../../../packages/storage-sqlite/src/index.js";
import type { RawDatabase } from "../../../packages/storage-adapter/src/index.js";

const STARKEEP_DIR = process.env["STARKEEP_DIR"] ?? join(homedir(), ".starkeep");
const DB_PATH = join(STARKEEP_DIR, "data.db");
const OBJECTS = join(STARKEEP_DIR, "objects");
const APPLY = process.argv.includes("--yes");

/** The same key in the `local` layout, or null for a key not in the old one. */
function toLocal(key: string): string | null {
  const s = key.split("/");
  // shared/<category>/<shard>/<hash>
  if (s[0] === "shared" && s.length === 4 && isCategoryId(s[1]!)) return ["shared", LOCAL_USER_SEGMENT, ...s.slice(1)].join("/");
  // apps/<appId>/syncable/<subKey...>
  if (s[0] === "apps" && s.length >= 4 && s[2] === "syncable") return ["apps", s[1], LOCAL_USER_SEGMENT, ...s.slice(2)].join("/");
  return null;
}

function rowCounts(db: DatabaseSync): Map<string, number> {
  const tables = db
    .prepare(qb.selectFrom("sqlite_master").select("name").where("type", "=", sql.lit("table")).compile().sql)
    .all() as Array<{ name: string }>;
  const out = new Map<string, number>();
  for (const { name } of tables) {
    const row = db.prepare(qb.selectFrom(name).select(sql<number>`count(*)`.as("n")).compile().sql).get() as { n: number };
    out.set(name, Number(row.n));
  }
  return out;
}

function refuseIfServerRunning(): void {
  let holders = "";
  try {
    holders = execFileSync("lsof", ["-t", DB_PATH], { encoding: "utf8" }).trim();
  } catch {
    // lsof exits 1 when nothing holds the file.
  }
  if (holders) throw new Error(`${DB_PATH} is open by pid ${holders}. Stop the local data server first.`);
}

function main(): void {
  if (!existsSync(DB_PATH)) throw new Error(`no library at ${DB_PATH}`);
  refuseIfServerRunning();
  const db = new DatabaseSync(DB_PATH);
  const raw = db as unknown as RawDatabase;

  // What would move.
  const columns = libraryKeyColumns(raw);
  const rewrites: Array<{ table: string; column: string; rowid: number; from: string; to: string }> = [];
  for (const { table, column } of columns) {
    const rows = db
      .prepare(qb.selectFrom(table).select([sql<number>`rowid`.as("rowid"), sql<string>`${sql.ref(column)}`.as("k")]).compile().sql)
      .all() as Array<{ rowid: number; k: string | null }>;
    for (const { rowid, k } of rows) {
      const to = typeof k === "string" ? toLocal(k) : null;
      if (to) rewrites.push({ table, column, rowid, from: k!, to });
    }
  }
  const retired = db
    .prepare(qb.selectFrom("shared_records").select(["id", "object_storage_key"]).where("type", "like", sql.lit("starkeep/%")).compile().sql)
    .all() as Array<{ id: string; object_storage_key: string }>;
  const sharedDirs = existsSync(join(OBJECTS, "shared"))
    ? readdirSync(join(OBJECTS, "shared")).filter((d) => isCategoryId(d))
    : [];
  const appDirs = existsSync(join(OBJECTS, "apps"))
    ? readdirSync(join(OBJECTS, "apps")).filter((a) => existsSync(join(OBJECTS, "apps", a, "syncable")))
    : [];

  const byColumn = new Map<string, number>();
  for (const r of rewrites) byColumn.set(`${r.table}.${r.column}`, (byColumn.get(`${r.table}.${r.column}`) ?? 0) + 1);
  console.log(`Library: ${STARKEEP_DIR}`);
  console.log(`Keys to rewrite to the local layout: ${rewrites.length}`);
  for (const [col, n] of byColumn) console.log(`  ${col}: ${n}`);
  console.log(`Folders to move: shared/{${sharedDirs.join(",")}} and apps/{${appDirs.join(",")}}/syncable`);
  console.log(`Retired platform records to delete: ${retired.length} ${retired.map((r) => r.id).join(" ")}`);
  if (!APPLY) {
    console.log("\nDry run. Pass --yes to apply.");
    return;
  }

  // Snapshots first: the database, whole, and every app's files.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backups = join(STARKEEP_DIR, "backups", `cutover-${stamp}`);
  mkdirSync(backups, { recursive: true });
  db.exec(`VACUUM INTO '${join(backups, "data.db").replace(/'/g, "''")}'`);
  if (existsSync(join(OBJECTS, "apps"))) cpSync(join(OBJECTS, "apps"), join(backups, "apps"), { recursive: true, verbatimSymlinks: true });
  console.log(`Snapshot: ${backups}`);
  const before = rowCounts(db);

  // Files first, then keys in one transaction: a crash between them leaves
  // keys pointing at moved files, which the backup and a rerun both repair.
  for (const cat of sharedDirs) {
    const to = join(OBJECTS, "shared", LOCAL_USER_SEGMENT, cat);
    mkdirSync(join(OBJECTS, "shared", LOCAL_USER_SEGMENT), { recursive: true });
    if (existsSync(to)) throw new Error(`${to} already exists`);
    renameSync(join(OBJECTS, "shared", cat), to);
  }
  for (const app of appDirs) {
    const to = join(OBJECTS, "apps", app, LOCAL_USER_SEGMENT, "syncable");
    if (existsSync(to)) throw new Error(`${to} already exists`);
    mkdirSync(join(OBJECTS, "apps", app, LOCAL_USER_SEGMENT), { recursive: true });
    renameSync(join(OBJECTS, "apps", app, "syncable"), to);
  }

  db.exec("BEGIN");
  try {
    for (const r of rewrites) {
      const stmt = qb
        .updateTable(r.table)
        .set({ [r.column]: r.to })
        .where(sql.ref("rowid"), "=", r.rowid)
        .compile();
      db.prepare(stmt.sql).run(...(stmt.parameters as never[]));
    }
    for (const { id } of retired) {
      for (const table of ["shared_records", "shared_record_labels"]) {
        const column = table === "shared_records" ? "id" : "record_id";
        const stmt = qb.deleteFrom(table).where(sql.ref(column), "=", id).compile();
        db.prepare(stmt.sql).run(...(stmt.parameters as never[]));
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // The retired record's bytes: under the moved shared/local/starkeep, if any.
  rmSync(join(OBJECTS, "shared", LOCAL_USER_SEGMENT, "starkeep"), { recursive: true, force: true });

  // Checks: every table the same size, less the retired rows; every file-index
  // row has its file.
  const after = rowCounts(db);
  const problems: string[] = [];
  for (const [table, n] of before) {
    const expected = table === "shared_records" ? n - retired.length : n;
    if (table === "shared_record_labels") continue; // retired records' labels may go too
    if (after.get(table) !== expected) problems.push(`${table}: ${n} rows before, ${after.get(table)} after`);
  }
  for (const { table, column } of columns) {
    if (!table.endsWith("__starkeep_sync_records") || column !== "object_storage_key") continue;
    const rows = db
      .prepare(qb.selectFrom(table).select(sql<string>`${sql.ref(column)}`.as("k")).where("deleted_at", "is", null).compile().sql)
      .all() as Array<{ k: string }>;
    const missing = rows.filter(({ k }) => !existsSync(join(OBJECTS, k)) && !isBrokenLink(join(OBJECTS, k)));
    console.log(`${table}: ${rows.length} live files, ${missing.length} missing on disk`);
    if (missing.length > 0) problems.push(`${table}: ${missing.length} live file rows with no file, e.g. ${missing[0]!.k}`);
  }
  const leftovers = rewrites.length === 0 ? [] : libraryKeyColumns(raw).flatMap(({ table, column }) =>
    (db.prepare(qb.selectFrom(table).select(sql<string>`${sql.ref(column)}`.as("k")).compile().sql).all() as Array<{ k: string | null }>)
      .filter(({ k }) => typeof k === "string" && toLocal(k) !== null)
      .map(({ k }) => `${table}.${column}: ${k}`),
  );
  if (leftovers.length > 0) problems.push(`${leftovers.length} keys still in the old layout, e.g. ${leftovers[0]}`);
  db.close();

  if (problems.length > 0) {
    console.error(`\nCHECKS FAILED. Restore from ${backups} before starting the server.`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("\nDone. Every check passed. Start the local data server and connect this machine.");
}

/** A dangling symlink is a watched file whose source moved; it still counts. */
function isBrokenLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

main();
