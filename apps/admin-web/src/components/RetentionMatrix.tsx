"use client";

import { useEffect, useState } from "react";

/**
 * The retention / budget matrix with projected disk use per row (item 34).
 *
 * ## Why every row shows two numbers
 *
 * "Selected" is what the rule asks for; "projected" is what the budget will
 * actually allow. Showing only the second hides the fact that a row is capped,
 * and a capped row means eviction runs against it continuously — the operator
 * asked to keep the last year and will not get it. Showing only the first would
 * promise disk use that never happens. The gap between them *is* the
 * information.
 */

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

interface ProjectionResponse {
  configured: boolean;
  census: CensusRow[];
  totalLibraryBytes?: number;
  projection?: {
    rows: RowProjection[];
    totalProjectedBytes: number;
    overBudgetClasses: string[];
  };
  error?: string;
  offline?: boolean;
}

/**
 * Binary units, matching what the operator's OS reports.
 *
 * A page saying "40 GB" beside a Finder saying "37.2 GB" reads as a bug in the
 * page. Duplicated from the sync engine's formatter rather than imported
 * because admin-web does not depend on that package, and one small function is
 * a smaller cost than the dependency.
 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${Number.isInteger(value) || value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function RetentionMatrix() {
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/residency")
      .then((r) => r.json())
      .then((body: ProjectionResponse) => {
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setData({ configured: false, census: [], error: String(err), offline: true });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="text-sm text-muted-foreground">Measuring the library…</p>;

  // A daemon that is not running is the ordinary state on a fresh machine, so
  // it gets an explanation rather than an error.
  if (data?.offline) {
    return (
      <p className="text-sm text-muted-foreground">
        The local data server isn&apos;t running, so there is nothing to measure yet.
      </p>
    );
  }

  if (!data || data.census.length === 0) {
    return <p className="text-sm text-muted-foreground">No records yet.</p>;
  }

  const byClass = new Map(data.projection?.rows.map((r) => [r.sizeClass, r]) ?? []);
  const totalLibrary = data.census.reduce((sum, c) => sum + c.totalBytes, 0);

  return (
    <div className="space-y-4">
      {!data.configured && (
        // An unconfigured node wants every blob, so the honest headline is the
        // whole library — not an empty table, which would read as "nothing
        // here" and is the opposite of the truth.
        <p className="text-sm text-muted-foreground">
          No retention policy is configured, so this node keeps everything:{" "}
          <strong>{formatBytes(totalLibrary)}</strong> across {data.census.length} classes.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Class</th>
              <th className="py-2 pr-4 font-medium text-right">Records</th>
              <th className="py-2 pr-4 font-medium text-right">In library</th>
              <th className="py-2 pr-4 font-medium text-right">Rule selects</th>
              <th className="py-2 pr-4 font-medium text-right">Budget</th>
              <th className="py-2 font-medium text-right">Projected on disk</th>
            </tr>
          </thead>
          <tbody>
            {data.census.map((c) => {
              const row = byClass.get(c.sizeClass);
              return (
                <tr key={c.sizeClass} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-mono text-xs">{c.sizeClass}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {c.recordCount.toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatBytes(c.totalBytes)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                    {row ? formatBytes(row.selectedBytes) : "—"}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                    {row ? formatBytes(row.budgetBytes) : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row ? formatBytes(row.projectedBytes) : formatBytes(c.totalBytes)}
                    {row?.overBudget && (
                      // Not decoration. A capped row means eviction runs
                      // against it continuously, so what was asked for is not
                      // what will happen.
                      <span
                        className="ml-2 text-xs text-amber-600"
                        title="The rule selects more than the budget allows, so this class will be evicted down continuously."
                      >
                        capped
                      </span>
                    )}
                    {row?.demandDriven && (
                      <span
                        className="ml-2 text-xs text-muted-foreground"
                        title="Fetched only on demand — this grows toward the budget as you browse."
                      >
                        grows
                      </span>
                    )}
                    {row && row.pinnedBytes > 0 && (
                      // Pins win over budgets, so a row can legitimately exceed
                      // its own cap. Without this an operator would read that as
                      // a bug.
                      <span
                        className="ml-2 text-xs text-muted-foreground"
                        title={`${formatBytes(row.pinnedBytes)} pinned — kept regardless of the budget.`}
                      >
                        {formatBytes(row.pinnedBytes)} pinned
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
              <td className="py-2 pr-4 text-right tabular-nums">
                {data.census.reduce((s, c) => s + c.recordCount, 0).toLocaleString()}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatBytes(totalLibrary)}</td>
              <td colSpan={2} />
              <td className="py-2 text-right tabular-nums">
                {formatBytes(data.projection?.totalProjectedBytes ?? totalLibrary)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {data.projection && data.projection.overBudgetClasses.length > 0 && (
        <p className="text-sm text-amber-600">
          {data.projection.overBudgetClasses.length} class
          {data.projection.overBudgetClasses.length === 1 ? "" : "es"} will not fit in their budget
          and will be evicted down continuously. Raise the budget, or narrow the rule so it asks for
          less.
        </p>
      )}
    </div>
  );
}
