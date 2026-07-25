"use client";

// Operator editor for the capability model registry (plan §3.6). The registry
// is two-layered: a read-only PLATFORM registry shipped in the code plus sparse
// OPERATOR OVERRIDES in DSQL, with effective = override ?? platformDefault. This
// section lets the operator retune a platform model (pricing, inference profile,
// vision, image-token estimate) on AWS's cadence, define a brand-new model the
// platform doesn't know yet, or reset a model back to its platform default.

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
  MODEL_PROVIDERS,
  MODEL_OUTPUT_MODALITIES,
  PRICEABLE_DIMENSION_UNITS,
  priceUnitLabel,
  type ModelRow,
  type ModelOverrideInput,
} from "@/lib/capability-models";

type CredState = STSCredentials | null;

/** Resolve operator STS creds (refreshing when stale), or null when the user
 * isn't signed in / cloud isn't configured. Mirrors the dashboard cost fetch. */
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

/** The whole price table as compact `key $rate` lines — a model priced per
 * image or per second of video has no token rate to show in a token column. */
function priceLines(pricing: Record<string, number>): string[] {
  return Object.entries(pricing).map(([k, v]) => `${k} $${v}`);
}

export function CapabilityModelsSection() {
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not-signed-in" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: ModelRow | null; isNew: boolean } | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    const creds = await resolveOperatorCreds();
    if (!creds) { setState("not-signed-in"); return; }
    try {
      const res = await fetch("/api/capabilities/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `models list failed: ${res.status}`);
      }
      const body = (await res.json()) as { models: ModelRow[] };
      setRows(body.models);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveOverride = async (modelId: string, override: ModelOverrideInput): Promise<string | null> => {
    const creds = await resolveOperatorCreds();
    if (!creds) return "Not signed in.";
    const res = await fetch("/api/capabilities/models/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, modelId, override }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return b.error ?? `save failed: ${res.status}`;
    }
    await load();
    return null;
  };

  const clearOverride = async (modelId: string): Promise<string | null> => {
    const creds = await resolveOperatorCreds();
    if (!creds) return "Not signed in.";
    const res = await fetch("/api/capabilities/models/override", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, modelId }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      return b.error ?? `clear failed: ${res.status}`;
    }
    await load();
    return null;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Pricing and metering defaults for Bedrock models the capability broker can call.
          Override a platform model or define a new one without a platform release.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={state === "loading"}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => setEditing({ row: null, isNew: true })} disabled={state !== "ready"}>
            Add model
          </Button>
        </div>
      </div>

      {state === "not-signed-in" && (
        <p className="text-sm text-muted-foreground">Sign in to the cloud to manage the model registry.</p>
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

      {state === "ready" && rows && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Inference profile</TableHead>
                <TableHead className="text-center">Vision</TableHead>
                <TableHead>Output</TableHead>
                <TableHead>Pricing</TableHead>
                <TableHead className="text-right">Img tok</TableHead>
                <TableHead></TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const overridden = Object.keys(row.override).length > 0;
                const e = row.effective;
                return (
                  <TableRow key={row.modelId}>
                    <TableCell className="font-mono text-xs">{row.modelId}</TableCell>
                    <TableCell className="text-sm">{e.provider}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground max-w-[200px] truncate" title={e.inferenceProfileId ?? ""}>
                      {e.inferenceProfileId ?? "—"}
                    </TableCell>
                    <TableCell className="text-center">{e.vision ? "✓" : "—"}</TableCell>
                    <TableCell className="text-sm">{e.outputModality}</TableCell>
                    <TableCell className="font-mono text-[11px]">
                      {priceLines(e.pricing).length === 0 ? (
                        "—"
                      ) : (
                        <div className="flex flex-col">
                          {priceLines(e.pricing).map((l) => (
                            <span key={l}>{l}</span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{e.imageTokens ?? "—"}</TableCell>
                    <TableCell>
                      {row.source === "user" ? (
                        <Badge variant="outline" className="text-[10px] border-purple-400 text-purple-700 dark:text-purple-300">operator</Badge>
                      ) : overridden ? (
                        <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-700 dark:text-amber-300">overridden</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">platform</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ row, isNew: false })}>Edit</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {editing && (
        <ModelEditDialog
          row={editing.row}
          isNew={editing.isNew}
          existingIds={rows?.map((r) => r.modelId) ?? []}
          onClose={() => setEditing(null)}
          onSave={saveOverride}
          onClear={clearOverride}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit / add dialog — per-field override toggles (the sparse override model).
// ---------------------------------------------------------------------------

/** One editable price row. `key` is a `"dimension:unit"` pair; `value` is the
 * display rate ($/MTok for token keys, $/unit otherwise). */
interface PriceDraft {
  key: string;
  value: string;
}

interface Draft {
  modelId: string;
  provider: string;
  outputModality: string;
  overrideProfile: boolean;
  profileCleared: boolean;
  profileValue: string;
  overrideVision: boolean;
  visionValue: boolean;
  overridePricing: boolean;
  prices: PriceDraft[];
  overrideImageTokens: boolean;
  imageTokensValue: string;
}

function seedDraft(row: ModelRow | null, isNew: boolean): Draft {
  const o = row?.override ?? {};
  const eff = row?.effective;
  const num = (v: number | null | undefined): string => (v === null || v === undefined ? "" : String(v));
  // Seed the price table from the override when one exists, else from the
  // effective table — so toggling the override on and saving PRESERVES every
  // rate (including per-image / per-second ones) instead of dropping the keys
  // the editor doesn't happen to show.
  const seedPricing = o.pricing ?? eff?.pricing ?? {};
  const prices = Object.entries(seedPricing).map(([key, value]) => ({ key, value: String(value) }));
  return {
    modelId: isNew ? "" : row?.modelId ?? "",
    provider: (o.provider ?? eff?.provider ?? MODEL_PROVIDERS[0]) as string,
    outputModality: o.outputModality ?? eff?.outputModality ?? "text",
    overrideProfile: "inferenceProfileId" in o,
    profileCleared: o.inferenceProfileId === null,
    profileValue: typeof o.inferenceProfileId === "string" ? o.inferenceProfileId : (eff?.inferenceProfileId ?? ""),
    overrideVision: o.vision !== undefined,
    visionValue: o.vision ?? eff?.vision ?? false,
    overridePricing: o.pricing !== undefined,
    prices: prices.length > 0 ? prices : [{ key: "input:tokens", value: "" }, { key: "output:tokens", value: "" }],
    overrideImageTokens: o.imageTokens !== undefined,
    imageTokensValue: num(o.imageTokens ?? eff?.imageTokens),
  };
}

function ModelEditDialog({
  row,
  isNew,
  existingIds,
  onClose,
  onSave,
  onClear,
}: {
  row: ModelRow | null;
  isNew: boolean;
  existingIds: string[];
  onClose: () => void;
  onSave: (modelId: string, override: ModelOverrideInput) => Promise<string | null>;
  onClear: (modelId: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<Draft>(() => seedDraft(row, isNew));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // For a new operator-defined model everything is an override (no platform
  // default to inherit), so provider + pricing are the meaningful inputs.
  const buildOverride = (): { override: ModelOverrideInput } | { error: string } => {
    const override: ModelOverrideInput = {};
    if (isNew) {
      if (!draft.provider) return { error: "Provider is required for a new model." };
      override.provider = draft.provider;
      // Modality is a DEFINITION field, only meaningful for a new model — a
      // platform model's modality is intrinsic and the API rejects it.
      override.outputModality = draft.outputModality as ModelOverrideInput["outputModality"];
    }
    if (draft.overrideProfile) {
      const v = draft.profileCleared ? null : draft.profileValue.trim();
      override.inferenceProfileId = v ? v : null; // empty text = cleared
    }
    if (draft.overrideVision) override.vision = draft.visionValue;
    if (draft.overridePricing) {
      const pricing: Record<string, number> = {};
      for (const p of draft.prices) {
        if (!p.key) continue;
        if (p.key in pricing) return { error: `Duplicate price for "${p.key}".` };
        const n = Number(p.value);
        if (p.value.trim() === "" || !Number.isFinite(n) || n < 0) {
          return { error: `Rate for "${p.key}" must be a non-negative number.` };
        }
        pricing[p.key] = n;
      }
      // The two token rates are metered as a pair; sending half under-counts.
      const hasIn = "input:tokens" in pricing;
      const hasOut = "output:tokens" in pricing;
      if (hasIn !== hasOut) {
        return { error: "input and output $/MTok must be set together." };
      }
      override.pricing = pricing;
    }
    if (draft.overrideImageTokens) {
      const n = Number(draft.imageTokensValue);
      if (!Number.isInteger(n) || n < 0) return { error: "Image tokens must be a non-negative integer." };
      override.imageTokens = n;
    }
    return { override };
  };

  const handleSave = async () => {
    setErr(null);
    const modelId = isNew ? draft.modelId.trim() : row!.modelId;
    if (isNew) {
      if (!modelId) { setErr("Model id is required."); return; }
      if (existingIds.includes(modelId)) { setErr(`Model "${modelId}" already exists.`); return; }
    }
    const built = buildOverride();
    if ("error" in built) { setErr(built.error); return; }
    setBusy(true);
    const e = await onSave(modelId, built.override);
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };

  const handleClear = async () => {
    setErr(null);
    setBusy(true);
    const e = await onClear(row!.modelId);
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };

  const platform = row?.platform ?? null;
  const inherited = (v: string | number | boolean | null | undefined): string =>
    v === null || v === undefined || v === "" ? "platform default" : `platform: ${v}`;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add model" : `Edit ${row?.modelId}`}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isNew && (
            <>
              <Field label="Model id">
                <Input
                  placeholder="provider.model-id, e.g. anthropic.claude-haiku-4-5"
                  value={draft.modelId}
                  onChange={(e) => set("modelId", e.currentTarget.value)}
                />
              </Field>
              <Field label="Provider">
                <select
                  className="h-9 rounded-md border bg-transparent px-2 text-sm"
                  value={draft.provider}
                  onChange={(e) => set("provider", e.currentTarget.value)}
                >
                  {MODEL_PROVIDERS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <Field label="Output modality">
                <select
                  aria-label="Output modality"
                  className="h-9 rounded-md border bg-transparent px-2 text-sm"
                  value={draft.outputModality}
                  onChange={(e) => set("outputModality", e.currentTarget.value)}
                >
                  {MODEL_OUTPUT_MODALITIES.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Decides the delivery channel: text is returned inline or streamed, image comes back
                  synchronously and is written to S3, audio/video use the async job path.
                </p>
              </Field>
            </>
          )}

          {/* Pricing — the whole per-(dimension:unit) table, not just tokens:
              Bedrock prices image generation per request and video per second. */}
          <OverrideField
            label="Pricing"
            enabled={draft.overridePricing}
            onToggle={(v) => set("overridePricing", v)}
            hint={
              platform
                ? Object.keys(platform.pricing).length > 0
                  ? `platform: ${Object.entries(platform.pricing).map(([k, v]) => `${k} $${v}`).join(", ")}`
                  : "platform default"
                : undefined
            }
          >
            <div className="flex flex-col gap-2">
              {draft.prices.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    aria-label="Price dimension"
                    className="h-9 rounded-md border bg-transparent px-2 text-xs font-mono"
                    value={p.key}
                    onChange={(e) => {
                      const key = e.currentTarget.value;
                      setDraft((d) => ({
                        ...d,
                        prices: d.prices.map((q, j) => (j === i ? { ...q, key } : q)),
                      }));
                    }}
                  >
                    {PRICEABLE_DIMENSION_UNITS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <Input
                    className="w-28"
                    type="number"
                    min={0}
                    step="0.000001"
                    aria-label={`Rate for ${p.key}`}
                    value={p.value}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setDraft((d) => ({
                        ...d,
                        prices: d.prices.map((q, j) => (j === i ? { ...q, value } : q)),
                      }));
                    }}
                  />
                  <span className="text-muted-foreground text-xs w-16">{priceUnitLabel(p.key)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${p.key}`}
                    onClick={() =>
                      setDraft((d) => ({ ...d, prices: d.prices.filter((_, j) => j !== i) }))
                    }
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    prices: [
                      ...d.prices,
                      {
                        key:
                          PRICEABLE_DIMENSION_UNITS.find(
                            (k) => !d.prices.some((p) => p.key === k),
                          ) ?? PRICEABLE_DIMENSION_UNITS[0]!,
                        value: "",
                      },
                    ],
                  }))
                }
              >
                Add rate
              </Button>
            </div>
          </OverrideField>

          {/* Inference profile */}
          <OverrideField
            label="Inference profile"
            enabled={draft.overrideProfile}
            onToggle={(v) => set("overrideProfile", v)}
            hint={platform ? inherited(platform.inferenceProfileId) : undefined}
          >
            <div className="flex flex-col gap-1.5">
              <Input placeholder="us.provider.model-id  (blank = none)"
                disabled={!draft.overrideProfile || draft.profileCleared}
                value={draft.profileValue}
                onChange={(e) => set("profileValue", e.currentTarget.value)} />
              <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
                <input type="checkbox" className="h-3.5 w-3.5" disabled={!draft.overrideProfile}
                  checked={draft.profileCleared}
                  onChange={(e) => set("profileCleared", e.currentTarget.checked)} />
                No profile (invoke as a bare foundation model)
              </label>
            </div>
          </OverrideField>

          {/* Vision */}
          <OverrideField
            label="Vision"
            enabled={draft.overrideVision}
            onToggle={(v) => set("overrideVision", v)}
            hint={platform ? inherited(platform.vision) : undefined}
          >
            <label className="flex items-center gap-2 text-sm select-none">
              <input type="checkbox" className="h-4 w-4" disabled={!draft.overrideVision}
                checked={draft.visionValue}
                onChange={(e) => set("visionValue", e.currentTarget.checked)} />
              Accepts image input
            </label>
          </OverrideField>

          {/* Image token estimate */}
          <OverrideField
            label="Image token estimate"
            enabled={draft.overrideImageTokens}
            onToggle={(v) => set("overrideImageTokens", v)}
            hint={platform ? inherited(platform.imageTokens) : undefined}
          >
            <Input className="w-32" type="number" min={0} step="1" placeholder="tokens"
              disabled={!draft.overrideImageTokens} value={draft.imageTokensValue}
              onChange={(e) => set("imageTokensValue", e.currentTarget.value)} />
          </OverrideField>

          {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

          <div className="flex items-center justify-between gap-3">
            {!isNew ? (
              <Button variant="ghost" className="text-destructive hover:text-destructive"
                onClick={handleClear} disabled={busy}>
                {row?.source === "user" ? "Delete model" : "Reset to platform"}
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

/** A labelled field with an "Override" toggle; children are disabled until the
 * operator opts to override (matching the sparse override ?? default model). */
function OverrideField({
  label,
  enabled,
  onToggle,
  hint,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm font-medium select-none">
          <input type="checkbox" className="h-4 w-4" checked={enabled} onChange={(e) => onToggle(e.currentTarget.checked)} />
          {label}
        </label>
        {hint && !enabled && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {enabled && <div className="pl-6">{children}</div>}
    </div>
  );
}
