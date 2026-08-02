/**
 * Per-record residency overrides, expressed as rules over labels (item 34).
 *
 * ## Why rules and not a list of record ids
 *
 * Pinning is already per-record and already works, and it does not scale as a
 * *user intent*. "Keep every photo of my daughter offline" is one sentence and
 * five thousand records, and expressing it by pinning five thousand ids means
 * the intent is nowhere — it has been evaluated once, at pin time, and every
 * photo taken afterwards silently falls outside it. A rule is evaluated on
 * whatever the record carries now, so the answer keeps up with the library.
 *
 * ## Node-local, and about labels the node did not invent
 *
 * A rule is this machine's preference — it travels with nothing, exactly like a
 * pin. But it is written against *shared* labels, which is the point: apps
 * publish `photos/faces=Alice` for their own reasons, and the retention policy
 * gets to use that vocabulary without the platform learning what a face is.
 * Rules name `(appId, key, value?)` and compare them literally.
 *
 * ## Restrictive wins
 *
 * A record matching both a `pin` rule and an `exclude` rule is excluded. That
 * is the same ordering `decideResidency` already applies between record
 * constraints and pins, and the reason is the same: the two pull in opposite
 * directions, and the direction that holds *fewer* bytes is the one that cannot
 * surprise somebody with a full disk. The operator who wrote both gets the
 * safer reading, and a rule that is doing nothing is visible in the UI rather
 * than silently overriding another.
 */

/** One label on a record, in the form a rule compares against. */
export interface RecordLabel {
  readonly appId: string;
  readonly key: string;
  readonly value?: string | null;
}

export type OverrideEffect =
  /** Hold these bytes regardless of budget — the rule form of a pin. */
  | "pin"
  /** Never hold these bytes on this node, whatever the class row says. */
  | "exclude";

export interface OverrideRule {
  readonly appId: string;
  readonly key: string;
  /**
   * Value to match, or omitted for "has this key at all".
   *
   * The distinction is load-bearing. `photos/face-count` is published only when
   * a photo has faces, so a keyless rule on it means "any photo with a face";
   * `photos/faces` carries a person's name, so a rule on it without a value
   * would match every photo of anybody — which is emphatically not what
   * somebody writing a rule about one person meant.
   */
  readonly value?: string;
  readonly effect: OverrideEffect;
  /** Operator-facing description, so a rule list is readable. */
  readonly note?: string;
}

export interface OverrideVerdict {
  readonly pinned: boolean;
  readonly excluded: boolean;
  /** Rules that matched, so the residency inspector can explain a decision. */
  readonly matched: readonly OverrideRule[];
}

export const NO_OVERRIDES: OverrideVerdict = { pinned: false, excluded: false, matched: [] };

function matches(rule: OverrideRule, label: RecordLabel): boolean {
  if (rule.appId !== label.appId || rule.key !== label.key) return false;
  // A rule with no value matches the key's presence. A rule *with* a value
  // requires equality — and a label whose value is null or empty does not
  // satisfy it, since "has no value" is not "has this value".
  if (rule.value === undefined) return true;
  return label.value !== null && label.value !== undefined && label.value === rule.value;
}

/**
 * Evaluate every rule against one record's labels.
 *
 * Deliberately evaluates all of them rather than short-circuiting on the first
 * match: `matched` is what lets the residency inspector answer "why is this
 * record still here", and a list that stopped at the first hit would name a
 * rule that might not even be the one that decided the outcome.
 */
export function evaluateOverrides(
  rules: readonly OverrideRule[],
  labels: readonly RecordLabel[],
): OverrideVerdict {
  if (rules.length === 0 || labels.length === 0) return NO_OVERRIDES;

  const matched: OverrideRule[] = [];
  let pinned = false;
  let excluded = false;

  for (const rule of rules) {
    if (!labels.some((label) => matches(rule, label))) continue;
    matched.push(rule);
    if (rule.effect === "pin") pinned = true;
    else excluded = true;
  }

  // Restrictive wins: an excluded record is not also pinned, however many pin
  // rules matched it. Reporting both would leave the caller to re-derive the
  // precedence, which is how two callers end up disagreeing.
  return { pinned: pinned && !excluded, excluded, matched };
}

/**
 * Problems with a rule set, in the same shape as `validateRetentionPolicy`.
 *
 * Returned rather than thrown so a UI can show every problem at once instead of
 * making the operator fix them one save at a time.
 */
export function validateOverrideRules(rules: readonly OverrideRule[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  rules.forEach((rule, index) => {
    const at = rule.note ? `"${rule.note}"` : `rule ${index + 1}`;
    if (!rule.appId) problems.push(`${at}: appId is required`);
    if (!rule.key) problems.push(`${at}: key is required`);
    if (rule.effect !== "pin" && rule.effect !== "exclude") {
      problems.push(`${at}: effect must be "pin" or "exclude"`);
    }
    // An empty-string value is almost always a UI that submitted a blank field,
    // and it means something quite different from omitting it: it would match
    // only labels whose value is literally empty, which nothing writes. Naming
    // it beats saving a rule that silently matches nothing.
    if (rule.value === "") {
      problems.push(
        `${at}: value is an empty string — omit it entirely to match any value of this key`,
      );
    }

    const identity = `${rule.appId}/${rule.key}=${rule.value ?? "*"}:${rule.effect}`;
    if (seen.has(identity)) problems.push(`${at}: duplicate of an earlier rule`);
    seen.add(identity);
  });

  // A pin and an exclude on exactly the same selector cannot both be intended;
  // the exclude wins, so the pin is dead. Better to say so than to let an
  // operator believe something is being kept when it is not.
  for (const rule of rules) {
    if (rule.effect !== "pin") continue;
    const shadowed = rules.some(
      (other) =>
        other.effect === "exclude" &&
        other.appId === rule.appId &&
        other.key === rule.key &&
        other.value === rule.value,
    );
    if (shadowed) {
      problems.push(
        `${rule.note ? `"${rule.note}"` : `${rule.appId}/${rule.key}`}: pinned and excluded by the ` +
          `same selector — exclude wins, so this pin has no effect`,
      );
    }
  }

  return problems;
}
