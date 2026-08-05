"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The editable retention / budget matrix with projected disk use per row
 * (item 34).
 *
 * ## Why every row shows two numbers
 *
 * "Rule selects" is what the rule asks for; "projected" is what the budget will
 * actually allow. Showing only the second hides that a row is capped — and a
 * capped row means eviction runs against it continuously, so the operator asked
 * to keep the last year and will not get it. Showing only the first would
 * promise disk use that never happens. The gap between them *is* the
 * information.
 *
 * ## Why the projection comes from the daemon
 *
 * Computing it here would mean a second implementation of the rules that decide
 * residency, and the two would drift — so the preview would eventually disagree
 * with what actually happens, which is the one thing a preview must never do.
 * Each edit posts the candidate policy and renders what the daemon says it
 * would mean.
 *
 * ## Why the table has sections
 *
 * A size class belongs to a namespace — the platform's originals, or one app's
 * ladder — and an app has a second budget on top of its rows: a total across
 * every rung it holds. The two fail independently, so a flat list of rows could
 * show every row comfortably inside its budget while the app as a whole is over
 * and being evicted continuously. The section header is where that is visible.
 */

type KeepRule = "all" | "recent-only" | "on-demand-only" | "never";

interface RetentionRow {
  keep: KeepRule;
  budgetBytes: number;
  recencyWindowDays?: number;
  openedWithinDays?: number;
}

interface RowProjection {
  sizeClass: string;
  selectedBytes: number;
  projectedBytes: number;
  budgetBytes: number;
  overBudget: boolean;
  pinnedBytes: number;
  demandDriven: boolean;
}

interface NamespaceProjection {
  namespace: string;
  totalBudgetBytes: number | null;
  selectedBytes: number;
  rowProjectedBytes: number;
  projectedBytes: number;
  overTotal: boolean;
}

interface CensusRow {
  sizeClass: string;
  recordCount: number;
  totalBytes: number;
}

interface OverrideRule {
  appId: string;
  key: string;
  value?: string;
  effect: "pin" | "exclude";
  note?: string;
}

interface AppRetention {
  rows: Record<string, RetentionRow>;
  fallback: RetentionRow;
  totalBudgetBytes: number;
}

interface Policy {
  platform: { rows: Record<string, RetentionRow>; fallback: RetentionRow };
  apps: Record<string, AppRetention>;
  appFallback: AppRetention;
}

interface ProjectionResponse {
  configured?: boolean;
  census: CensusRow[];
  problems?: string[];
  projection?: {
    rows: RowProjection[];
    namespaces: NamespaceProjection[];
    totalProjectedBytes: number;
    overBudgetClasses: string[];
    overTotalNamespaces: string[];
  };
  error?: string;
  offline?: boolean;
}

const GB = 1024 ** 3;

/** Matches `PLATFORM_NAMESPACE` in the sync engine. */
const PLATFORM_NAMESPACE = "starkeep";

/**
 * Split `photos:image-medium` into its halves, at the **first** colon — a
 * platform rung is itself `original:image`.
 */
function splitClass(qualified: string): { namespace: string; rung: string } {
  const at = qualified.indexOf(":");
  if (at <= 0) return { namespace: PLATFORM_NAMESPACE, rung: qualified };
  return { namespace: qualified.slice(0, at), rung: qualified.slice(at + 1) };
}

/**
 * Binary units, matching what the operator's OS reports.
 *
 * A page saying "40 GB" beside a Finder saying "37.2 GB" reads as a bug in the
 * page. Duplicated from the sync engine rather than imported: admin-web does
 * not depend on that package, and one small function is cheaper than the
 * dependency.
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${Number.isInteger(value) || value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

const DEFAULT_ROW: RetentionRow = { keep: "all", budgetBytes: 50 * GB };

/**
 * The total given to an app the operator has never budgeted for.
 *
 * It cannot be unbounded — an unconfigured app would then be the hole every
 * bound in this table is trying to close — and it cannot be zero, which reads
 * as a limit and behaves as a prohibition. So: enough for an app to be useful
 * before anyone looks at this page, small enough that a newly installed app
 * cannot quietly take the disk. Surfaced as "unconfigured" rather than silently
 * applied, because the number is a placeholder for a decision, not the decision.
 */
const DEFAULT_APP_TOTAL = 8 * GB;

const DEFAULT_APP: AppRetention = {
  rows: {},
  fallback: { keep: "recent-only", budgetBytes: 2 * GB, recencyWindowDays: 90 },
  totalBudgetBytes: DEFAULT_APP_TOTAL,
};

/**
 * A starting policy for a node that has never had one, shaped from its own
 * library rather than from an empty table — an operator should be editing
 * something that already describes what they have.
 */
function seedPolicy(census: CensusRow[]): Policy {
  const policy: Policy = {
    platform: { rows: {}, fallback: { keep: "all", budgetBytes: 50 * GB } },
    apps: {},
    appFallback: { ...DEFAULT_APP },
  };
  for (const entry of census) {
    const { namespace, rung } = splitClass(entry.sizeClass);
    if (namespace === PLATFORM_NAMESPACE) {
      policy.platform.rows[rung] = { ...DEFAULT_ROW };
      continue;
    }
    const app = policy.apps[namespace] ?? { ...DEFAULT_APP, rows: {} };
    app.rows[rung] = { ...DEFAULT_ROW };
    policy.apps[namespace] = app;
  }
  return policy;
}

export function RetentionMatrix() {
  const [census, setCensus] = useState<CensusRow[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [rules, setRules] = useState<OverrideRule[]>([]);
  const [projection, setProjection] = useState<ProjectionResponse["projection"]>();
  const [problems, setProblems] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "offline" | "saving" | "saved">(
    "loading",
  );
  const [dirty, setDirty] = useState(false);

  // Load the census, and seed an editable policy from whatever is configured.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/residency")
      .then((r) => r.json())
      .then((body: ProjectionResponse & { retention?: Policy; overrideRules?: OverrideRule[] }) => {
        if (cancelled) return;
        if (body.offline) {
          setStatus("offline");
          return;
        }
        setCensus(body.census ?? []);
        // A node with no policy gets one seeded from its own classes rather
        // than an empty table: an operator should be editing something that
        // already describes their library, not building it from nothing.
        const seeded: Policy = body.retention ?? seedPolicy(body.census ?? []);
        setPolicy(seeded);
        setRules(body.overrideRules ?? []);
        setProjection(body.projection);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-project on every edit, debounced. The daemon is on loopback so this is
  // cheap, and the whole point of the row is answering "what happens if I do
  // this" while the operator is still deciding.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const project = useCallback((next: Policy, nextRules: OverrideRule[]) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fetch("/api/residency/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention: next, overrideRules: nextRules }),
      })
        .then((r) => r.json())
        .then((body: ProjectionResponse) => {
          setProjection(body.projection);
          setProblems(body.problems ?? []);
        })
        .catch(() => undefined);
    }, 250);
  }, []);

  const update = useCallback(
    (sizeClass: string, patch: Partial<RetentionRow>) => {
      const { namespace, rung } = splitClass(sizeClass);
      setPolicy((current) => {
        if (!current) return current;
        let next: Policy;
        if (namespace === PLATFORM_NAMESPACE) {
          next = {
            ...current,
            platform: {
              ...current.platform,
              rows: {
                ...current.platform.rows,
                [rung]: { ...(current.platform.rows[rung] ?? DEFAULT_ROW), ...patch },
              },
            },
          };
        } else {
          // An app the policy has never named starts from the fallback that is
          // already governing it, not from a blank row — otherwise editing one
          // rung would silently change every other rung's rule.
          const app = current.apps[namespace] ?? { ...current.appFallback, rows: {} };
          next = {
            ...current,
            apps: {
              ...current.apps,
              [namespace]: {
                ...app,
                rows: { ...app.rows, [rung]: { ...(app.rows[rung] ?? DEFAULT_ROW), ...patch } },
              },
            },
          };
        }
        project(next, rules);
        return next;
      });
      setDirty(true);
      setStatus("ready");
    },
    [project, rules],
  );

  const updateAppTotal = useCallback(
    (namespace: string, totalBudgetBytes: number) => {
      setPolicy((current) => {
        if (!current) return current;
        const app = current.apps[namespace] ?? { ...current.appFallback, rows: {} };
        const next: Policy = {
          ...current,
          apps: { ...current.apps, [namespace]: { ...app, totalBudgetBytes } },
        };
        project(next, rules);
        return next;
      });
      setDirty(true);
      setStatus("ready");
    },
    [project, rules],
  );

  const updateRules = useCallback(
    (next: OverrideRule[]) => {
      setRules(next);
      setDirty(true);
      setStatus("ready");
      if (policy) project(policy, next);
    },
    [policy, project],
  );

  const save = useCallback(async () => {
    if (!policy) return;
    setStatus("saving");
    const res = await fetch("/api/residency/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention: policy, overrideRules: rules }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { problems?: string[]; error?: string };
      setProblems(body.problems ?? [body.error ?? "Save failed"]);
      setStatus("ready");
      return;
    }
    setProblems([]);
    setDirty(false);
    setStatus("saved");
  }, [policy, rules]);

  const byClass = useMemo(
    () => new Map(projection?.rows.map((r) => [r.sizeClass, r]) ?? []),
    [projection],
  );
  const byNamespace = useMemo(
    () => new Map(projection?.namespaces.map((n) => [n.namespace, n]) ?? []),
    [projection],
  );
  // Rows come from the census *and* from the policy, not the census alone.
  //
  // A census-only table can only show classes the node is currently holding, so
  // a rule written for a class whose bytes have all been evicted has no row —
  // the rule is in force, it is what keeps the class at zero, and it is
  // invisible and uneditable. The two-level policy makes that easy to reach: an
  // operator can budget an app down to nothing and then not be able to budget it
  // back up. A configured class with no bytes reads as "0 B (0)", which is the
  // truth.
  //
  // Platform first — the originals are what an operator is actually deciding
  // about, and an app's ladder is a consequence of that decision.
  const sections = useMemo(() => {
    const grouped = new Map<string, Map<string, CensusRow>>();
    const sectionFor = (namespace: string) => {
      const existing = grouped.get(namespace);
      if (existing) return existing;
      const created = new Map<string, CensusRow>();
      grouped.set(namespace, created);
      return created;
    };
    for (const entry of census) {
      sectionFor(splitClass(entry.sizeClass).namespace).set(entry.sizeClass, entry);
    }
    for (const rung of Object.keys(policy?.platform.rows ?? {})) {
      const sizeClass = `${PLATFORM_NAMESPACE}:${rung}`;
      const section = sectionFor(PLATFORM_NAMESPACE);
      if (!section.has(sizeClass)) section.set(sizeClass, { sizeClass, recordCount: 0, totalBytes: 0 });
    }
    for (const [appId, app] of Object.entries(policy?.apps ?? {})) {
      // An app entry with no rows still gets a section: its total is editable
      // there, and the total is the budget that emptied it.
      const section = sectionFor(appId);
      for (const rung of Object.keys(app.rows ?? {})) {
        const sizeClass = `${appId}:${rung}`;
        if (!section.has(sizeClass)) section.set(sizeClass, { sizeClass, recordCount: 0, totalBytes: 0 });
      }
    }
    return [...grouped.entries()]
      .map(
        ([namespace, entries]) =>
          [
            namespace,
            // Biggest first, as the census arrives; ties broken by name so the
            // empty rows do not shuffle between renders.
            [...entries.values()].sort(
              (a, b) => b.totalBytes - a.totalBytes || a.sizeClass.localeCompare(b.sizeClass),
            ),
          ] as const,
      )
      .sort(([a], [b]) =>
        a === PLATFORM_NAMESPACE ? -1 : b === PLATFORM_NAMESPACE ? 1 : a.localeCompare(b),
      );
  }, [census, policy]);
  const totalLibrary = census.reduce((sum, c) => sum + c.totalBytes, 0);

  if (status === "loading") {
    return <p className="text-sm text-muted-foreground">Measuring the library…</p>;
  }
  // Ordinary state on a fresh machine, so it gets an explanation rather than an
  // error.
  if (status === "offline") {
    return (
      <p className="text-sm text-muted-foreground">
        The local data server isn&apos;t running, so there is nothing to measure yet.
      </p>
    );
  }
  // Nothing held *and* nothing configured. A node with a policy but no bytes
  // still gets the table — those rows are the reason it has no bytes.
  if (sections.length === 0) {
    return <p className="text-sm text-muted-foreground">No records yet.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Class</th>
              <th className="py-2 pr-4 font-medium text-right">In library</th>
              <th className="py-2 pr-4 font-medium">Keep</th>
              <th className="py-2 pr-4 font-medium text-right">Window</th>
              <th className="py-2 pr-4 font-medium text-right">Budget (GiB)</th>
              <th className="py-2 font-medium text-right">Projected on disk</th>
            </tr>
          </thead>
          {sections.map(([namespace, entries]) => (
            <tbody key={namespace}>
              <NamespaceHeader
                namespace={namespace}
                projection={byNamespace.get(namespace)}
                totalBudgetBytes={
                  (policy?.apps[namespace] ?? policy?.appFallback)?.totalBudgetBytes ??
                  DEFAULT_APP_TOTAL
                }
                configured={policy?.apps[namespace] !== undefined}
                onTotalChange={(bytes) => updateAppTotal(namespace, bytes)}
              />
              {entries.map((c) => {
              const { namespace: ns, rung } = splitClass(c.sizeClass);
              const row =
                (ns === PLATFORM_NAMESPACE
                  ? policy?.platform.rows[rung]
                  : policy?.apps[ns]?.rows[rung]) ?? DEFAULT_ROW;
              const proj = byClass.get(c.sizeClass);
              return (
                <tr key={c.sizeClass} className="border-b last:border-0">
                  <td className="py-2 pr-4 pl-4 font-mono text-xs">{rung}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                    {formatBytes(c.totalBytes)}
                    <span className="ml-1 text-xs">({c.recordCount.toLocaleString()})</span>
                  </td>
                  <td className="py-2 pr-4">
                    <select
                      aria-label={`Keep rule for ${c.sizeClass}`}
                      className="rounded border bg-transparent px-2 py-1 text-xs"
                      value={row.keep}
                      onChange={(e) => update(c.sizeClass, { keep: e.target.value as KeepRule })}
                    >
                      <option value="all">everything</option>
                      <option value="recent-only">recent only</option>
                      <option value="on-demand-only">on demand</option>
                      <option value="never">nothing</option>
                    </select>
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {/* Only meaningful for recent-only, and a disabled input
                        says so more clearly than a hidden one — the column
                        keeps its shape as rules change. */}
                    <input
                      aria-label={`Recency window in days for ${c.sizeClass}`}
                      type="number"
                      min={1}
                      disabled={row.keep !== "recent-only"}
                      value={row.recencyWindowDays ?? ""}
                      placeholder="days"
                      className="w-20 rounded border bg-transparent px-2 py-1 text-right text-xs disabled:opacity-30"
                      onChange={(e) =>
                        update(c.sizeClass, {
                          recencyWindowDays: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <input
                      aria-label={`Budget in GiB for ${c.sizeClass}`}
                      type="number"
                      min={0}
                      step="0.5"
                      disabled={row.keep === "never"}
                      value={row.budgetBytes ? (row.budgetBytes / GB).toString() : ""}
                      className="w-24 rounded border bg-transparent px-2 py-1 text-right text-xs disabled:opacity-30"
                      onChange={(e) =>
                        update(c.sizeClass, { budgetBytes: Number(e.target.value) * GB })
                      }
                    />
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {proj ? formatBytes(proj.projectedBytes) : "—"}
                    {proj?.overBudget && (
                      <span
                        className="ml-2 text-xs text-amber-600"
                        title={`The rule selects ${formatBytes(proj.selectedBytes)}, more than the budget allows — this class will be evicted down continuously.`}
                      >
                        capped
                      </span>
                    )}
                    {proj?.demandDriven && (
                      <span
                        className="ml-2 text-xs text-muted-foreground"
                        title="Fetched only on demand — this grows toward the budget as you browse."
                      >
                        grows
                      </span>
                    )}
                    {proj && proj.pinnedBytes > 0 && (
                      <span
                        className="ml-2 text-xs text-muted-foreground"
                        title={`${formatBytes(proj.pinnedBytes)} pinned — kept regardless of the budget.`}
                      >
                        +{formatBytes(proj.pinnedBytes)} pinned
                      </span>
                    )}
                  </td>
                </tr>
              );
              })}
            </tbody>
          ))}
          <tfoot>
            <tr className="font-medium">
              <td className="py-2 pr-4">Total</td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatBytes(totalLibrary)}</td>
              <td colSpan={3} />
              <td className="py-2 text-right tabular-nums">
                {formatBytes(projection?.totalProjectedBytes ?? totalLibrary)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <OverrideRules rules={rules} onChange={updateRules} />

      {problems.length > 0 && (
        <ul className="space-y-1 text-sm text-amber-600">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || status === "saving" || problems.length > 0}
          className="rounded border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {status === "saving" ? "Saving…" : "Save policy"}
        </button>
        {/* Saying so up front: the daemon restarts to pick the policy up, and
            an operator who is not told that reads the brief unavailability as a
            crash. */}
        <span className="text-xs text-muted-foreground">
          {status === "saved"
            ? "Saved — the data server is restarting to apply it."
            : dirty
              ? "Unsaved changes. Saving restarts the data server."
              : "No changes."}
        </span>
      </div>
    </div>
  );
}

/**
 * The section header for one namespace, and — for an app — its total.
 *
 * The total gets a row of its own rather than a column on each class because it
 * is a different kind of number: the class budgets say how the app's bytes are
 * divided, and this one says how many there may be at all. An app can be inside
 * every one of its class budgets and over this, which is the case the header
 * exists to make visible.
 */
function NamespaceHeader({
  namespace,
  projection,
  totalBudgetBytes,
  configured,
  onTotalChange,
}: {
  namespace: string;
  projection: NamespaceProjection | undefined;
  /**
   * From the edited policy, not from `projection` — the projection is what the
   * daemon last said, and it arrives a debounce behind the keystroke. Binding
   * the input to it would make the field fight whoever is typing in it.
   */
  totalBudgetBytes: number;
  configured: boolean;
  onTotalChange: (bytes: number) => void;
}) {
  const isPlatform = namespace === PLATFORM_NAMESPACE;
  return (
    <tr className="border-b bg-muted/30">
      <td className="py-2 pr-4 font-medium" colSpan={2}>
        {isPlatform ? "Originals" : namespace}
        {isPlatform ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            the files themselves — no app can write here
          </span>
        ) : (
          !configured && (
            <span
              className="ml-2 text-xs font-normal text-amber-600"
              title="This app has no budget of its own yet, so the default for unconfigured apps applies. Set a total to decide it deliberately."
            >
              unconfigured
            </span>
          )
        )}
      </td>
      <td className="py-2 pr-4 text-xs text-muted-foreground" colSpan={2}>
        {/* The platform namespace has rows and no total: a cap above them would
            be a second way to say the same thing, and the two could disagree. */}
        {isPlatform ? "" : "Total for this app"}
      </td>
      <td className="py-2 pr-4 text-right">
        {!isPlatform && (
          <input
            aria-label={`Total budget in GiB for ${namespace}`}
            type="number"
            min={0}
            step="0.5"
            value={totalBudgetBytes ? (totalBudgetBytes / GB).toString() : ""}
            className="w-24 rounded border bg-transparent px-2 py-1 text-right text-xs"
            onChange={(e) => onTotalChange(Number(e.target.value) * GB)}
          />
        )}
      </td>
      <td className="py-2 text-right tabular-nums text-xs">
        {projection ? formatBytes(projection.projectedBytes) : "—"}
        {projection?.overTotal && (
          <span
            className="ml-2 text-amber-600"
            title={`These classes together want ${formatBytes(projection.rowProjectedBytes)}, more than the app's total allows — raising any single class budget will not change what it holds.`}
          >
            over total
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Per-record overrides, as rules over labels.
 *
 * Rules rather than a list of pinned records because "keep every photo of my
 * daughter offline" is one sentence and five thousand records — pinning ids
 * evaluates that intent once, so every photo taken afterwards silently falls
 * outside it.
 */
function OverrideRules({
  rules,
  onChange,
}: {
  rules: OverrideRule[];
  onChange: (next: OverrideRule[]) => void;
}) {
  const set = (index: number, patch: Partial<OverrideRule>) =>
    onChange(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Per-record rules</h3>
        <p className="text-xs text-muted-foreground">
          Exceptions by label, applied to whatever a record carries now — so photos added later are
          covered too. Excluding always wins over pinning.
        </p>
      </div>

      {rules.length === 0 && <p className="text-xs text-muted-foreground">No rules.</p>}

      {rules.map((rule, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Effect for rule ${i + 1}`}
            className="rounded border bg-transparent px-2 py-1 text-xs"
            value={rule.effect}
            onChange={(e) => set(i, { effect: e.target.value as "pin" | "exclude" })}
          >
            <option value="pin">Always keep</option>
            <option value="exclude">Never keep</option>
          </select>
          <span className="text-xs text-muted-foreground">records labelled</span>
          <input
            aria-label={`App for rule ${i + 1}`}
            className="w-24 rounded border bg-transparent px-2 py-1 text-xs"
            placeholder="app"
            value={rule.appId}
            onChange={(e) => set(i, { appId: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">/</span>
          <input
            aria-label={`Label key for rule ${i + 1}`}
            className="w-28 rounded border bg-transparent px-2 py-1 text-xs"
            placeholder="key"
            value={rule.key}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">=</span>
          <input
            aria-label={`Label value for rule ${i + 1}`}
            className="w-32 rounded border bg-transparent px-2 py-1 text-xs"
            placeholder="any value"
            value={rule.value ?? ""}
            // Blank means "omit the value" — a rule stored with an empty string
            // would match only labels whose value is literally empty, which
            // nothing writes, so it would silently match nothing.
            onChange={(e) => set(i, { value: e.target.value === "" ? undefined : e.target.value })}
          />
          <button
            type="button"
            aria-label={`Remove rule ${i + 1}`}
            className="rounded border px-2 py-1 text-xs"
            onClick={() => onChange(rules.filter((_, n) => n !== i))}
          >
            Remove
          </button>
        </div>
      ))}

      <button
        type="button"
        className="rounded border px-3 py-1.5 text-xs"
        onClick={() => onChange([...rules, { appId: "photos", key: "", effect: "pin" }])}
      >
        Add rule
      </button>
    </div>
  );
}
