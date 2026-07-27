"use client";

// Operator panel for the Bedrock spend guardrail (budget-guardrail plan §4.7) —
// the STRUCTURAL ceiling under the capability gates. An action-enabled AWS
// Budget attaches a Deny policy to the capability-broker role on breach, after
// which nothing Starkeep runs can invoke Bedrock regardless of whether the
// broker's own checks are working.
//
// Rendered ABOVE CapabilityGatesSection: the hard ceiling should read before the
// soft ones. The seeded global gate's limit is shown beside the budget limit
// because the two are INDEPENDENT — only their defaults cohere — so displaying
// them together is the only thing that makes a divergence legible.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  readCloudConfig,
  readCloudCredentials,
  writeCloudCredentials,
  readCognitoSession,
  writeCognitoSession,
  credentialsNearExpiry,
} from "@/lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials, type STSCredentials } from "@/lib/cognito-auth";
import { formatMicrosAsUsd, assertMicros } from "@starkeep/protocol-primitives";

export interface BedrockBudgetView {
  exists: boolean;
  limitMicros: number | null;
  actualSpendMicros: number | null;
  forecastedSpendMicros: number | null;
  actionId: string | null;
  actionStatus: string | null;
  frozenRoleNames: string[];
  targetRoleNames: string[];
  lastExecuted: string | null;
  preferenceEnabled: boolean;
  preferenceLimitUsd: number;
  frozen: boolean;
  selfClearsAt: string;
  globalCostGateUsd: number | null;
}

type EditAction = "enable" | "disable" | "set-limit" | "freeze" | "resume";

/** Resolve operator STS creds (refreshing when stale), or null when the user
 * isn't signed in / cloud isn't configured. Mirrors the gates section. */
async function resolveOperatorCreds(): Promise<STSCredentials | null> {
  const cfg = await readCloudConfig();
  if (!cfg) return null;
  let creds = await readCloudCredentials();
  if (!creds || credentialsNearExpiry(creds)) {
    const session = await readCognitoSession();
    if (!session?.refreshToken) return null;
    try {
      const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
      creds = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
      await writeCloudCredentials(creds);
      await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
    } catch {
      return null;
    }
  }
  return creds;
}

function usd(micros: number | null): string {
  if (micros === null) return "—";
  return formatMicrosAsUsd(assertMicros(micros));
}

/**
 * Rendered in UTC, not the viewer's zone. AWS budget periods roll over on a UTC
 * month boundary, so a local-time render west of Greenwich would show the
 * self-clear date a day early — the one number on this panel the operator plans
 * around.
 */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

export function BedrockBudgetSection() {
  const [data, setData] = useState<BedrockBudgetView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not-signed-in" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limitDraft, setLimitDraft] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    const creds = await resolveOperatorCreds();
    if (!creds) {
      setState("not-signed-in");
      return;
    }
    try {
      const res = await fetch("/api/capabilities/bedrock-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `budget status failed: ${res.status}`);
      }
      const view = (await res.json()) as BedrockBudgetView;
      setData(view);
      setLimitDraft(String(view.preferenceLimitUsd));
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (action: EditAction, limitUsd?: number) => {
    setError(null);
    const creds = await resolveOperatorCreds();
    if (!creds) {
      setError("Not signed in.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/capabilities/bedrock-budget/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...creds, action, ...(limitUsd !== undefined ? { limitUsd } : {}) }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `${action} failed: ${res.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          A monthly AWS Budget that switches Bedrock off if spend crosses its limit. It works by
          removing the capability role&apos;s permission to call Bedrock, so it holds even if the
          limits below fail — it is the one ceiling that does not depend on Starkeep&apos;s own code
          being correct.
        </p>
        <Button size="sm" variant="outline" onClick={load} disabled={state === "loading" || busy}>
          Refresh
        </Button>
      </div>

      {state === "not-signed-in" && (
        <p className="text-sm text-muted-foreground">
          Sign in to the cloud to manage the spend guardrail.
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {state === "loading" && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      )}

      {state === "ready" && data && (
        <>
          {data.frozen && (
            <Alert variant="destructive">
              <AlertTitle>Bedrock is frozen — apps cannot use AI right now</AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-2">
                  <p>
                    The spend guardrail removed the capability role&apos;s Bedrock permission
                    {data.lastExecuted ? ` on ${shortDate(data.lastExecuted)}` : ""}. It lifts
                    itself when the new billing month begins on {shortDate(data.selfClearsAt)}, or
                    you can lift it now.
                  </p>
                  <div>
                    <Button size="sm" onClick={() => act("resume")} disabled={busy}>
                      Resume Bedrock now
                    </Button>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {!data.exists && data.preferenceEnabled && (
            // exists:false with enabled:true is an install that FAILED to create
            // the budget — a different problem from an operator who turned it
            // off, and it must not read the same.
            <Alert>
              <AlertTitle>The guardrail is switched on but no budget exists in AWS</AlertTitle>
              <AlertDescription>
                The install could not create it — most often because the bootstrap CloudFormation
                stack predates this feature and has no freeze policy for the budget to apply.
                Update the bootstrap stack, then enable it here.
              </AlertDescription>
            </Alert>
          )}

          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">Status</dt>
              <dd className="text-sm" data-testid="budget-status">
                {data.frozen
                  ? "Frozen"
                  : data.exists
                    ? "Armed"
                    : data.preferenceEnabled
                      ? "Not created"
                      : "Off"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                Monthly budget
              </dt>
              <dd className="text-sm tabular-nums" data-testid="budget-limit">
                {data.exists ? usd(data.limitMicros) : `$${data.preferenceLimitUsd} (not applied)`}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                Bedrock spend this month
              </dt>
              <dd className="text-sm tabular-nums" data-testid="budget-spend">
                {usd(data.actualSpendMicros)}
              </dd>
            </div>
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                Global spend limit (below)
              </dt>
              <dd className="text-sm tabular-nums" data-testid="budget-gate-limit">
                {data.globalCostGateUsd === null
                  ? "none — no global limit is set"
                  : `$${data.globalCostGateUsd}/month`}
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">
                Set independently of the budget above. It denies a request the moment spend crosses
                it, so it normally acts first; the budget is what remains if it doesn&apos;t.
              </p>
            </div>
          </dl>

          <div className="flex flex-wrap items-end gap-3">
            {data.preferenceEnabled ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium" htmlFor="bedrock-budget-limit">
                    Monthly limit ($)
                  </label>
                  <Input
                    id="bedrock-budget-limit"
                    aria-label="Monthly limit ($)"
                    className="w-32"
                    type="number"
                    min={1}
                    step="any"
                    value={limitDraft}
                    onChange={(e) => setLimitDraft(e.currentTarget.value)}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => act("set-limit", Number(limitDraft))}
                >
                  Save limit
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act("disable")}>
                  Turn guardrail off
                </Button>
                {!data.frozen && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("freeze")}>
                    Freeze Bedrock now
                  </Button>
                )}
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => act("enable")}>
                Turn guardrail on
              </Button>
            )}
          </div>

          {/* The honest caveats. A guardrail believed to do more than it does is
              worse than none, so these are not optional copy. */}
          <ul className="list-disc pl-5 text-xs text-muted-foreground flex flex-col gap-1">
            <li>
              Covers Bedrock spend that Starkeep brokers — not your whole AWS bill, and not an app
              that calls an AI provider directly on its own credentials.
            </li>
            <li>
              AWS cost data lags, so real spend can exceed the limit by roughly a day&apos;s worth
              before the freeze lands. The global limit below is the layer that acts immediately.
            </li>
            <li>
              A freeze lifts itself when the next billing month starts. In-flight jobs already
              submitted still run and still bill.
            </li>
            <li>
              If you delete the global spend limit below, the next install re-creates it. Editing
              its value is preserved.
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
