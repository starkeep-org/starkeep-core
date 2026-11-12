/**
 * The snapshot cache: an app's rows copied into an in-memory SQLite, kept for a
 * while, and queried with whatever read-only SQL the app writes.
 *
 * Why the SQL runs here and not on the data server is the subject of
 * `~/projects/starkeep/assessment-item-f-arbitrary-select-2026-11-12.md`: cloud
 * users share every app table, the two engines speak different SQL, and raw SQL
 * would expose tombstones and system columns. The row API already removes all
 * three, so a copy of what it returns is safe to query any way the app likes.
 *
 * ## Lifecycle
 *
 * A snapshot answers while two conditions hold: it is no older than the
 * caller's `maxAge`, and it was loaded no earlier than the caller's
 * `freshAfter`. The first is the backstop for a user who never refreshes. The
 * second is how a Refresh reaches every copy: in the cloud each warm Lambda
 * holds its own snapshot and the browser cannot pick which one answers, so the
 * browser sends the floor with every request instead of sending one command.
 *
 * `loadedAt` is the time the load *started*. A row written while the load ran
 * may or may not be in the copy, so the start is the only time the snapshot can
 * honestly claim.
 *
 * ## What it does not do
 *
 * No transaction spans the pages or the tables of one load, so a write between
 * two pages can leave a child row without its parent. Analysis output tolerates
 * that; the next load corrects it.
 *
 * This module knows nothing about HTTP. `./request.ts` binds it to a request.
 */

import * as sqlite from "node:sqlite";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { SnapshotReadOnlyError, SnapshotTooLargeError } from "./errors.js";

/** A column type as a manifest declares it. */
export type SnapshotColumnType =
  | "integer"
  | "bigint"
  | "real"
  | "text"
  | "blob"
  | "timestamp"
  | "boolean";

/**
 * One table as the manifest's `infraRequirements.appSpecificSyncable.tables`
 * declares it. Passing the manifest's own list is the intended use.
 */
export interface SnapshotTable {
  readonly name: string;
  readonly columns: readonly { readonly name: string; readonly type: string }[];
}

/** A row as the row API returns it. */
export type SnapshotRow = Record<string, unknown>;

export interface SnapshotCacheOptions {
  /** The app's declared tables. A query may name only these. */
  tables: readonly SnapshotTable[];
  /** How many snapshots to keep before evicting the least recently used. Default 16. */
  maxEntries?: number;
  /** The most rows one snapshot may hold, across its tables. Default 200,000. */
  maxRows?: number;
  /** The clock. Tests replace it; nothing else should. */
  now?: () => number;
}

export interface SnapshotLoadContext {
  /** Rows the snapshot may still take. A loader may stop early and throw past it. */
  remainingRows: number;
}

export interface SnapshotCacheQuery {
  /**
   * Whose rows these are. Two scopes never share a snapshot, which is what
   * keeps one user's rows out of another's answer on a shared Lambda.
   */
  scope: string;
  /** The tables the statement reads. Each must be declared. */
  tables: readonly string[];
  /** Every live row of one table, for this scope. */
  load: (table: string, ctx: SnapshotLoadContext) => Promise<SnapshotRow[]>;
  /** One read-only statement: `SELECT`, `WITH … SELECT` or `VALUES`. */
  sql: string;
  /** Positional or named parameters for the statement. */
  params?: readonly SQLInputValue[] | Record<string, SQLInputValue>;
  /** Milliseconds a snapshot may age before a reload. Zero reloads every time. */
  maxAge: number;
  /** Epoch milliseconds. A snapshot loaded before this reloads. */
  freshAfter?: number;
}

export interface SnapshotResult {
  rows: Record<string, SQLOutputValue>[];
  /** Epoch milliseconds when the snapshot's load started, for an "as of" label. */
  loadedAt: number;
}

export interface SnapshotCache {
  query(q: SnapshotCacheQuery): Promise<SnapshotResult>;
  /** Drop every snapshot. */
  clear(): void;
}

interface Snapshot {
  db: DatabaseSync;
  loadedAt: number;
}

interface Entry {
  current?: Snapshot;
  inflight?: { startedAt: number; promise: Promise<Snapshot> };
  evicted: boolean;
}

const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_MAX_ROWS = 200_000;

const SQLITE_TYPE: Record<string, string> = {
  integer: "INTEGER",
  bigint: "INTEGER",
  boolean: "INTEGER",
  real: "REAL",
  text: "TEXT",
  timestamp: "TEXT",
  blob: "BLOB",
};

export function createSnapshotCache(options: SnapshotCacheOptions): SnapshotCache {
  const declared = new Map(options.tables.map((t) => [t.name, t]));
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const now = options.now ?? Date.now;
  if (!(maxEntries >= 1)) throw new RangeError("maxEntries must be at least 1");
  if (!(maxRows >= 0)) throw new RangeError("maxRows must not be negative");

  // Insertion order is recency order: a hit deletes and re-inserts its key.
  const entries = new Map<string, Entry>();

  function touch(key: string): Entry {
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key);
    } else {
      entry = { evicted: false };
    }
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const [oldestKey, oldest] = entries.entries().next().value!;
      entries.delete(oldestKey);
      oldest.evicted = true;
      if (oldest.current) retire(oldest.current.db);
      oldest.current = undefined;
    }
    return entry;
  }

  async function build(
    tables: readonly string[],
    load: SnapshotCacheQuery["load"],
    startedAt: number,
  ): Promise<Snapshot> {
    const loaded: Array<[string, SnapshotRow[]]> = [];
    let total = 0;
    for (const table of tables) {
      const rows = await load(table, { remainingRows: maxRows - total });
      total += rows.length;
      if (total > maxRows) throw new SnapshotTooLargeError(maxRows);
      loaded.push([table, rows]);
    }

    const db = new DatabaseSync(":memory:");
    try {
      db.exec("BEGIN");
      for (const [table, rows] of loaded) fill(db, declared.get(table)!, rows);
      db.exec("COMMIT");
      guardReads(db);
    } catch (err) {
      db.close();
      throw err;
    }
    return { db, loadedAt: startedAt };
  }

  function isFresh(snapshot: Snapshot, maxAge: number, floor: number): boolean {
    return now() - snapshot.loadedAt <= maxAge && snapshot.loadedAt >= floor;
  }

  async function snapshotFor(key: string, q: SnapshotCacheQuery, tables: string[]) {
    const floor = q.freshAfter ?? Number.NEGATIVE_INFINITY;
    const entry = touch(key);

    if (entry.current && isFresh(entry.current, q.maxAge, floor)) return entry.current;
    if (entry.inflight && entry.inflight.startedAt >= floor) return entry.inflight.promise;

    const startedAt = now();
    const promise = build(tables, q.load, startedAt);
    const inflight = { startedAt, promise };
    entry.inflight = inflight;
    try {
      const snapshot = await promise;
      const newest = !entry.current || entry.current.loadedAt <= snapshot.loadedAt;
      if (!entry.evicted && newest) {
        if (entry.current) retire(entry.current.db);
        entry.current = snapshot;
      } else {
        // A newer load already landed, or the entry left the cache. Every
        // caller that joined this load still answers from it, so it closes
        // only after they have run.
        retire(snapshot.db);
      }
      return snapshot;
    } finally {
      if (entry.inflight === inflight) entry.inflight = undefined;
      if (!entry.current && !entry.inflight && entries.get(key) === entry) entries.delete(key);
    }
  }

  return {
    async query(q) {
      if (!(q.maxAge >= 0)) throw new RangeError("maxAge must be a non-negative number");
      const tables = [...new Set(q.tables)].sort();
      if (tables.length === 0) throw new Error("a snapshot query names at least one table");
      for (const t of tables) {
        if (!declared.has(t)) {
          throw new Error(
            `"${t}" is not a declared table; declared: ${[...declared.keys()].join(", ")}`,
          );
        }
      }
      assertReadStatement(q.sql);

      const key = JSON.stringify([q.scope, tables]);
      const snapshot = await snapshotFor(key, q, tables);
      return { rows: run(snapshot, q), loadedAt: snapshot.loadedAt };

      function run(s: Snapshot, query: SnapshotCacheQuery): Record<string, SQLOutputValue>[] {
        const before = totalChanges(s.db);
        const stmt = s.db.prepare(query.sql);
        const rows =
          query.params === undefined
            ? stmt.all()
            : Array.isArray(query.params)
              ? stmt.all(...(query.params as SQLInputValue[]))
              : stmt.all(query.params as Record<string, SQLInputValue>);
        if (totalChanges(s.db) !== before) {
          // The copy no longer matches the data server. Drop it so no later
          // query answers from it.
          const entry = entries.get(key);
          if (entry?.current === s) entry.current = undefined;
          retire(s.db);
          throw new SnapshotReadOnlyError("the statement changed the snapshot; only reads may run");
        }
        return rows.map((r) => ({ ...r }));
      }
    },

    clear() {
      for (const entry of entries.values()) {
        entry.evicted = true;
        if (entry.current) retire(entry.current.db);
        entry.current = undefined;
      }
      entries.clear();
    },
  };
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function fill(db: DatabaseSync, table: SnapshotTable, rows: SnapshotRow[]): void {
  const cols = table.columns;
  const defs = cols.map((c) => `${quoteIdent(c.name)} ${SQLITE_TYPE[c.type] ?? ""}`.trim());
  db.exec(`CREATE TABLE ${quoteIdent(table.name)} (${defs.join(", ")})`);
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO ${quoteIdent(table.name)} (${cols.map((c) => quoteIdent(c.name)).join(", ")}) ` +
      `VALUES (${cols.map(() => "?").join(", ")})`,
  );
  for (const row of rows) insert.run(...cols.map((c) => toSqlite(row[c.name])));
}

/** A row API value as SQLite can store it. */
export function toSqlite(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

// Leading whitespace, line comments and block comments, in any order.
const LEADING_TRIVIA = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

/**
 * Refuse anything but a read, before it reaches SQLite.
 *
 * `prepare` compiles only the first statement of a string, so a check on the
 * first keyword also refuses `ATTACH`, `PRAGMA` and DDL hidden behind it. A
 * `WITH` can still lead into a `DELETE`, which the change count after the
 * statement catches.
 */
function assertReadStatement(sql: string): void {
  const body = sql.replace(LEADING_TRIVIA, "");
  if (!/^(?:select|with|values)\b/i.test(body)) {
    throw new SnapshotReadOnlyError(
      "a snapshot runs only reads: the statement must begin with SELECT, WITH or VALUES",
    );
  }
}

function totalChanges(db: DatabaseSync): number {
  return Number((db.prepare("SELECT total_changes() AS n").get() as { n: number | bigint }).n);
}

/**
 * Where the runtime offers it (Node 24.10 and later), let SQLite itself refuse
 * every action but a read. Node 22 has no authorizer; there the keyword check
 * and the change count carry the guarantee alone.
 */
function guardReads(db: DatabaseSync): void {
  const withAuthorizer = db as DatabaseSync & {
    setAuthorizer?: (cb: ((action: number) => number) | null) => void;
  };
  if (typeof withAuthorizer.setAuthorizer !== "function") return;
  // Read through the namespace: a named import of a binding that an older
  // runtime lacks would fail when the module links, not when this runs.
  const c = ((sqlite as { constants?: unknown }).constants ?? {}) as Record<
    string,
    number | undefined
  >;
  const allowed = new Set(
    [c.SQLITE_SELECT, c.SQLITE_READ, c.SQLITE_FUNCTION, c.SQLITE_RECURSIVE].filter(
      (v): v is number => typeof v === "number",
    ),
  );
  const ok = c.SQLITE_OK;
  const deny = c.SQLITE_DENY;
  if (ok === undefined || deny === undefined) return;
  withAuthorizer.setAuthorizer((action) => (allowed.has(action) ? ok : deny));
}

/**
 * Close a snapshot's database once the callers already holding it have run.
 *
 * Statements run synchronously, so a caller holds a database across no await
 * of its own. The callers that joined a shared load resume in microtasks when
 * it settles; `setImmediate` runs after all of them.
 */
function retire(db: DatabaseSync): void {
  setImmediate(() => {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  });
}
