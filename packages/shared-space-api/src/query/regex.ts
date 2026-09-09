/**
 * The `regex` operator: what a pattern may contain, and where it runs.
 *
 * ## Where it runs, and why that is not the database
 *
 * `plan-app-data-query-plane-2026-09-08.md` Q4 settled that the grammar gains
 * `regex` and constrained it to a subset both engines agree on, on the
 * assumption that the predicate would be pushed into SQL — DSQL evaluating
 * POSIX advanced regular expressions, SQLite evaluating a JavaScript function
 * the host registers, and the parser refusing anything the two spell
 * differently.
 *
 * This implements the same decision by evaluating the pattern in the server
 * instead, which reaches the same goal more directly and satisfies a cost rule
 * pushdown could not:
 *
 *   - **One engine, so no divergence to police.** The reason for a common
 *     subset was that POSIX character classes, escape handling, lookbehind and
 *     malformed-pattern behaviour differ between the two evaluators. With one
 *     evaluator there is no second behaviour for a pattern to have.
 *   - **The rows-examined cap becomes exact.** Q4 requires that the rows a
 *     regex may examine are capped and that reaching the cap sets `truncated`
 *     rather than raising. Pushed into SQL that is not expressible: neither
 *     engine reports how many rows a predicate rejected, so the cap could only
 *     be approximated by a second counting query. Evaluated over the applier's
 *     own row iterator it is a counter.
 *   - **Nothing is given up.** Q4 records that no index on either engine can
 *     serve a regex, so pushdown saves row *transfer* and no scan work — and
 *     the transfer is bounded by the very cap that pushdown made impossible.
 *
 * The subset check below is kept even though divergence is no longer the
 * reason for it. It is now a guard against the pattern that makes one row's
 * evaluation unbounded, and it keeps the door open to pushing down later
 * without narrowing what apps may already send.
 */

import { QueryParseError } from "./types.js";

/**
 * The longest pattern accepted.
 *
 * A cap on length is not a cap on cost — `(a+)+$` is nine characters and
 * backtracks catastrophically — but it removes the cheapest way to make one
 * evaluation expensive, and it bounds what has to be logged and stored in a
 * page token's neighbourhood.
 */
export const MAX_PATTERN_LENGTH = 200;

/**
 * Constructs the parser accepts, as the app-facing documentation states them:
 * literals, bracket classes without POSIX names, anchors, alternation,
 * grouping, and the three quantifiers.
 *
 * Refused, each for a reason:
 *
 *   - `[[:alpha:]]` and the rest of the POSIX class names, which have no
 *     JavaScript equivalent and would silently match the literal characters.
 *   - Lookahead and lookbehind (`(?=`, `(?!`, `(?<=`, `(?<!`), backreferences
 *     (`\1`), and named groups — the constructs that make an evaluation's cost
 *     depend on the input rather than on the pattern's length.
 *   - `{n,m}` repetition, which multiplies the backtracking surface for a
 *     question `*`, `+` and `?` already answer.
 */
const ALLOWED_ESCAPES = new Set([
  "\\", "^", "$", ".", "|", "?", "*", "+", "(", ")", "[", "]", "{", "}", "/", "-",
  "d", "D", "w", "W", "s", "S", "n", "r", "t",
]);

function reject(pattern: string, why: string): never {
  throw new QueryParseError(
    `regex pattern ${JSON.stringify(pattern)} is outside the supported subset: ${why}. ` +
      `Supported: literals, bracket classes (no POSIX names), anchors, alternation, ` +
      `grouping, and the quantifiers * + ?`,
  );
}

/**
 * Validate a pattern and return the compiled expression.
 *
 * Compiling here rather than at match time is deliberate: a pattern that the
 * subset check passes and `RegExp` still refuses must fail as a parse error,
 * with a message, rather than as an exception thrown once per row halfway
 * through a page.
 */
export function compileRegexPattern(pattern: string): RegExp {
  if (pattern.length === 0) reject(pattern, "the pattern is empty");
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new QueryParseError(
      `regex pattern is ${pattern.length} characters; the maximum is ${MAX_PATTERN_LENGTH}`,
    );
  }

  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;

    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) reject(pattern, "it ends in a trailing backslash");
      if (/[0-9]/.test(next)) reject(pattern, "backreferences are not supported");
      if (!ALLOWED_ESCAPES.has(next)) {
        reject(pattern, `\\${next} is not a supported escape`);
      }
      i += 1;
      continue;
    }

    if (inClass) {
      if (ch === "]") inClass = false;
      // A POSIX class name is only meaningful inside a bracket class, and
      // JavaScript reads `[[:alpha:]]` as the literal characters `[:alph`
      // followed by a `]` — a silent wrong answer rather than an error.
      else if (ch === "[" && pattern[i + 1] === ":") {
        reject(pattern, "POSIX character classes such as [[:alpha:]] have no equivalent");
      }
      continue;
    }

    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "{") reject(pattern, "{n,m} repetition is not supported");
    if (ch === "(" && pattern[i + 1] === "?") {
      reject(pattern, "lookaround and named groups are not supported");
    }
  }
  if (inClass) reject(pattern, "the bracket class is unterminated");

  try {
    // `u` for well-defined behaviour over astral characters, which is also what
    // makes a lone surrogate in a pattern an error rather than a silent match.
    return new RegExp(pattern, "u");
  } catch (err) {
    reject(pattern, err instanceof Error ? err.message : String(err));
  }
}
