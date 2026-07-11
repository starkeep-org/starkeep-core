/**
 * Advisory record labels follow the convention `<appId>/<purpose>` — e.g.
 * `photos/thumbnail`. The label is advisory-only for *readers* (they choose
 * whether to filter on it), but the write path enforces this prefix rule so an
 * app cannot squat another app's namespace: a present label's prefix must equal
 * the writing app's id. See `DataRecord.label` and the write handlers in the
 * local- and cloud-data-server.
 *
 * Returns true iff `label` is well-formed AND owned by `appId`:
 *   - contains a `/` that is neither first nor last char, and
 *   - the segment before the first `/` equals `appId`.
 *
 * Callers apply this only when a label is present; a `null`/absent label is
 * always valid (general-interest record).
 */
export function labelHasValidPrefix(label: string, appId: string): boolean {
  const slash = label.indexOf("/");
  if (slash <= 0 || slash === label.length - 1) return false;
  return label.slice(0, slash) === appId;
}
