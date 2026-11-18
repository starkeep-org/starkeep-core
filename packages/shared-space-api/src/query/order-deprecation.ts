/**
 * The deprecation notice for the flat `order` spelling (STA-101).
 *
 * `order` has two spellings. The JSON form, `[{"col":"tasks.due","dir":"desc"}]`,
 * names any column in scope. The flat form, `due.desc`, names bare columns
 * only, because its dots separate modifiers and a qualified name would give
 * the dot a second meaning. The flat form still parses until the apps that
 * send it have moved; until then both data servers answer it with an RFC 9745
 * `Deprecation` header and log one line per app per process.
 */

/** When the flat spelling was deprecated (2026-11-18), as RFC 9745's `@<unix seconds>`. */
export const FLAT_ORDER_DEPRECATED_AT = "@1794960000";

const GUIDE = "https://github.com/starkeep-org/starkeep-core/blob/main/docs/authoring-an-app.md";

/** Is `raw` an `order` in the flat spelling? Absent and empty are neither form. */
export function isFlatOrder(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  return trimmed !== "" && !trimmed.startsWith("[");
}

/** The apps already logged in this process, so a busy app logs once. */
const loggedApps = new Set<string>();

/**
 * The response headers for a request whose `order` uses the flat spelling, or
 * null for any other request.
 *
 * Logs the first such request of each app in this process. The header goes on
 * every such response, because a caller that reads it may read any one.
 */
export function flatOrderDeprecation(
  order: string | undefined,
  appId: string,
  warn: (message: string) => void = console.warn,
): Record<string, string> | null {
  if (!isFlatOrder(order)) return null;
  if (!loggedApps.has(appId)) {
    loggedApps.add(appId);
    warn(
      `[query] app "${appId}" sent order="${order}", the deprecated flat spelling ` +
        `(STA-101); send order as JSON, such as [{"col":"due","dir":"desc"}]`,
    );
  }
  return { Deprecation: FLAT_ORDER_DEPRECATED_AT, Link: `<${GUIDE}>; rel="deprecation"` };
}
