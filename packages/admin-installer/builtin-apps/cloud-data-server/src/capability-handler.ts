/**
 * The capability broker route handler (plan §3.4), code-isolated from the
 * data-path handlers so a bug here can't corrupt data-plane auth.
 *
 * Flow for `POST /capabilities/:name/invoke` (auth + appId already established
 * by the caller):
 *   1. load the app's capability grant → 403 if none;
 *   2. resolve the requested model against the effective registry + validate it
 *      is in the grant's approved set → 403/400;
 *   3. read the referenced content BY REFERENCE under the app's own role (the
 *      source of truth for what the app may feed Bedrock) — no inline bytes from
 *      the caller;
 *   4. GATE CHOKEPOINT (reserve-on-ledger): fail-closed on undeclared non-generic
 *      gates, reserve the worst-case projection, then SUM-check every matching
 *      gate → 429 on breach;
 *   5. assume the capability-broker role (single hop) and invoke Bedrock;
 *   6. reconcile the ledger to actual token usage and return the text result.
 *
 * Written against injected dependencies (content read, DSQL client, credential
 * assume, Bedrock invoker) so it is exercised directly in unit tests without AWS
 * and wired into api-handler.ts for production.
 */

import {
  effectiveModel,
  bedrockInvokeTarget,
  buildCapabilityGrant,
  canInvokeModel,
  evaluateGates,
  projectReservation,
  reconcileMeasurements,
  gateMatches,
  isNonGenericDimensionUnit,
  dimensionUnitKey,
  CAPABILITY_BEDROCK_INVOKE,
  type RequestModality,
  type CapabilityRequestContext,
  type EffectiveModel,
} from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  loadCapabilityGrant,
  loadGates,
  loadModelOverrides,
  reserve,
  reconcile,
  release,
  sumForGate,
  lookupInvocation,
  appendReportedOutput,
  type LedgerKey,
} from "./capability-store.js";
import type { BedrockImageInput, BedrockInvoker } from "./bedrock-client.js";

export interface CapabilityInvokeBody {
  model?: string;
  prompt?: string;
  /** Cloud-stored item to feed Bedrock, by reference (record id or object key). */
  contentRef?: { recordId?: string; objectKey?: string };
  maxTokens?: number;
  modality?: RequestModality;
  /** App-reported non-generic input quantities, keyed by "dimension:unit". */
  reports?: Record<string, number>;
}

/** Bytes + shape of a by-reference content item, resolved under the app role. */
export interface ResolvedContent {
  bytes: Uint8Array;
  sizeBytes: number;
  image?: BedrockImageInput;
}

export interface ContentReadResult {
  ok: boolean;
  status?: number;
  message?: string;
  content?: ResolvedContent;
}

export interface CapabilityCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface CapabilityHandlerDeps {
  appId: string;
  capabilityName: string;
  body: CapabilityInvokeBody;
  /** Per-app DSQL connection (PUBLIC SELECT on capability tables; ledger write). */
  capClient: DatabaseClient;
  /** Read the referenced item under the app's own role + grants. Omit for a
   * text-only request (no contentRef). */
  readContent: (ref: NonNullable<CapabilityInvokeBody["contentRef"]>) => Promise<ContentReadResult>;
  /** Assume the capability-broker role (single hop, per request). */
  assumeCapabilityCreds: () => Promise<CapabilityCreds>;
  invoker: BedrockInvoker;
  region: string;
  nowMs?: () => number;
  timeZone?: string;
}

export interface CapabilityHandlerResponse {
  statusCode: number;
  body: unknown;
}

const DEFAULT_MAX_TOKENS = 1024;
// Hard ceiling on the reservation regardless of gates, so an absurd max_tokens
// can't project a runaway reservation even when no output gate is set.
const HARD_MAX_TOKENS = 8192;

/** Rough pre-call token estimate for prompt text (Bedrock returns the exact
 * count post-call; this only sizes the reservation). */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A prepared, gate-cleared request with a LIVE ledger reservation that the
 * caller MUST reconcile (success) or release (failure). */
interface PreparedInvoke {
  model: EffectiveModel;
  ctx: CapabilityRequestContext;
  content?: ResolvedContent;
  maxTokens: number;
  ledgerKey: LedgerKey;
  invocationId: string;
  /** App-reported non-generic INPUT quantities (declared + filtered). */
  appReports: Record<string, number>;
}

type PrepareResult =
  | { ok: false; response: CapabilityHandlerResponse }
  | { ok: true; prepared: PreparedInvoke };

/**
 * Shared pre-flight for the buffered and streaming invoke paths — plan §3.4
 * steps 1–4, i.e. everything up to (but not including) the Bedrock call:
 * validate capability + model, read the referenced content under the app's own
 * role, fail-closed on undeclared non-generic gates, RESERVE the worst-case
 * projection on the ledger, then SUM-check every matching gate.
 *
 * Because the reservation covers the full `maxTokens` output ceiling AND the
 * gate check passes against it, the subsequent invoke — buffered OR streamed —
 * provably cannot push any gate past its limit. That is precisely what lets the
 * streaming path reuse this unchanged: worst-case reservation already gives the
 * "can't blow the gate" guarantee, so a mid-stream abort would be redundant for
 * safety; streaming only adds incremental delivery + reconcile-to-actuals.
 *
 * Returns a rejection response OR the prepared request holding a live
 * reservation the caller is obligated to reconcile/release.
 */
async function prepareInvoke(
  deps: CapabilityHandlerDeps,
  nowMs: () => number,
  timeZone: string,
): Promise<PrepareResult> {
  const { appId, capabilityName, body, capClient } = deps;
  const reject = (statusCode: number, bodyObj: unknown): PrepareResult => ({
    ok: false,
    response: { statusCode, body: bodyObj },
  });

  // Only bedrock.invoke is wired; unknown capability names 404 at the router.
  if (capabilityName !== CAPABILITY_BEDROCK_INVOKE) {
    return reject(404, { error: `Unknown capability: ${capabilityName}` });
  }
  if (!body.model) return reject(400, { error: "model is required" });
  if (!body.prompt) return reject(400, { error: "prompt is required" });

  // (1) Grant.
  const grantRow = await loadCapabilityGrant(capClient, appId, capabilityName);
  if (!grantRow) {
    // Well-defined "not granted" result the app can branch on (degraded mode).
    return reject(403, { error: "not_granted", capability: capabilityName });
  }
  const grant = buildCapabilityGrant(grantRow);

  // (2) Model: approved by grant + resolvable in the effective registry.
  if (!canInvokeModel(grant, body.model)) {
    return reject(403, { error: "model_not_granted", model: body.model });
  }
  const overrides = await loadModelOverrides(capClient);
  const model = effectiveModel(body.model, overrides);
  if (!model) {
    return reject(400, { error: "unknown_model", model: body.model });
  }

  // (3) By-reference content read under the app's own role (source of truth for
  // what the app may feed Bedrock). Text-only requests skip this.
  let content: ResolvedContent | undefined;
  if (body.contentRef) {
    const read = await deps.readContent(body.contentRef);
    if (!read.ok) {
      return reject(read.status ?? 403, { error: read.message ?? "forbidden" });
    }
    content = read.content;
  }

  const modality: RequestModality = body.modality ?? (content?.image ? "image" : "text");
  const ctx: CapabilityRequestContext = {
    appId,
    provider: model.provider,
    model: body.model,
    modality,
  };

  // App-reported input quantities, filtered to what the app actually DECLARED
  // (grant.reports) and to non-generic dimensions — an undeclared/generic value
  // is ignored, never metered.
  const appReports: Record<string, number> = {};
  for (const [key, value] of Object.entries(body.reports ?? {})) {
    const [dim, unit] = key.split(":");
    if (
      dim &&
      unit &&
      grant.reports.has(key) &&
      isNonGenericDimensionUnit(dim, unit) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      appReports[key] = value;
    }
  }

  const maxTokens = Math.min(HARD_MAX_TOKENS, Math.max(1, body.maxTokens ?? DEFAULT_MAX_TOKENS));

  // (4) Gate chokepoint.
  const gates = await loadGates(capClient, capabilityName);

  // (4a) Fail-closed BEFORE reserving: a matching gate on a non-generic
  // dimension the app didn't declare can't be honestly metered → deny.
  for (const gate of gates) {
    if (!gateMatches(gate, ctx)) continue;
    const key = dimensionUnitKey(gate.dimension, gate.unit);
    if (isNonGenericDimensionUnit(gate.dimension, gate.unit) && !grant.reports.has(key)) {
      return reject(403, {
        error: "undeclared_dimension",
        dimension: gate.dimension,
        unit: gate.unit,
      });
    }
  }

  const projected = projectReservation({
    model,
    ctx,
    inputBytes: content?.sizeBytes,
    imageCount: content?.image ? 1 : 0,
    inputTextTokenEstimate: estimateTextTokens(body.prompt),
    maxTokens,
    appReports,
  });

  const invocationId = `${appId}:${capabilityName}:${nowMs()}:${Math.random().toString(36).slice(2, 10)}`;
  const ledgerKey: LedgerKey = {
    invocationId,
    appId,
    capabilityName,
    provider: model.provider,
    model: body.model,
  };

  // (4b) Reserve the worst-case projection (own distinct rows → no OCC hotspot).
  await reserve(capClient, ledgerKey, projected);

  // (4c) SUM-check every matching gate, INCLUDING this reservation (projected: []
  // → the decision is `windowSum > limit`, where the sum already counts our own
  // reserved rows). Reserve-on-ledger bounds concurrent overage to burst × reserve.
  const decision = await evaluateGates({
    gates,
    ctx,
    appReports: grant.reports,
    projected: [],
    getSum: (gate) => sumForGate(capClient, gate, nowMs(), timeZone),
  });
  if (!decision.allowed) {
    await release(capClient, invocationId);
    return reject(429, {
      error: "gate_exceeded",
      breaches: decision.breaches.map((b) => ({
        dimension: b.gate.dimension,
        unit: b.gate.unit,
        limit: b.gate.limit,
        current: b.current,
      })),
    });
  }

  return { ok: true, prepared: { model, ctx, content, maxTokens, ledgerKey, invocationId, appReports } };
}

export async function handleCapabilityInvoke(
  deps: CapabilityHandlerDeps,
): Promise<CapabilityHandlerResponse> {
  const nowMs = deps.nowMs ?? Date.now;
  const timeZone = deps.timeZone ?? "UTC";
  const prep = await prepareInvoke(deps, nowMs, timeZone);
  if (!prep.ok) return prep.response;
  const { model, ctx, content, maxTokens, ledgerKey, invocationId, appReports } = prep.prepared;
  const { capClient, invoker, body } = deps;

  // (5) Assume the capability-broker role and invoke Bedrock.
  let result;
  try {
    const creds = await deps.assumeCapabilityCreds();
    result = await invoker.converse({
      target: bedrockInvokeTarget(model),
      region: deps.region,
      provider: model.provider,
      prompt: body.prompt!,
      images: content?.image ? [content.image] : undefined,
      maxTokens,
      credentials: creds,
    });
  } catch (err) {
    // Failed/aborted call must not hold a reservation.
    await release(capClient, invocationId);
    return {
      statusCode: 502,
      body: { error: "invoke_failed", message: err instanceof Error ? err.message : String(err) },
    };
  }

  // (6) Reconcile to actuals + return.
  const outputBytes = Buffer.byteLength(result.text, "utf8");
  const reconciled = reconcileMeasurements({
    model,
    ctx,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    inputBytes: content?.sizeBytes,
    outputBytes,
    appReports, // app-reported OUTPUT quantities arrive via a later report call
  });
  await reconcile(capClient, ledgerKey, reconciled);

  const estCostUsd =
    reconciled.find((m) => m.dimension === "cost" && m.unit === "usd")?.quantity ?? 0;

  return {
    statusCode: 200,
    body: {
      model: body.model,
      text: result.text,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      estCostUsd,
      invocationId,
    },
  };
}

/** SSE events emitted by the streaming broker path (plan §3.6/§3.7). */
export type CapabilityStreamEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      model: string;
      usage: { inputTokens: number; outputTokens: number };
      estCostUsd: number;
      invocationId: string;
    }
  | { type: "error"; status: number; error: string; message?: string };

export type CapabilityStreamResult =
  | { ok: false; response: CapabilityHandlerResponse }
  | { ok: true; invocationId: string; stream: AsyncGenerator<CapabilityStreamEvent> };

/**
 * Streaming sibling of {@link handleCapabilityInvoke} (plan §3.6/§3.7). All
 * pre-flight (grant/model/content/gate reservation) runs FIRST via the shared
 * {@link prepareInvoke}; if it rejects, the caller emits a normal buffered error
 * response and never opens the SSE stream (so a 403/429 keeps its real status
 * code — you can't change status once streaming has begun).
 *
 * Once cleared, `stream` yields `text` chunks as Bedrock produces them and a
 * terminal `done` (usage + derived cost + invocationId) after the ledger is
 * reconciled to actuals. A mid-invoke failure releases the reservation and
 * yields a single `error` event. The worst-case reservation from prepareInvoke
 * already bounds spend, so there is no separate mid-stream gate abort.
 */
export async function handleCapabilityInvokeStream(
  deps: CapabilityHandlerDeps,
): Promise<CapabilityStreamResult> {
  const nowMs = deps.nowMs ?? Date.now;
  const timeZone = deps.timeZone ?? "UTC";
  const prep = await prepareInvoke(deps, nowMs, timeZone);
  if (!prep.ok) return { ok: false, response: prep.response };
  const { model, ctx, content, maxTokens, ledgerKey, invocationId, appReports } = prep.prepared;
  const { capClient, invoker, body } = deps;

  async function* stream(): AsyncGenerator<CapabilityStreamEvent> {
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const creds = await deps.assumeCapabilityCreds();
      for await (const evt of invoker.converseStream({
        target: bedrockInvokeTarget(model),
        region: deps.region,
        provider: model.provider,
        prompt: body.prompt!,
        images: content?.image ? [content.image] : undefined,
        maxTokens,
        credentials: creds,
      })) {
        if (evt.type === "text" && evt.text) {
          text += evt.text;
          yield { type: "text", text: evt.text };
        } else if (evt.type === "done") {
          inputTokens = evt.inputTokens ?? 0;
          outputTokens = evt.outputTokens ?? 0;
        }
      }
    } catch (err) {
      // Failed/aborted stream must not hold a reservation.
      await release(capClient, invocationId);
      yield {
        type: "error",
        status: 502,
        error: "invoke_failed",
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    // Reconcile to actuals on stream completion.
    const outputBytes = Buffer.byteLength(text, "utf8");
    const reconciled = reconcileMeasurements({
      model,
      ctx,
      inputTokens,
      outputTokens,
      inputBytes: content?.sizeBytes,
      outputBytes,
      appReports,
    });
    await reconcile(capClient, ledgerKey, reconciled);
    const estCostUsd =
      reconciled.find((m) => m.dimension === "cost" && m.unit === "usd")?.quantity ?? 0;

    yield {
      type: "done",
      model: body.model!,
      usage: { inputTokens, outputTokens },
      estCostUsd,
      invocationId,
    };
  }

  return { ok: true, invocationId, stream: stream() };
}

export interface CapabilityReportDeps {
  appId: string;
  capabilityName: string;
  invocationId: string;
  reports: Record<string, number>;
  capClient: DatabaseClient;
}

/**
 * Best-effort app-reported OUTPUT reconciliation (plan §3.7). Appends committed
 * ledger rows for the app-reported non-generic OUTPUT quantities on a completed
 * invocation. Only declared dimensions are accepted; unknown/undeclared/generic
 * reports are ignored. A missing report simply leaves best-effort output gates
 * un-updated — it never hard-blocks.
 */
export async function handleCapabilityReport(
  deps: CapabilityReportDeps,
): Promise<CapabilityHandlerResponse> {
  const { appId, capabilityName, invocationId, reports, capClient } = deps;
  if (capabilityName !== CAPABILITY_BEDROCK_INVOKE) {
    return { statusCode: 404, body: { error: `Unknown capability: ${capabilityName}` } };
  }
  const grantRow = await loadCapabilityGrant(capClient, appId, capabilityName);
  if (!grantRow) return { statusCode: 403, body: { error: "not_granted" } };
  const grant = buildCapabilityGrant(grantRow);

  const invocation = await lookupInvocation(capClient, invocationId, appId);
  if (!invocation) return { statusCode: 404, body: { error: "unknown_invocation" } };

  const measurements = [];
  for (const [key, value] of Object.entries(reports)) {
    const [dim, unit] = key.split(":");
    if (
      dim === "output" &&
      unit &&
      grant.reports.has(key) &&
      isNonGenericDimensionUnit(dim, unit) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      measurements.push({ dimension: dim, unit, quantity: value });
    }
  }
  if (measurements.length > 0) {
    await appendReportedOutput(
      capClient,
      {
        invocationId,
        appId,
        capabilityName,
        provider: invocation.provider,
        model: invocation.model,
      },
      measurements,
    );
  }
  return { statusCode: 200, body: { ok: true, recorded: measurements.length } };
}
