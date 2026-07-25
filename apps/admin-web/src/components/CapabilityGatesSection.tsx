"use client";

// Operator editor for capability usage gates (plan §3.5) — the cost-governance
// control. A gate is (dimension, unit, scope, window, limit); every gate whose
// scope matches a request is evaluated and ANY breach denies it (429). Before
// this existed the only gate anyone could write was the one derived from an
// app's own manifest budget at install, so the operator had no way to set a
// global cap, a per-provider cap, or a tighter cap than an app asked for.
//
// Consent gates are listed read-only: a reinstall re-upserts their limit from
// the manifest, so tightening one here would silently revert. The operator
// tightens by ADDING a gate — independent gates compose, strictest wins.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  readCloudConfig,
  readCloudCredentials,
  writeCloudCredentials,
  readCognitoSession,
  writeCognitoSession,
  credentialsNearExpiry,
} from "@/lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials, type STSCredentials } from "@/lib/cognito-auth";
import {
  gateCaveat,
  describeScope,
  describeWindow,
  type GateDimensionOption,
  type GateInput,
  type GateListResponse,
  type GateView,
} from "@/lib/capability-gates";

type CredState = STSCredentials | null;

/** Resolve operator STS creds (refreshing when stale), or null when the user
 * isn't signed in / cloud isn't configured. Mirrors the models section. */
async function resolveOperatorCreds(): Promise<CredState> {
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

export function CapabilityGatesSection() {
  const [data, setData] = useState<GateListResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not-signed-in" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ gate: GateView | null } | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    const creds = await resolveOperatorCreds();
    if (!creds) { setState("not-signed-in"); return; }
    try {
      const res = await fetch("/api/capabilities/gates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `gate list failed: ${res.status}`);
      }
      setData((await res.json()) as GateListResponse);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveGate = async (gate: GateInput): Promise<string | null> => {
    const creds = await resolveOperatorCreds();
    if (!creds) return "Not signed in.";
    const res = await fetch("/api/capabilities/gates/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, gate }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return b.error ?? `save failed: ${res.status}`;
    }
    await load();
    return null;
  };

  const deleteGate = async (gateId: string): Promise<string | null> => {
    const creds = await resolveOperatorCreds();
    if (!creds) return "Not signed in.";
    const res = await fetch("/api/capabilities/gates/edit", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, gateId }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return b.error ?? `delete failed: ${res.status}`;
    }
    await load();
    return null;
  };

  const dimensionByKey = new Map((data?.dimensions ?? []).map((d) => [`${d.dimension}:${d.unit}`, d]));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Spend and usage limits for the capability broker. Every gate matching a request is
          checked and any breach denies it — so limits compose, and the strictest one wins.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={state === "loading"}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => setEditing({ gate: null })} disabled={state !== "ready"}>
            Add gate
          </Button>
        </div>
      </div>

      {state === "not-signed-in" && (
        <p className="text-sm text-muted-foreground">Sign in to the cloud to manage usage gates.</p>
      )}
      {state === "error" && (
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

      {state === "ready" && data && data.gates.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No gates configured — capability spend is unbounded except for any budget an installed
          app requested for itself.
        </p>
      )}

      {state === "ready" && data && data.gates.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Capability</TableHead>
                <TableHead>Meters</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Window</TableHead>
                <TableHead className="text-right">Limit</TableHead>
                <TableHead></TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.gates.map((gate) => {
                const key = `${gate.dimension}:${gate.unit}`;
                const option = dimensionByKey.get(key);
                const caveat = option ? gateCaveat(option) : null;
                return (
                  <TableRow key={gate.id}>
                    <TableCell className="text-sm">{gate.capabilityName}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {key}
                      {caveat && (
                        <span className="ml-2 text-[10px] text-amber-700 dark:text-amber-300" title={caveat}>
                          app-reported
                        </span>
                      )}
                      {!option && (
                        <span className="ml-2 text-[10px] text-destructive" title="Not a metered pair — this gate never sums and enforces nothing.">
                          unmetered
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{describeScope(gate.scope)}</TableCell>
                    <TableCell className="text-xs">{describeWindow(gate.window)}</TableCell>
                    <TableCell className="text-right tabular-nums">{gate.limit}</TableCell>
                    <TableCell>
                      {gate.origin === "app-consent" ? (
                        <Badge variant="outline" className="text-[10px] border-sky-400 text-sky-700 dark:text-sky-300">app consent</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">operator</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {gate.editable ? (
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ gate })}>Edit</Button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground pr-2" title="Set by the app's install-time consent budget; a reinstall rewrites it. Add your own gate to tighten.">
                          read-only
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {editing && data && (
        <GateEditDialog
          gate={editing.gate}
          options={data.dimensions}
          capabilities={data.capabilities}
          providers={data.providers}
          onClose={() => setEditing(null)}
          onSave={saveGate}
          onDelete={deleteGate}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit dialog
// ---------------------------------------------------------------------------

interface Draft {
  capabilityName: string;
  dimensionKey: string;
  windowKind: "calendar" | "burst";
  period: "week" | "month";
  seconds: string;
  limit: string;
  provider: string;
  model: string;
  appId: string;
}

function seedDraft(gate: GateView | null, capabilities: string[], options: GateDimensionOption[]): Draft {
  return {
    capabilityName: gate?.capabilityName ?? capabilities[0] ?? "",
    dimensionKey: gate ? `${gate.dimension}:${gate.unit}` : (options[0]?.key ?? "cost:usd"),
    windowKind: gate?.window.kind ?? "calendar",
    period: gate?.window.kind === "calendar" ? gate.window.period : "month",
    seconds: gate?.window.kind === "burst" ? String(gate.window.seconds) : "60",
    limit: gate ? String(gate.limit) : "",
    provider: gate?.scope.provider ?? "",
    model: gate?.scope.model ?? "",
    appId: gate?.scope.appId ?? "",
  };
}

function GateEditDialog({
  gate,
  options,
  capabilities,
  providers,
  onClose,
  onSave,
  onDelete,
}: {
  gate: GateView | null;
  options: GateDimensionOption[];
  capabilities: string[];
  providers: string[];
  onClose: () => void;
  onSave: (gate: GateInput) => Promise<string | null>;
  onDelete: (gateId: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<Draft>(() => seedDraft(gate, capabilities, options));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const option = options.find((o) => o.key === draft.dimensionKey);
  const caveat = option ? gateCaveat(option) : null;

  const build = (): { gate: GateInput } | { error: string } => {
    const [dimension, unit] = draft.dimensionKey.split(":");
    if (!dimension || !unit) return { error: "Pick what the gate meters." };
    const limit = Number(draft.limit);
    if (draft.limit.trim() === "" || !Number.isFinite(limit) || limit < 0) {
      return { error: "Limit must be a non-negative number." };
    }
    let window: GateInput["window"];
    if (draft.windowKind === "burst") {
      const seconds = Number(draft.seconds);
      if (!Number.isInteger(seconds) || seconds < 1) {
        return { error: "Burst window must be a positive whole number of seconds." };
      }
      window = { kind: "burst", seconds };
    } else {
      window = { kind: "calendar", period: draft.period };
    }
    return {
      gate: {
        ...(gate ? { id: gate.id } : {}),
        capabilityName: draft.capabilityName,
        dimension,
        unit,
        scope: {
          ...(draft.provider ? { provider: draft.provider } : {}),
          ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
          ...(draft.appId.trim() ? { appId: draft.appId.trim() } : {}),
        },
        window,
        limit,
      },
    };
  };

  const handleSave = async () => {
    setErr(null);
    const built = build();
    if ("error" in built) { setErr(built.error); return; }
    setBusy(true);
    const e = await onSave(built.gate);
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };

  const handleDelete = async () => {
    setErr(null);
    setBusy(true);
    const e = await onDelete(gate!.id);
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{gate ? "Edit gate" : "Add gate"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Capability">
            <select
              aria-label="Capability"
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
              value={draft.capabilityName}
              onChange={(e) => set("capabilityName", e.currentTarget.value)}
            >
              {capabilities.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>

          <Field label="Meters">
            <select
              aria-label="Meters"
              className="h-9 rounded-md border bg-transparent px-2 text-sm font-mono"
              value={draft.dimensionKey}
              onChange={(e) => set("dimensionKey", e.currentTarget.value)}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>{o.key}</option>
              ))}
            </select>
            {caveat ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {caveat}. A gate on this also DENIES any app that hasn&apos;t declared it in its
                manifest.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Measured by the broker — holds even against a misbehaving app.
              </p>
            )}
          </Field>

          <Field label="Limit">
            <Input
              className="w-40"
              type="number"
              min={0}
              step="any"
              aria-label="Limit"
              value={draft.limit}
              onChange={(e) => set("limit", e.currentTarget.value)}
            />
          </Field>

          <Field label="Window">
            <div className="flex items-center gap-2">
              <select
                aria-label="Window kind"
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
                value={draft.windowKind}
                onChange={(e) => set("windowKind", e.currentTarget.value as Draft["windowKind"])}
              >
                <option value="calendar">calendar</option>
                <option value="burst">burst</option>
              </select>
              {draft.windowKind === "calendar" ? (
                <select
                  aria-label="Calendar period"
                  className="h-9 rounded-md border bg-transparent px-2 text-sm"
                  value={draft.period}
                  onChange={(e) => set("period", e.currentTarget.value as Draft["period"])}
                >
                  <option value="month">month</option>
                  <option value="week">week</option>
                </select>
              ) : (
                <>
                  <Input
                    className="w-28"
                    type="number"
                    min={1}
                    step="1"
                    aria-label="Burst seconds"
                    value={draft.seconds}
                    onChange={(e) => set("seconds", e.currentTarget.value)}
                  />
                  <span className="text-muted-foreground text-sm">seconds</span>
                </>
              )}
            </div>
          </Field>

          <Field label="Scope">
            <p className="text-xs text-muted-foreground">
              Leave a field blank to match everything. All blank = a global limit.
            </p>
            <div className="flex flex-col gap-2">
              <select
                aria-label="Scope provider"
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
                value={draft.provider}
                onChange={(e) => set("provider", e.currentTarget.value)}
              >
                <option value="">any provider</option>
                {providers.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <Input placeholder="any model" aria-label="Scope model"
                value={draft.model} onChange={(e) => set("model", e.currentTarget.value)} />
              <Input placeholder="any app" aria-label="Scope app"
                value={draft.appId} onChange={(e) => set("appId", e.currentTarget.value)} />
            </div>
          </Field>

          {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

          <div className="flex items-center justify-between gap-3">
            {gate ? (
              <Button variant="ghost" className="text-destructive hover:text-destructive"
                onClick={handleDelete} disabled={busy}>
                Delete gate
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button onClick={handleSave} disabled={busy}>
                {busy && <span className="mr-2 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}
