/**
 * Checking a JSON value against a declared column type.
 *
 * This is the reason the namespace registry carries column types at all.
 * SQLite's dynamic typing accepts a numeric bound against a text column and
 * Postgres refuses it, so a grammar that cannot type-check its own input is a
 * grammar whose queries mean different things on the two backends — and the
 * difference shows up as an error in the cloud and a wrong answer locally.
 *
 * The JSON `where` object removes half the problem on its own: a JSON number
 * arrives as a number and a JSON boolean as a boolean, so nothing has to guess
 * what `?due=5` meant. The half that remains is exactly what this file does.
 */

import type { LogicalColumnType } from "@starkeep/protocol-primitives";
import { isCanonicalTimestamp, isNumericColumnType } from "@starkeep/protocol-primitives";
import type { AppSyncableColumnInfo } from "@starkeep/sync-engine";
import type { QueryValue } from "./types.js";

export type ValueCheck =
  | { readonly ok: true; readonly value: QueryValue }
  | { readonly ok: false; readonly message: string };

function bad(column: string, type: LogicalColumnType, value: unknown, detail: string): ValueCheck {
  return {
    ok: false,
    message:
      `"${column}" is declared ${type} and received ${describe(value)}` +
      (detail ? `: ${detail}` : ""),
  };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Check one value against one column, returning the value a compiler binds.
 *
 * `null` passes for any nullable column and is refused for a `NOT NULL` one,
 * because a predicate against null on a column that cannot hold one matches
 * nothing and is more likely a mistake than a question.
 */
export function checkValue(column: AppSyncableColumnInfo, value: unknown): ValueCheck {
  if (value === null) {
    if (column.notNull) {
      return {
        ok: false,
        message: `"${column.name}" is NOT NULL, so a null predicate matches nothing`,
      };
    }
    return { ok: true, value: null };
  }

  switch (column.type) {
    case "text":
      return typeof value === "string"
        ? { ok: true, value }
        : bad(column.name, column.type, value, "expected a string");

    case "timestamp":
      // Canonical ISO-8601 in UTC at millisecond precision, and nothing else.
      // The declared type's whole job is to promise that lexical comparison is
      // time comparison, and `2026-01-01T00:00:00Z` and
      // `2026-01-01T00:00:00.000Z` denote one instant and sort apart — so only
      // one spelling can be legal, on the way in and on the way out.
      return isCanonicalTimestamp(value)
        ? { ok: true, value }
        : bad(
            column.name,
            column.type,
            value,
            "expected canonical ISO-8601 in UTC, e.g. 2026-09-09T00:00:00.000Z",
          );

    case "integer":
    case "bigint":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return bad(column.name, column.type, value, "expected a number");
      }
      return Number.isInteger(value)
        ? { ok: true, value }
        : bad(column.name, column.type, value, "expected a whole number");

    case "real":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, value }
        : bad(column.name, column.type, value, "expected a finite number");

    case "boolean":
      // 0 and 1 are accepted because SQLite stores a boolean as an integer and
      // apps have been writing the integer form. Normalized to a JavaScript
      // boolean here so each applier binds whatever its engine wants, which is
      // the one place the two can be made to agree.
      if (typeof value === "boolean") return { ok: true, value };
      if (value === 0 || value === 1) return { ok: true, value: value === 1 };
      return bad(column.name, column.type, value, "expected true, false, 0 or 1");

    case "blob":
      // A byte string has no JSON spelling, so there is no value to check and
      // no predicate worth expressing. `select` may still project it.
      return {
        ok: false,
        message: `"${column.name}" is a blob and cannot appear in a predicate`,
      };
  }
}

/** Is this column's type one `sum` and `avg` are defined over? */
export function isNumericColumn(column: AppSyncableColumnInfo): boolean {
  return isNumericColumnType(column.type);
}

/**
 * Is this column's type one an ordered comparison is defined over?
 *
 * Everything but `blob`. `text` counts, and `timestamp` counts precisely
 * because its canonical spelling makes lexical order agree with time order.
 */
export function isOrderableColumn(column: AppSyncableColumnInfo): boolean {
  return column.type !== "blob";
}
