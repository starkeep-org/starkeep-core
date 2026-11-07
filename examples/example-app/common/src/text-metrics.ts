/**
 * The three metadata columns of the `example` category, computed from a file's
 * text.
 *
 * Every flavor must compute them identically, because the platform syncs the
 * metadata row: a phone that counted words differently would overwrite the
 * web flavor's counts with its own.
 */

export interface TextMetrics {
  /** Lines, counting a final line without a trailing newline. Zero for "". */
  readonly line_count: number;
  /** Runs of non-whitespace characters. */
  readonly word_count: number;
  /** Unicode code points, not UTF-16 code units. */
  readonly char_count: number;
}

export function textMetrics(text: string): TextMetrics {
  const lines =
    text === "" ? 0 : text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0);
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return { line_count: lines, word_count: words, char_count: [...text].length };
}
