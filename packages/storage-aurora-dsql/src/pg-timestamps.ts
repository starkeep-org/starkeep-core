/**
 * The `timestamp` boundary on the Postgres side.
 *
 * Everything Starkeep persists is UTC and no column carries a zone; zone
 * handling belongs entirely to the client. A declared `timestamp` is therefore
 * `timestamp without time zone` holding canonical ISO-8601 in UTC
 * (`pgColumnType`), and storage into it is genuinely zone-independent: the `Z`
 * on a canonical value is discarded on input rather than applied, so every
 * writer stores the same wall clock whatever zone it runs in.
 *
 * Two things then have to happen on the way back out, and neither is optional.
 *
 * **The driver must not construct a `Date`.** Both `pg` and PGlite parse OID
 * 1114 by handing the naive string to `new Date(...)`, which JavaScript
 * interprets in the *process* zone — so one stored `2026-01-01 00:00:00` comes
 * back as three different instants under UTC, New York and Tokyo. Lambda runs
 * at UTC, which is exactly why this stays invisible until someone runs the same
 * code somewhere else. {@link PG_RAW_PARSERS} and {@link applyPgTypeParsers}
 * are the two spellings of "return the raw string", one per client.
 *
 * **The rendering must be normalized.** Postgres renders a timestamp as
 * `YYYY-MM-DD HH:MM:SS` with a fractional part that is absent at zero, three
 * digits at milliseconds and six at microseconds. SQLite returns the canonical
 * string unchanged. Two engines answering one query with two different strings
 * is the divergence the conformance suite exists to catch, so
 * {@link toCanonicalTimestamp} puts the Postgres rendering back into canonical
 * form.
 *
 * This module is the Postgres counterpart of `applyConnectionPragmas` on the
 * SQLite side, and carries the same warning: a connection setting the
 * conformance suite does not apply is a divergence the suite cannot catch.
 */

import { isCanonicalTimestamp } from "@starkeep/protocol-primitives";

/** `timestamp without time zone`. */
export const PG_TIMESTAMP_OID = 1114;

/** Hand the raw string over rather than a `Date`. */
const raw = (value: string): string => value;

/**
 * Per-query parsers for a PGlite client, which takes them as a query option
 * rather than as global state.
 */
export const PG_RAW_PARSERS: Record<number, (value: string) => string> = {
  [PG_TIMESTAMP_OID]: raw,
};

/**
 * Install the same parser globally on a `node-postgres` module.
 *
 * Global because `pg` keeps its type parsers in module state, so this must run
 * once before any client on that module issues a query.
 */
export function applyPgTypeParsers(pg: {
  types: { setTypeParser(oid: number, parser: (value: string) => unknown): void };
}): void {
  pg.types.setTypeParser(PG_TIMESTAMP_OID, raw);
}

const PG_RENDERED =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;

/**
 * Postgres' rendering of a `timestamp`, put back into canonical ISO-8601 UTC.
 *
 * Truncates rather than rounds below millisecond precision, so a value only
 * ever moves toward the instant already representable in the canonical form and
 * never past it. A value that is already canonical is returned unchanged, which
 * is what makes this safe to apply to a column whose engine did not rewrite it.
 *
 * Anything else is returned untouched. A column can legitimately hold `null`,
 * and a value this does not recognize is better surfaced to the caller than
 * silently replaced by a guess.
 */
export function toCanonicalTimestamp(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (isCanonicalTimestamp(value)) return value;
  const match = PG_RENDERED.exec(value);
  if (!match) return value;
  const [, date, time, fraction = ""] = match;
  return `${date}T${time}.${fraction.padEnd(3, "0").slice(0, 3)}Z`;
}

/**
 * Apply {@link toCanonicalTimestamp} to a page's declared `timestamp` columns.
 *
 * Mirrors `fromSqliteRows` on the other engine, and applies to everything
 * leaving the applier — query rows, aggregate group keys and `min`/`max`
 * outputs, and rows bound for the wire. The parser forbids an aggregate output
 * from colliding with a column name, so matching by name is unambiguous; an
 * aggregate over a timestamp column is matched by the column it reads, which is
 * why the caller passes the aggregate's output names too.
 */
export function fromPgRows(
  rows: Record<string, unknown>[],
  timestampColumns: ReadonlySet<string> | null,
): Record<string, unknown>[] {
  if (!timestampColumns || timestampColumns.size === 0) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const name of timestampColumns) {
      if (name in out) out[name] = toCanonicalTimestamp(out[name]);
    }
    return out;
  });
}
