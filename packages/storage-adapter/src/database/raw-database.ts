/**
 * The narrow SQLite surface sibling subsystems actually use (item 10).
 *
 * ## Why this exists
 *
 * `getRawDatabase()` used to return `node:sqlite`'s `DatabaseSync` directly.
 * That single concrete type is the reason a second driver cannot exist: the
 * sync engine, the resident set and the state store all take it, so every one
 * of them is nailed to Node's built-in SQLite — and React Native has no such
 * thing. op-sqlite is the intended second implementation, and it can satisfy
 * everything below without pretending to be `DatabaseSync`.
 *
 * ## Why it is this small
 *
 * The surface here is not a guess at what a database should offer; it is what
 * the callers were measured to use — `exec` and `prepare`, and on a statement
 * `run`, `get` and `all`. Nothing else appears anywhere in the codebase.
 *
 * That matters in both directions. A wider interface would be work for a second
 * driver to implement that no caller needs, and every method on it would be one
 * more thing that has to behave identically across drivers or produce a bug
 * that only appears on a phone. A narrower one would not compile.
 *
 * `DatabaseSync` satisfies this structurally, so the existing adapter needs no
 * wrapper and no change in behaviour — the type is a restriction on what
 * callers may reach for, not a new object in the path.
 */

/** A prepared statement. Parameters are positional, matching every driver here. */
export interface RawStatement {
  /**
   * Execute for effect.
   *
   * The return value is deliberately unconstrained. `node:sqlite` reports
   * `changes` and `lastInsertRowid`, other drivers report differently, and no
   * caller in this codebase reads it — so specifying a shape would invent a
   * compatibility requirement out of nothing.
   */
  run(...params: unknown[]): unknown;
  /** First matching row, or undefined. */
  get(...params: unknown[]): unknown;
  /** Every matching row. */
  all(...params: unknown[]): unknown[];
}

/**
 * A synchronous SQLite connection.
 *
 * Synchronous on purpose, and the one real constraint this places on a second
 * driver. The sync engine's change-log writes happen inside the same logical
 * operation as the record write they describe; making them async would open a
 * window in which a record exists and its change-log entry does not, which is
 * precisely the state the contiguous-prefix watermark cannot represent.
 * op-sqlite offers a synchronous API for exactly this reason.
 */
export interface RawDatabase {
  /** Run one or more statements for effect. Used for DDL and pragmas. */
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
}
