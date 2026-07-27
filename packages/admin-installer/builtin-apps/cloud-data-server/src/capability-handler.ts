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
  outputIsAsyncS3,
  outputDelivery,
  buildCapabilityGrant,
  canInvokeModel,
  evaluateGates,
  projectReservation,
  projectAsyncReservation,
  reconcileMeasurements,
  gateMatches,
  isNonGenericDimensionUnit,
  dimensionUnitKey,
  CAPABILITY_BEDROCK_INVOKE,
  COST_DIMENSION,
  COST_UNIT,
  isQuantity,
  type RequestModality,
  type CapabilityRequestContext,
  type EffectiveModel,
  type Measurement,
} from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  loadCapabilityGrant,
  loadGates,
  loadModelOverrides,
  reserve,
  reconcile,
  release,
  commitReservation,
  sumForGate,
  lookupInvocation,
  appendReportedOutput,
  insertAsyncJob,
  loadAsyncJob,
  markAsyncJobStatus,
  type LedgerKey,
} from "./capability-store.js";
import type {
  BedrockImageInput,
  BedrockInvoker,
  BedrockImageInvoker,
  BedrockAsyncInvoker,
  AsyncGenerationParams,
  ImageGenerationParams,
} from "./bedrock-client.js";

export interface CapabilityInvokeBody {
  model?: string;
  prompt?: string;
  /** Cloud-stored item to feed Bedrock, by reference (record id or object key). */
  contentRef?: { recordId?: string; objectKey?: string };
  maxTokens?: number;
  modality?: RequestModality;
  /** Generation params for a `sync-s3` image model (Nova Canvas). Ignored for
   * text models. */
  generation?: ImageGenerationParams;
  /** App-reported non-generic input quantities, keyed by "dimension:unit". */
  reports?: Record<string, number>;
}

/** One image the CDS wrote to the app's S3 area (sync-s3 output, plan §3.8). */
export interface SyncImageOutput {
  bucket: string;
  keyPrefix: string;
  keys: string[];
  totalBytes: number;
}

/**
 * A by-reference content item resolved under the app role. Delivered to Bedrock
 * one of two ways (plan §3.4, "pick per request size"):
 *  - INLINE: `image` carries the base64 bytes the CDS read under the app role.
 *  - S3 LOCATION: `image` carries an s3Uri and `s3Key` names the concrete
 *    bucket/key the broker must scope the capability role's per-assume session
 *    policy to (the single-key belt from open-question 10's TC1). Bedrock reads
 *    the object under the capability role, so the object was NOT downloaded here.
 */
export interface ResolvedContent {
  sizeBytes: number;
  image?: BedrockImageInput;
  /** Set only on the S3-location path — the key to scope the session policy to. */
  s3Key?: { bucket: string; key: string };
}

/** The S3 keys/prefixes and Bedrock verbs a capability assume must be
 * session-policy-scoped to. Empty/absent → inline or text-only, assumed with no
 * session policy.
 *   - `s3Keys` — single-object GetObject (S3-location INPUT, plan §3.4);
 *   - `s3PutKeyPrefixes` — single-prefix PutObject (async S3 OUTPUT, plan §3.8);
 *   - `bedrockAsync` — the session policy must also re-Allow the async invoke
 *     verbs (StartAsyncInvoke/GetAsyncInvoke), since a session policy is the
 *     intersection over the whole session and would otherwise deny them. */
export interface CapabilityAssumeScope {
  s3Keys?: { bucket: string; key: string }[];
  s3PutKeyPrefixes?: { bucket: string; keyPrefix: string }[];
  bedrockAsync?: boolean;
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
  /** Assume the capability-broker role (single hop, per request). On the
   * S3-location path, `scope.s3Keys` names the object(s) the assume must attach
   * an inline session policy to (single-key downscoping, plan §3.4). */
  assumeCapabilityCreds: (scope?: CapabilityAssumeScope) => Promise<CapabilityCreds>;
  invoker: BedrockInvoker;
  /** Sync image generator (Nova Canvas). Required only to serve a `sync-s3`
   * (image) model on `/invoke`; text-only callers may omit it. */
  imageInvoker?: BedrockImageInvoker;
  /** Write the generated image bytes to the app's OWN syncable area UNDER THE APP
   * ROLE (the capability role stays write-free on the sync-s3 path, plan §3.8),
   * returning the object location. Required only for the image path. */
  writeSyncOutput?: (invocationId: string, images: Uint8Array[], contentType: string) => Promise<SyncImageOutput>;
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

/** The session-policy scope for the capability assume: the single S3 key when
 * content is delivered by S3 location, else undefined (inline / text-only →
 * assume with no session policy). Keeping this next to the invoke call sites
 * makes the "session policy on EVERY S3-location assume" obligation explicit. */
function assumeScopeFor(content: ResolvedContent | undefined): CapabilityAssumeScope | undefined {
  return content?.s3Key ? { s3Keys: [content.s3Key] } : undefined;
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
 * The error body for a Bedrock call that failed — `503 capability_frozen` when
 * Bedrock refused on authorization, `502 invoke_failed` otherwise.
 *
 * WHY THIS EXISTS (budget-guardrail plan §4.8). The Bedrock spend guardrail
 * freezes the capability-broker role by attaching a Deny policy, and from the
 * broker's side that surfaces as a plain `AccessDeniedException`. Mapped
 * generically it reads as an opaque 502 fault, when it is in fact an INTENDED,
 * operator-visible state with a place to go and fix it.
 *
 * The message hedges on purpose. The broker cannot cheaply PROVE the cause is
 * the freeze — checking the role's attached policies on every request is not
 * affordable, and an IAM misconfiguration produces the identical exception — so
 * it says "likely" and points at the one screen where the answer is definitive.
 * 503 rather than 502 because the condition is temporary by construction: a
 * freeze self-clears at the month boundary.
 */
function bedrockFailureBody(err: unknown): { statusCode: number; body: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  if ((err as { name?: string })?.name === "AccessDeniedException") {
    return {
      statusCode: 503,
      body: {
        error: "capability_frozen",
        message:
          "Capability unavailable — Bedrock denied the broker's request. This is most likely " +
          "the Bedrock spend guardrail having frozen the capability role after a budget " +
          "breach; check Settings in the admin app to confirm and resume.",
        cause: message,
      },
    };
  }
  return { statusCode: 502, body: { error: "invoke_failed", message } };
}

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
  // The synchronous /invoke route serves the two SYNCHRONOUS delivery channels —
  // `inline` (text) and `sync-s3` (image); `async-s3` (audio/video) output must
  // use /invoke-async (plan §3.8).
  if (outputIsAsyncS3(model.outputModality)) {
    return reject(400, { error: "output_requires_async", model: body.model });
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

  // For a GENERATION model the request modality is the model's own OUTPUT modality
  // (Nova Canvas → "image"), which drives the `requests/<modality>` gate + the
  // per-image cost derivation; for a text model it reflects whether an image was
  // fed as INPUT (captioning). The caller may override.
  const modality: RequestModality =
    body.modality ??
    (model.outputModality !== "text" ? model.outputModality : content?.image ? "image" : "text");
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
      // isQuantity, not merely isFinite: a fractional or NEGATIVE report is junk
      // to be ignored here, and a negative one would otherwise credit spend back
      // against the cost gate. Sharing the predicate with assertQuantity keeps
      // this filter and the metering path from disagreeing (see money.ts).
      isQuantity(value)
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

  // `sync-s3` (image) output — synchronous generate, then the CDS writes the bytes
  // to the app's own area UNDER THE APP ROLE and returns the key(s) (plan §3.8).
  if (outputDelivery(model.outputModality) === "sync-s3") {
    return handleSyncImageInvoke(deps, prep.prepared);
  }

  // (5) Assume the capability-broker role and invoke Bedrock. On the
  // S3-location path the assume carries a single-key session policy (plan §3.4).
  let result;
  try {
    const creds = await deps.assumeCapabilityCreds(assumeScopeFor(content));
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
    // Failed/aborted call must not hold a reservation. This release is also what
    // keeps a FROZEN capability from silently eating the app's monthly budget:
    // every denied invoke would otherwise leave its worst-case projection
    // reserved on the ledger.
    await release(capClient, invocationId);
    return bedrockFailureBody(err);
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

  const estCostMicros =
    reconciled.find((m) => m.dimension === COST_DIMENSION && m.unit === COST_UNIT)?.quantity ?? 0;

  return {
    statusCode: 200,
    body: {
      model: body.model,
      text: result.text,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      estCostMicros,
      invocationId,
    },
  };
}

/**
 * The `sync-s3` (image) branch of the synchronous /invoke handler (plan §3.8).
 * Generates the image synchronously via `InvokeModel`, then the CDS writes the
 * returned bytes to the app's OWN syncable area UNDER THE APP ROLE
 * (`writeSyncOutput`) and returns the key(s) — the capability role never writes on
 * this path. Bedrock returns no token usage, so cost is CDS-derived per generated
 * image (from `requests:<modality>` pricing) and `output:bytes` is measured from
 * what the CDS actually wrote.
 */
async function handleSyncImageInvoke(
  deps: CapabilityHandlerDeps,
  prepared: PreparedInvoke,
): Promise<CapabilityHandlerResponse> {
  const { model, ctx, content, ledgerKey, invocationId, appReports } = prepared;
  const { capClient, imageInvoker, writeSyncOutput, body } = deps;

  if (!imageInvoker || !writeSyncOutput) {
    // Misconfigured route (no image deps wired) — don't strand the reservation.
    await release(capClient, invocationId);
    return { statusCode: 500, body: { error: "image_output_unsupported" } };
  }

  let output: SyncImageOutput;
  try {
    // The capability role needs no S3 WRITE here (the CDS writes the output under
    // the app role). A session policy is attached only if a CONDITIONING image is
    // delivered by S3 location (single-key GetObject, plan §3.4).
    const creds = await deps.assumeCapabilityCreds(assumeScopeFor(content));
    const generated = await imageInvoker.generateImage({
      target: bedrockInvokeTarget(model),
      region: deps.region,
      provider: model.provider,
      prompt: body.prompt!,
      image: content?.image,
      generation: body.generation,
      credentials: creds,
    });
    output = await writeSyncOutput(invocationId, generated.images, `image/${generated.format}`);
  } catch (err) {
    await release(capClient, invocationId);
    return bedrockFailureBody(err);
  }

  // Reconcile: image generation has no tokens (0/0); cost falls out of the
  // requests:<modality> pricing and output:bytes is CDS-measured from the write.
  const reconciled = reconcileMeasurements({
    model,
    ctx,
    inputTokens: 0,
    outputTokens: 0,
    inputBytes: content?.sizeBytes,
    outputBytes: output.totalBytes,
    appReports,
  });
  await reconcile(capClient, ledgerKey, reconciled);
  const estCostMicros =
    reconciled.find((m) => m.dimension === COST_DIMENSION && m.unit === COST_UNIT)?.quantity ?? 0;

  return {
    statusCode: 200,
    body: {
      model: body.model,
      output,
      usage: { inputTokens: 0, outputTokens: 0 },
      estCostMicros,
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
      /** Reconciled cost of this invocation in canonical micros (money.ts). */
      estCostMicros: number;
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

  // Streaming is only for `inline` (text) output; a `sync-s3` image model cleared
  // prepareInvoke (it isn't async) but can't be streamed — reject and release the
  // reservation rather than opening a stream that would fail at Bedrock.
  if (outputDelivery(model.outputModality) !== "inline") {
    await release(capClient, invocationId);
    return { ok: false, response: { statusCode: 400, body: { error: "output_not_streamable", model: body.model } } };
  }

  async function* stream(): AsyncGenerator<CapabilityStreamEvent> {
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const creds = await deps.assumeCapabilityCreds(assumeScopeFor(content));
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
      const failure = bedrockFailureBody(err);
      yield {
        type: "error",
        status: failure.statusCode,
        error: String(failure.body.error),
        message: String(failure.body.message),
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
    const estCostMicros =
      reconciled.find((m) => m.dimension === COST_DIMENSION && m.unit === COST_UNIT)?.quantity ?? 0;

    yield {
      type: "done",
      model: body.model!,
      usage: { inputTokens, outputTokens },
      estCostMicros,
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
      isQuantity(value)
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

// ---------------------------------------------------------------------------
// Async generation (StartAsyncInvoke) — plan §3.8
// ---------------------------------------------------------------------------
//
// Non-text output (video / large image) is written to S3 ASYNCHRONOUSLY, so the
// synchronous reserve → invoke → reconcile flow splits in two:
//   START  — reserve the worst case, kick off StartAsyncInvoke to a per-invocation
//            output prefix in the app's OWN syncable area, and record the job so a
//            later poll can find it;
//   STATUS — the app polls; each poll GetAsyncInvokes; the COMPLETING poll commits
//            the reservation, records the CDS-measured output:bytes (S3 HEAD), and
//            returns the output key(s) for the app to ingest as a normal record
//            via the ordinary data plane (under its own role — the capability role
//            is never a record writer).
// Bedrock writes the output under the capability role, so — mirroring the
// S3-location INPUT path — the start assume carries a session policy scoped to
// exactly the one output prefix (single-prefix PutObject) plus the async invoke
// verbs; the app-role read of any conditioning image stays the independent
// authorization for the input side.

/** Default requested video length (seconds) when the app doesn't specify one —
 * also the CDS-derived cost basis, so it is sent to Bedrock unchanged. */
const DEFAULT_VIDEO_SECONDS = 6;

export interface CapabilityAsyncInvokeBody {
  model?: string;
  prompt?: string;
  /** Optional conditioning item (e.g. an image for image-to-video), by reference. */
  contentRef?: { recordId?: string; objectKey?: string };
  modality?: RequestModality;
  generation?: AsyncGenerationParams;
  /** App-reported non-generic INPUT quantities, keyed by "dimension:unit". */
  reports?: Record<string, number>;
}

/** The S3 output target for a job: a per-invocation folder in the app's syncable
 * area that Bedrock writes the generated output under. */
export interface AsyncOutputTarget {
  bucket: string;
  /** Key prefix (folder) — the session PutObject policy is scoped to this. */
  keyPrefix: string;
  /** `s3://bucket/keyPrefix/` URI passed to StartAsyncInvoke. */
  s3Uri: string;
}

export interface CapabilityAsyncStartDeps {
  appId: string;
  capabilityName: string;
  body: CapabilityAsyncInvokeBody;
  capClient: DatabaseClient;
  /** Read an optional conditioning item under the app role. Omit for prompt-only. */
  readContent?: (ref: NonNullable<CapabilityAsyncInvokeBody["contentRef"]>) => Promise<ContentReadResult>;
  assumeCapabilityCreds: (scope?: CapabilityAssumeScope) => Promise<CapabilityCreds>;
  asyncInvoker: BedrockAsyncInvoker;
  region: string;
  /** Pin the output bucket to this account (confused-deputy guard). */
  accountId: string;
  /** Resolve the S3 output target for the freshly-minted invocationId. */
  resolveOutputTarget: (invocationId: string) => AsyncOutputTarget;
  nowMs?: () => number;
  timeZone?: string;
}

/** Filter app-reported quantities to those the app declared + that are
 * non-generic + finite (shared by the sync and async paths). */
function filterAppReports(
  raw: Record<string, number> | undefined,
  declared: ReadonlySet<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const [dim, unit] = key.split(":");
    if (
      dim &&
      unit &&
      declared.has(key) &&
      isNonGenericDimensionUnit(dim, unit) &&
      isQuantity(value)
    ) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Start an async generation job (plan §3.8). Runs the same grant/model/content/
 * gate pre-flight as the synchronous path (reserve-on-ledger against the
 * worst-case projection), then kicks off StartAsyncInvoke and records the job.
 * Returns 202 with the invocationId + output location the app polls/ingests.
 */
export async function handleCapabilityInvokeAsyncStart(
  deps: CapabilityAsyncStartDeps,
): Promise<CapabilityHandlerResponse> {
  const nowMs = deps.nowMs ?? Date.now;
  const timeZone = deps.timeZone ?? "UTC";
  const { appId, capabilityName, body, capClient } = deps;
  const reject = (statusCode: number, bodyObj: unknown): CapabilityHandlerResponse => ({
    statusCode,
    body: bodyObj,
  });

  if (capabilityName !== CAPABILITY_BEDROCK_INVOKE) {
    return reject(404, { error: `Unknown capability: ${capabilityName}` });
  }
  if (!body.model) return reject(400, { error: "model is required" });
  if (!body.prompt) return reject(400, { error: "prompt is required" });

  const grantRow = await loadCapabilityGrant(capClient, appId, capabilityName);
  if (!grantRow) return reject(403, { error: "not_granted", capability: capabilityName });
  const grant = buildCapabilityGrant(grantRow);

  if (!canInvokeModel(grant, body.model)) {
    return reject(403, { error: "model_not_granted", model: body.model });
  }
  const overrides = await loadModelOverrides(capClient);
  const model = effectiveModel(body.model, overrides);
  if (!model) return reject(400, { error: "unknown_model", model: body.model });
  // This route is only for models whose output is async S3 (non-text, §3.8); a
  // text model must use /invoke(+stream). Keeps the two flows from being crossed.
  if (!outputIsAsyncS3(model.outputModality)) {
    return reject(400, { error: "output_not_async", model: body.model });
  }

  // Optional conditioning item read under the app role (source of truth for what
  // the app may feed Bedrock). Prompt-only requests skip this.
  let content: ResolvedContent | undefined;
  if (body.contentRef) {
    if (!deps.readContent) return reject(400, { error: "contentRef not supported here" });
    const read = await deps.readContent(body.contentRef);
    if (!read.ok) return reject(read.status ?? 403, { error: read.message ?? "forbidden" });
    content = read.content;
  }

  // The request modality comes from the model's OUTPUT modality (e.g. Nova Reel →
  // "video"), which drives the requests/<modality> gate; the caller may override.
  const modality: RequestModality = body.modality ?? model.outputModality;
  const ctx: CapabilityRequestContext = { appId, provider: model.provider, model: body.model, modality };
  const appReports = filterAppReports(body.reports, grant.reports);

  // Fail-closed BEFORE reserving on any matching gate whose non-generic dimension
  // the app didn't declare (same contract as the sync path).
  const gates = await loadGates(capClient, capabilityName);
  for (const gate of gates) {
    if (!gateMatches(gate, ctx)) continue;
    const key = dimensionUnitKey(gate.dimension, gate.unit);
    if (isNonGenericDimensionUnit(gate.dimension, gate.unit) && !grant.reports.has(key)) {
      return reject(403, { error: "undeclared_dimension", dimension: gate.dimension, unit: gate.unit });
    }
  }

  // CDS-derived generation output → drives both the reservation and the derived
  // cost gate (the CDS controls the requested duration, so this is CDS-measured).
  const durationSeconds = body.generation?.durationSeconds ?? DEFAULT_VIDEO_SECONDS;
  // The request quotes whole seconds because Bedrock's own generation parameter
  // does; metering is in canonical `duration_ms`, converted here at the boundary
  // so no seconds-denominated quantity travels further (see money.ts).
  const output: Measurement[] = [
    { dimension: "output", unit: "duration_ms", quantity: durationSeconds * 1000 },
  ];

  const projected = projectAsyncReservation({
    model,
    ctx,
    inputBytes: content?.sizeBytes,
    output,
    appReports,
  });

  const invocationId = `${appId}:${capabilityName}:async:${nowMs()}:${Math.random().toString(36).slice(2, 10)}`;
  const ledgerKey: LedgerKey = {
    invocationId,
    appId,
    capabilityName,
    provider: model.provider,
    model: body.model,
  };
  await reserve(capClient, ledgerKey, projected);

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

  // Output goes to a per-invocation folder in the app's OWN syncable area; the
  // start assume is scoped to that one prefix (PutObject) + the input key (if the
  // conditioning image is delivered by S3 location) + the async invoke verbs.
  const target = deps.resolveOutputTarget(invocationId);
  const scope: CapabilityAssumeScope = {
    bedrockAsync: true,
    s3PutKeyPrefixes: [{ bucket: target.bucket, keyPrefix: target.keyPrefix }],
    ...(content?.s3Key ? { s3Keys: [content.s3Key] } : {}),
  };

  let started;
  try {
    const creds = await deps.assumeCapabilityCreds(scope);
    started = await deps.asyncInvoker.startAsync({
      target: bedrockInvokeTarget(model),
      region: deps.region,
      provider: model.provider,
      prompt: body.prompt,
      image: content?.image,
      generation: { ...body.generation, durationSeconds },
      outputS3Uri: target.s3Uri,
      outputBucketOwner: deps.accountId,
      credentials: creds,
    });
  } catch (err) {
    // Failed to start → the reservation must not linger.
    await release(capClient, invocationId);
    // A frozen role denies StartAsyncInvoke exactly as it denies the buffered
    // and streaming calls — three entry points, one mapping, and this is the one
    // that is easy to forget.
    const failure = bedrockFailureBody(err);
    return reject(failure.statusCode, {
      ...failure.body,
      ...(failure.body.error === "invoke_failed" ? { error: "async_start_failed" } : {}),
    });
  }

  // Record the job so a later poll can reconcile it. If this insert fails the job
  // is already running in Bedrock; we deliberately do NOT release the reservation
  // (that would under-count real spend) — the stuck reservation is the safe,
  // over-counting direction for a spend cap.
  await insertAsyncJob(capClient, {
    invocationId,
    appId,
    capabilityName,
    provider: model.provider,
    model: body.model,
    invocationArn: started.invocationArn,
    outputBucket: target.bucket,
    outputKeyPrefix: target.keyPrefix,
    status: "running",
  });

  return {
    statusCode: 202,
    body: {
      invocationId,
      status: "running",
      output: { bucket: target.bucket, keyPrefix: target.keyPrefix },
    },
  };
}

export interface CapabilityAsyncStatusDeps {
  appId: string;
  capabilityName: string;
  invocationId: string;
  capClient: DatabaseClient;
  assumeCapabilityCreds: (scope?: CapabilityAssumeScope) => Promise<CapabilityCreds>;
  asyncInvoker: BedrockAsyncInvoker;
  region: string;
  /** List + total the output objects under the prefix, under the APP role (the
   * output lives in the app's own syncable area, so no capability creds needed). */
  headOutput: (bucket: string, keyPrefix: string) => Promise<{ keys: string[]; totalBytes: number }>;
}

/**
 * Poll an async generation job (plan §3.8). While the job is running each call
 * GetAsyncInvokes; the COMPLETING poll commits the reservation, records the
 * CDS-measured output:bytes (S3 HEAD), marks the job done, and returns the output
 * key(s). A failed job releases the reservation. Terminal jobs replay
 * idempotently without touching the ledger again.
 */
export async function handleCapabilityInvokeAsyncStatus(
  deps: CapabilityAsyncStatusDeps,
): Promise<CapabilityHandlerResponse> {
  const { appId, capabilityName, invocationId, capClient } = deps;
  if (capabilityName !== CAPABILITY_BEDROCK_INVOKE) {
    return { statusCode: 404, body: { error: `Unknown capability: ${capabilityName}` } };
  }
  const grantRow = await loadCapabilityGrant(capClient, appId, capabilityName);
  if (!grantRow) return { statusCode: 403, body: { error: "not_granted" } };

  const job = await loadAsyncJob(capClient, invocationId, appId);
  if (!job) return { statusCode: 404, body: { error: "unknown_invocation" } };

  const outputBody = async () => {
    const out = await deps.headOutput(job.outputBucket, job.outputKeyPrefix);
    return { bucket: job.outputBucket, keyPrefix: job.outputKeyPrefix, keys: out.keys, totalBytes: out.totalBytes };
  };

  // Terminal → idempotent replay (no re-reconcile).
  if (job.status === "completed") {
    return { statusCode: 200, body: { status: "completed", output: await outputBody() } };
  }
  if (job.status === "failed") {
    return { statusCode: 200, body: { status: "failed" } };
  }

  // Running → poll Bedrock. A transient poll error leaves the job running.
  let st;
  try {
    const creds = await deps.assumeCapabilityCreds({ bedrockAsync: true });
    st = await deps.asyncInvoker.getAsyncStatus({
      invocationArn: job.invocationArn,
      region: deps.region,
      credentials: creds,
    });
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        status: "running",
        error: "async_status_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (st.status === "InProgress") {
    return { statusCode: 200, body: { status: "running" } };
  }

  const ledgerKey: LedgerKey = {
    invocationId,
    appId,
    capabilityName,
    provider: job.provider,
    model: job.model,
  };

  if (st.status === "Failed") {
    await release(capClient, invocationId);
    await markAsyncJobStatus(capClient, invocationId, "failed");
    return {
      statusCode: 200,
      body: { status: "failed", error: st.failureMessage ?? "generation_failed" },
    };
  }

  // Completed. Commit the reservation as-is (CDS-derived worst case == actuals for
  // fixed-duration generation) and record the post-call CDS-measured output bytes.
  // Concurrency note: two racing polls can both reach here; commitReservation is
  // idempotent, and a duplicated output:bytes append doesn't affect the
  // (duration-derived) spend cap — the tolerated small overage per plan §3.5.
  const out = await deps.headOutput(job.outputBucket, job.outputKeyPrefix);
  await commitReservation(capClient, invocationId);
  if (out.totalBytes > 0) {
    await appendReportedOutput(capClient, ledgerKey, [
      { dimension: "output", unit: "bytes", quantity: out.totalBytes },
    ]);
  }
  await markAsyncJobStatus(capClient, invocationId, "completed");

  return {
    statusCode: 200,
    body: {
      status: "completed",
      output: { bucket: job.outputBucket, keyPrefix: job.outputKeyPrefix, keys: out.keys, totalBytes: out.totalBytes },
    },
  };
}
