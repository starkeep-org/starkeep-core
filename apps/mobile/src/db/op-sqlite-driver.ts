/**
 * A `RawDatabase` over op-sqlite, so the phone can use the existing SQLite
 * adapter rather than a second copy of it (item 11a).
 *
 * ## `prepare()` does not prepare
 *
 * op-sqlite's real prepared statements execute **asynchronously**:
 *
 * ```ts
 * PreparedStatement = { bind, bindSync, execute: () => Promise<QueryResult> }
 * ```
 *
 * and `RawDatabase` is synchronous by requirement, not by preference — the
 * change-log write happens inside the same logical operation as the record
 * write it describes, and an async gap there is a window where a record exists
 * and its change-log entry does not, which is the one state the
 * contiguous-prefix watermark cannot represent.
 *
 * So `prepare(sql)` captures the SQL string and each `run`/`get`/`all` calls
 * `executeSync(sql, params)`, which *is* synchronous and *does* bind parameters:
 *
 * ```ts
 * executeSync: (query: string, params?: Scalar[]) => QueryResult
 * ```
 *
 * **What that costs:** SQLite re-parses the statement per call, so there is no
 * statement reuse. That is a performance property and not a correctness one —
 * parameters are still bound rather than interpolated, so nothing about
 * injection, quoting or type coercion changes. Worth measuring against a
 * 60k-row library before deciding it matters, and worth *not* pre-empting by
 * making the interface async, because async is precisely what it cannot be.
 *
 * ## `executeSync` blocks the JS thread
 *
 * This is the real risk of the port, and it is not hidden here: a sync round
 * that walks thousands of rows will block interaction for as long as it takes.
 * The mitigation is that such work runs in a background task rather than during
 * interaction — which the constrained-execution model requires anyway, for
 * unrelated reasons. Anything calling this on the interaction path is a bug
 * even when it feels fast on a dev handset.
 */

import type { RawDatabase, RawStatement } from "@starkeep/storage-adapter";
import type { SqliteDriver } from "@starkeep/storage-sqlite";

/**
 * The slice of op-sqlite this needs.
 *
 * Declared structurally rather than imported so this module — and its tests —
 * do not require the native package to be installed. The real dependency is
 * supplied at the app's edge, which is also what lets the whole driver be
 * exercised in Node against a fake.
 */
export interface OpSqliteConnection {
  executeSync(query: string, params?: unknown[]): { rows?: unknown[] };
  close(): void;
}

export interface OpSqliteModule {
  open(options: { name: string; location?: string }): OpSqliteConnection;
}

/** Wrap one op-sqlite connection as the narrow interface the adapter wants. */
export function rawDatabaseFrom(connection: OpSqliteConnection): RawDatabase {
  return {
    exec(sql: string): void {
      // DDL and pragmas arrive here. op-sqlite runs only the first statement of
      // a multi-statement string on native, so anything relying on `exec` to
      // run a batch would silently apply only its first line — the schema
      // bootstrap issues one statement per call, which is why this is safe and
      // why it must stay that way.
      connection.executeSync(sql);
    },
    prepare(sql: string): RawStatement {
      // The SQL is captured, not compiled — see the note at the top.
      return {
        run(...params: unknown[]) {
          return connection.executeSync(sql, params);
        },
        get(...params: unknown[]) {
          return connection.executeSync(sql, params).rows?.[0];
        },
        all(...params: unknown[]) {
          return connection.executeSync(sql, params).rows ?? [];
        },
      };
    },
  };
}

/**
 * The driver the SQLite adapter takes.
 *
 * `path` is the adapter's vocabulary; op-sqlite wants a database *name* within
 * a directory it manages, so the last path segment becomes the name and the
 * rest becomes the location. A phone has no meaningful notion of an absolute
 * filesystem path the app may choose, which is why the translation belongs here
 * rather than in the adapter.
 */
export function createOpSqliteDriver(op: OpSqliteModule): SqliteDriver {
  const connections = new WeakMap<RawDatabase, OpSqliteConnection>();
  return {
    open(path: string): RawDatabase {
      const slash = path.lastIndexOf("/");
      const name = slash >= 0 ? path.slice(slash + 1) : path;
      const location = slash > 0 ? path.slice(0, slash) : undefined;
      const connection = op.open({ name, ...(location ? { location } : {}) });
      const db = rawDatabaseFrom(connection);
      // Kept beside the wrapper rather than on it: `RawDatabase` deliberately
      // has no `close`, because consumers of a connection have no business
      // closing one — only whoever opened it does.
      connections.set(db, connection);
      return db;
    },
    close(db: RawDatabase): void {
      connections.get(db)?.close();
    },
  };
}
