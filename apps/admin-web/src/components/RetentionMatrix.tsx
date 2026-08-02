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

interface Policy {
  rows: Record<string, RetentionRow>;
  fallback: RetentionRow;
}

interface ProjectionResponse {
  configured?: boolean;
  census: CensusRow[];
  problems?: string[];
  projection?: {
    rows: RowProjection[];
    totalProjectedBytes: number;
    overBudgetClasses: string[];
  };
  error?: string;
  offline?: boolean;
}

const GB = 1024 ** 3;

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
        const seeded: Policy = body.retention ?? {
          rows: Object.fromEntries((body.census ?? []).map((c) => [c.sizeClass, { ...DEFAULT_ROW }])),
          fallback: { keep: "never", budgetBytes: 1024 },
        };
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
      setPolicy((current) => {
        if (!current) return current;
        const next: Policy = {
          ...current,
          rows: {
            ...current.rows,
            [sizeClass]: { ...(current.rows[sizeClass] ?? DEFAULT_ROW), ...patch },
          },
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
  if (census.length === 0) return <p className="text-sm text-muted-foreground">No records yet.</p>;

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
          <tbody>
            {census.map((c) => {
              const row = policy?.rows[c.sizeClass] ?? DEFAULT_ROW;
              const proj = byClass.get(c.sizeClass);
              return (
                <tr key={c.sizeClass} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-mono text-xs">{c.sizeClass}</td>
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
