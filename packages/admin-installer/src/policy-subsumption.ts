/**
 * Whether a policy's Allow actions sit inside a permissions boundary's Allow
 * actions. IAM intersects the two, so a verb the boundary does not allow is
 * silently denied at runtime. `scripts/check-temp-vs-boundary.ts` and
 * `__tests__/temp-policy-symmetry.test.ts` both run this check; keeping one
 * matcher means a wildcard on either side is judged the same way in both.
 *
 * Resources and conditions are out of scope: the check answers only "could
 * any request for this verb pass the boundary at all".
 */

export interface ActionStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
}

function toArray(x: string | string[] | undefined): string[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * True when every action `wanted` can name is also named by `allowed`. Both
 * sides may hold `*` anywhere, and IAM compares actions without regard to
 * case. A `*` in `allowed` absorbs any run of `wanted`'s characters, its `*`s
 * included; a literal in `allowed` must meet the same literal in `wanted`,
 * never a `*`, because that `*` could stand for some other text. So
 * `s3:GetBucket*` covers `s3:GetBucket*` and is covered by `s3:Get*`, while
 * `s3:Get*` is not covered by `s3:GetBucket*`.
 */
export function actionCovers(allowed: string, wanted: string): boolean {
  const a = allowed.toLowerCase();
  const w = wanted.toLowerCase();
  // reach[j]: a's prefix so far can produce exactly w's first j characters.
  let reach: boolean[] = Array.from({ length: w.length + 1 }, (_, j) => j === 0);
  for (const ch of a) {
    const next = new Array<boolean>(w.length + 1).fill(false);
    if (ch === "*") {
      let seen = false;
      for (let j = 0; j <= w.length; j++) {
        seen ||= reach[j];
        next[j] = seen;
      }
    } else {
      for (let j = 1; j <= w.length; j++) {
        next[j] = reach[j - 1] && w[j - 1] === ch;
      }
    }
    reach = next;
  }
  return reach[w.length];
}

/** Every Allow action across the boundary's statements. */
export function boundaryAllowedActions(boundary: ActionStatement[]): string[] {
  return boundary.filter((s) => s.Effect === "Allow").flatMap((s) => toArray(s.Action));
}

/** The policy's Allow actions that no boundary action covers, as `{ sid, action }`. */
export function uncoveredActions(
  policy: { Statement: ActionStatement[] },
  boundary: ActionStatement[],
): Array<{ sid: string | undefined; action: string }> {
  const allowed = boundaryAllowedActions(boundary);
  const missing: Array<{ sid: string | undefined; action: string }> = [];
  for (const stmt of policy.Statement) {
    if (stmt.Effect !== "Allow") continue;
    for (const action of toArray(stmt.Action)) {
      if (!allowed.some((a) => actionCovers(a, action))) missing.push({ sid: stmt.Sid, action });
    }
  }
  return missing;
}
