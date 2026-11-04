/**
 * Escaping text for HTML and XML.
 *
 * The cloud data server writes plain HTML pages, and the admin installer
 * writes SVG for the managed login page. Both put text into markup, and both
 * use this one helper, so a fix reaches every caller.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  // `&apos;` is not an HTML 4 entity, and a numeric reference reads the same in
  // HTML and XML.
  "'": "&#39;",
};

/** Make `text` safe as element content or as a quoted attribute value. */
export function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}
