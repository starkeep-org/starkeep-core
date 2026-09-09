/**
 * `prefix` as a half-open range.
 *
 * `col >= 'photo-' AND col < 'photo.'` returns exactly the rows
 * `LIKE 'photo-%'` returns, and is an index seek on both engines rather than a
 * scan under engine-specific preconditions. DSQL uses the `C` collation only
 * and SQLite defaults to `BINARY`, so the two agree about what "less than"
 * means for text — which is what makes one range mean one thing.
 *
 * The upper bound is the prefix with its last code point incremented. Two edge
 * cases decide the shape of the code below.
 */

/**
 * The exclusive upper bound of the range `prefix` denotes, or null when it has
 * none.
 *
 * Walks back from the end, incrementing the last code point that can be
 * incremented and dropping the ones that cannot. `"az"` with a maximal `z`
 * would become `"b"` — the point is that the bound has to stay a valid string
 * whose comparison is meaningful, not merely one code unit higher.
 *
 * Two care points, and both are why this is not `s.slice(0, -1) + next(last)`:
 *
 *   - **Surrogate pairs.** A JavaScript string is UTF-16, so an astral
 *     character occupies two code units and incrementing the last *unit* would
 *     produce a lone surrogate — not a string either engine's collation orders
 *     sensibly. Code points, via the iterator, are the right unit.
 *   - **The top of the range.** `U+10FFFF` has no successor, and neither does a
 *     prefix made entirely of them; that case answers null, and the caller
 *     compiles the lower bound alone. Incrementing past it would wrap to
 *     something that sorts *below* the prefix and match nothing.
 *
 * The surrogate block itself (`U+D800`–`U+DFFF`) is skipped: a code point
 * incremented into it cannot be encoded, so `U+D7FF` succeeds to `U+E000`.
 */
export function prefixUpperBound(prefix: string): string | null {
  const points = Array.from(prefix);
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const code = points[i]!.codePointAt(0)!;
    let next = code + 1;
    if (next >= 0xd800 && next <= 0xdfff) next = 0xe000;
    if (next > 0x10ffff) continue; // No successor here; drop it and carry.
    return points.slice(0, i).join("") + String.fromCodePoint(next);
  }
  return null;
}
