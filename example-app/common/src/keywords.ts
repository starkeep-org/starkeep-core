/**
 * The keywords job's pure part: which words of an example file's text become
 * its `keyword` labels.
 *
 * The server half, which lists the files, reads their text and writes the
 * labels through the run's token, is `web/src/server/jobs.ts`.
 */

/** The most keywords one file gets. */
export const MAX_KEYWORDS = 3;

/** The shortest word that counts as a keyword. */
const MIN_LENGTH = 4;

/** Common words of four or more letters that say nothing about a file. */
const STOP_WORDS = new Set([
  "about",
  "also",
  "been",
  "each",
  "every",
  "from",
  "have",
  "into",
  "just",
  "only",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "until",
  "were",
  "what",
  "when",
  "which",
  "while",
  "will",
  "with",
  "your",
]);

/**
 * A file's keywords: its most frequent words of four or more letters, in
 * lowercase and without stop words. A tie goes to the word that appears first.
 * Text with no such word has no keywords.
 */
export function keywordsOf(text: string): string[] {
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().matchAll(/\p{L}+(?:['’]\p{L}+)*/gu)) {
    const word = match[0];
    if ([...word].length < MIN_LENGTH || STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  // A Map keeps insertion order, and the sort is stable, so equal counts keep
  // the order of first appearance.
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORDS)
    .map(([word]) => word);
}
