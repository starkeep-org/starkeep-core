/**
 * The `boolean` boundary on the SQLite side.
 *
 * SQLite stores a declared `boolean` as an integer, Postgres stores it as a
 * native boolean and returns one, and a row travels the sync wire exactly as
 * its engine returned it. Without a conversion at each engine's own boundary
 * the same logical row reads as `1` from the local server and `true` from the
 * cloud, and the wire form of a boolean would depend on which node happened to
 * send it. This module is what makes the JSON boolean the one app-facing and
 * on-the-wire form of the type.
 *
 * The Postgres counterpart is `pg-timestamps.ts` in `storage-aurora-dsql`,
 * which converts the two types *that* driver hands back in its own shape. Each
 * engine converts exactly what it would otherwise get wrong; neither converts
 * what the other does.
 */

/** A column, as any table description in this system spells one. */
interface DeclaredColumn {
  readonly name: string;
  readonly type: string;
}

/**
 * The names of a table's declared `boolean` columns, or null when it has none.
 *
 * Null rather than an empty set so the caller can skip the row walk entirely,
 * which is most tables.
 */
export function booleanColumnNames(
  columns: readonly DeclaredColumn[] | null | undefined,
): Set<string> | null {
  if (!columns) return null;
  const names = columns.filter((c) => c.type === "boolean").map((c) => c.name);
  return names.length > 0 ? new Set(names) : null;
}

/**
 * The read half of the boolean conversion: `0` and `1` back to `false` and
 * `true`.
 *
 * Applies to every row leaving this engine: query rows, aggregate group keys
 * (the parser forbids an aggregate output from colliding with a column name, so
 * matching by name is unambiguous), and rows bound for the wire.
 */
export function fromSqliteRows(
  rows: Record<string, unknown>[],
  booleanColumns: ReadonlySet<string> | null,
): Record<string, unknown>[] {
  if (!booleanColumns || booleanColumns.size === 0) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const name of booleanColumns) {
      const value = out[name];
      if (typeof value === "number") out[name] = value !== 0;
    }
    return out;
  });
}

/** SQLite's bindable parameter types. */
export type SqlParam = null | number | bigint | string | Uint8Array;

/**
 * SQLite binds no booleans.
 *
 * A boolean column's value is normalized to a real boolean before it reaches
 * either engine — by the parser for a predicate, by `validateRow` for a written
 * row — so both engines are handed one thing, and this is where that one thing
 * becomes the integer SQLite stores. Postgres takes the boolean unchanged,
 * which is the whole reason the normalization happens upstream rather than here.
 *
 * Every bind on this connection goes through it, reads and writes alike. A
 * conversion applied to only half the traffic is the bug this replaced.
 */
export function toSqliteParam(value: unknown): SqlParam {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SqlParam;
}
