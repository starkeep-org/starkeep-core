"use client";

// Per-capability consent at cloud install (plan §3.2). Lists each capability the
// app declares in its manifest with the rationale, requested monthly budget, the
// models it may call, and the dimensions it can report — labelled "app-reported"
// (input values the app supplies; can under-report) vs "best-effort" (output
// values fundamentally unknowable in advance), per plan §3.5. The operator
// approves each; OPTIONAL capabilities can be denied (the app then runs degraded
// and no grant row is written), REQUIRED ones cannot (denying blocks install).

import { Badge } from "@/components/ui/badge";
import type { CapabilityRequirement } from "@/lib/app-types";

/** A reports entry is "dimension:unit"; input dims are app-reported, output dims
 * are best-effort (see plan §3.5). Generic dims never appear in `reports`. */
function reportLabel(key: string): { text: string; kind: "app-reported" | "best-effort" } {
  const dimension = key.split(":")[0];
  return dimension === "output"
    ? { text: "best-effort", kind: "best-effort" }
    : { text: "app-reported", kind: "app-reported" };
}

export function CapabilityConsent({
  capabilities,
  denied,
  onToggle,
}: {
  capabilities: CapabilityRequirement[];
  /** Names the operator has denied (optional capabilities only). */
  denied: Set<string>;
  onToggle: (name: string, approve: boolean) => void;
}) {
  if (capabilities.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        This app requests the following platform capabilities. Approve the ones you want to grant.
        Optional capabilities can be denied — the app will run in a degraded mode without them.
      </p>
      {capabilities.map((cap) => {
        const required = cap.required !== false; // default true
        const approved = required || !denied.has(cap.name);
        return (
          <div key={cap.name} className="rounded-md border p-3 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{cap.name}</span>
                  {required ? (
                    <Badge variant="secondary" className="text-xs">required</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">optional</Badge>
                  )}
                </div>
                {cap.rationale && (
                  <span className="text-sm text-muted-foreground">{cap.rationale}</span>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm select-none whitespace-nowrap">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={approved}
                  disabled={required}
                  onChange={(e) => onToggle(cap.name, e.target.checked)}
                  aria-label={`Approve ${cap.name}`}
                />
                {approved ? "Approved" : "Denied"}
              </label>
            </div>

            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
              {typeof cap.requestedMonthlyBudgetUsd === "number" && (
                <>
                  <dt className="text-muted-foreground">Budget</dt>
                  <dd>
                    up to ~${cap.requestedMonthlyBudgetUsd}/mo{" "}
                    <span className="text-muted-foreground">
                      (stored as a per-app cost gate you can tighten later)
                    </span>
                  </dd>
                </>
              )}
              {cap.models && cap.models.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Models</dt>
                  <dd className="flex flex-wrap gap-1">
                    {cap.models.map((m) => (
                      <span key={m} className="font-mono text-xs rounded bg-muted px-1.5 py-0.5">
                        {m}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              {cap.reports && cap.reports.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Reports</dt>
                  <dd className="flex flex-wrap items-center gap-1">
                    {cap.reports.map((r) => {
                      const label = reportLabel(r);
                      return (
                        <span key={r} className="inline-flex items-center gap-1">
                          <span className="font-mono text-xs rounded bg-muted px-1.5 py-0.5">{r}</span>
                          <Badge
                            variant="outline"
                            className={
                              "text-[10px] " +
                              (label.kind === "best-effort"
                                ? "border-amber-400 text-amber-700 dark:text-amber-300"
                                : "border-sky-400 text-sky-700 dark:text-sky-300")
                            }
                          >
                            {label.text}
                          </Badge>
                        </span>
                      );
                    })}
                  </dd>
                </>
              )}
            </dl>
          </div>
        );
      })}
    </div>
  );
}
