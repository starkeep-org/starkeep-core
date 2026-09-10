/**
 * The `like` operator: wildcard matching, and what makes it mean one thing.
 *
 * `plan-app-data-query-plane-2026-09-08.md` Q4 deliberately withheld `LIKE`
 * and gave three reasons. Two of them are answered here and the third turned
 * out to be an argument about `prefix` rather than against `LIKE`:
 *
 *   - **Wildcard escaping.** The plan's objection was that a `LIKE` pattern
 *     built from a user-supplied string is the classic escaping bug. That is an
 *     objection to an app assembling a pattern out of a value, which is a thing
 *     `prefix` prevents by taking a literal. Here the pattern *is* the app's
 *     input, so the fix is to give the app an escape character and to refuse
 *     every escape sequence that does not mean something — see
 *     {@link validateLikePattern}.
 *   - **The two engines disagreed on case.** SQLite's `LIKE` is
 *     case-insensitive for ASCII by default and Postgres's is not, so
 *     `like: "photo%"` would have matched `PHOTO123` locally and not in the
 *     cloud. `PRAGMA case_sensitive_like = ON` on the local connection removes
 *     the divergence at its source; DSQL uses the `C` collation only, so the
 *     two then agree byte for byte. The conformance suite proves it rather than
 *     assuming it.
 *   - **Indexability.** `LIKE 'x%'` reaches a btree index only under
 *     engine-specific preconditions — the `C` collation on Postgres, the LIKE
 *     optimization on SQLite. Both preconditions happen to hold here, so the
 *     anchored case is a seek on both. `prefix` is a seek *unconditionally* and
 *     without a pattern language, which is why it stays and why an app matching
 *     a known prefix should still reach for it.
 *
 * A leading `%` is a scan, and is accepted anyway. It is the substring question
 * apps actually have, it costs exactly what an `eq` on an unindexed column
 * costs, and it is linear in the subject — unlike the `regex` operator this
 * replaces, whose cost depended on the pattern and could be made unbounded.
 */

import { LIKE_ESCAPE_CHAR, QueryParseError } from "./types.js";

/**
 * The longest pattern accepted.
 *
 * `LIKE` is linear in the subject and the pattern on both engines, so unlike a
 * regex there is no pathological pattern for a length cap to head off. The cap
 * is here because a pattern is app input that gets logged and bound, and an
 * unbounded one is a request-size question rather than a matching question.
 */
export const MAX_LIKE_PATTERN_LENGTH = 200;

/**
 * Check a pattern's escape sequences and return it unchanged.
 *
 * `%` matches any run of characters, `_` matches exactly one, and a backslash
 * makes the next character a literal. Only `\%`, `\_` and `\\` mean anything;
 * every other backslash sequence is refused rather than passed through.
 *
 * Refusing is the whole point. Postgres treats a backslash before an ordinary
 * character as that character, and SQLite does the same, so `\d` would quietly
 * match a literal `d` on both — an app author who wrote it meaning "a digit"
 * gets a wrong answer instead of an error. There is no digit class in `LIKE`,
 * so the only useful reply is to say so.
 */
export function validateLikePattern(pattern: string): string {
  if (pattern.length === 0) {
    throw new QueryParseError(`like takes a non-empty pattern`);
  }
  if (pattern.length > MAX_LIKE_PATTERN_LENGTH) {
    throw new QueryParseError(
      `like pattern is ${pattern.length} characters; the maximum is ${MAX_LIKE_PATTERN_LENGTH}`,
    );
  }

  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== LIKE_ESCAPE_CHAR) continue;
    const next = pattern[i + 1];
    if (next === undefined) {
      throw new QueryParseError(
        `like pattern ends in a lone ${LIKE_ESCAPE_CHAR}; write ${LIKE_ESCAPE_CHAR}${LIKE_ESCAPE_CHAR} for a literal backslash`,
      );
    }
    if (next !== "%" && next !== "_" && next !== LIKE_ESCAPE_CHAR) {
      throw new QueryParseError(
        `${LIKE_ESCAPE_CHAR}${next} is not a like escape: only ${LIKE_ESCAPE_CHAR}%, ` +
          `${LIKE_ESCAPE_CHAR}_ and ${LIKE_ESCAPE_CHAR}${LIKE_ESCAPE_CHAR} are meaningful. ` +
          `like matches wildcards, not character classes: % is any run of characters and _ is exactly one`,
      );
    }
    i += 1;
  }

  return pattern;
}
