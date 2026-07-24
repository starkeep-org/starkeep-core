/**
 * App-client surface for the cloud capability broker (plan §3.7).
 *
 * Capabilities (currently only `bedrock.invoke`) are ALWAYS served by the cloud
 * CDS — only it holds the capability role — so `invokeCapability` resolves a
 * CLOUD endpoint + cloud auth regardless of whether the app's data target is
 * local or cloud:
 *   - Cloud target: the app's creds already point at the cloud CDS; we HMAC-sign
 *     and POST `/apps/<appId>/capabilities/<name>/invoke`.
 *   - Local target: the app still reaches the cloud CDS. The app holds its HMAC
 *     secret on disk, so it signs and forwards to the cloud over the same
 *     server-to-server HMAC path (the local-data-server never calls Bedrock).
 *   - Local-only install (no cloud plane): capabilities are unavailable — a clear
 *     error is thrown / a not-configured result returned.
 *
 * Content is supplied BY REFERENCE only (`contentRef`) — there is no bytes
 * parameter; the broker reads the referenced item server-side under the app's
 * own role. An ungranted capability returns a well-defined `{ granted: false }`
 * result (never throws) so an app can run degraded.
 */

import {
  signedFetch,
  signRequest,
  APP_ID_HEADER,
  APP_SIG_HEADER,
  APP_TS_HEADER,
} from "./sign";
import { loadAppCredentials, type AppCredentials } from "./credentials";

export type RequestModality = "text" | "image" | "audio" | "video";

export interface CapabilityContentRef {
  recordId?: string;
  objectKey?: string;
}

export interface InvokeCapabilityRequest {
  model: string;
  prompt: string;
  /** Cloud-stored item to feed the model, by reference. Omit for text-only. */
  contentRef?: CapabilityContentRef;
  maxTokens?: number;
  modality?: RequestModality;
  /** App-reported non-generic INPUT quantities, keyed by "dimension:unit". */
  reports?: Record<string, number>;
}

export interface CapabilityUsage {
  inputTokens: number;
  outputTokens: number;
}

export type InvokeCapabilityResult =
  | {
      granted: true;
      ok: true;
      model: string;
      text: string;
      usage: CapabilityUsage;
      estCostUsd: number;
      invocationId: string;
    }
  | {
      // Granted, but the call was rejected (gate exceeded, invoke failure, bad
      // request). `status` is the HTTP status; `error` the machine code.
      granted: true;
      ok: false;
      status: number;
      error: string;
      detail?: unknown;
    }
  | {
      // No grant for this capability — the app should run degraded.
      granted: false;
    };

export interface GrantedCapability {
  name: string;
  models: string[];
  reports: string[];
}

/** Thrown when capabilities can't be reached (no cloud plane configured). */
export class CapabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityUnavailableError";
  }
}

/**
 * Resolve creds whose `dataServerUrl` reaches the CLOUD CDS. Capabilities are
 * cloud-only, so a local data target is redirected to the cloud base:
 *   1. `STARKEEP_CLOUD_DATA_BASE` (+ appId) when set (both modes may set it);
 *   2. otherwise the app's own `dataServerUrl` if it is already a cloud URL;
 *   3. otherwise → CapabilityUnavailableError (local-only install).
 */
async function loadCloudCapabilityCreds(appId: string): Promise<AppCredentials> {
  const creds = await loadAppCredentials(appId);
  if (!creds) {
    throw new CapabilityUnavailableError(
      `App "${appId}" is not installed / has no credentials on this host`,
    );
  }
  const cloudBase = process.env.STARKEEP_CLOUD_DATA_BASE?.replace(/\/+$/, "");
  if (cloudBase) {
    return { ...creds, dataServerUrl: `${cloudBase}/apps/${appId}` };
  }
  // Accept the app's own URL only when it is already a cloud endpoint. A local
  // 127.0.0.1 / localhost data server cannot broker capabilities.
  if (/^https:\/\//i.test(creds.dataServerUrl) && !/127\.0\.0\.1|localhost/.test(creds.dataServerUrl)) {
    return creds;
  }
  throw new CapabilityUnavailableError(
    "Capabilities require a cloud endpoint. Set STARKEEP_CLOUD_DATA_BASE (this is a " +
      "cloud-plane feature; a purely local install cannot invoke capabilities).",
  );
}

/**
 * Invoke a capability by reference. Returns `{ granted: false }` when the app
 * has no grant (degraded mode), a success result on 200, or a structured
 * failure on any other status. Throws only when the cloud plane is unreachable.
 */
export async function invokeCapability(
  appId: string,
  capability: string,
  request: InvokeCapabilityRequest,
): Promise<InvokeCapabilityResult> {
  const creds = await loadCloudCapabilityCreds(appId);
  const path = `/capabilities/${encodeURIComponent(capability)}/invoke`;
  const body = JSON.stringify(request);
  const resp = await signedFetch(creds, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const parsed = (await resp.json().catch(() => ({}))) as Record<string, unknown>;

  if (resp.status === 200) {
    return {
      granted: true,
      ok: true,
      model: String(parsed.model ?? request.model),
      text: String(parsed.text ?? ""),
      usage: (parsed.usage as CapabilityUsage) ?? { inputTokens: 0, outputTokens: 0 },
      estCostUsd: Number(parsed.estCostUsd ?? 0),
      invocationId: String(parsed.invocationId ?? ""),
    };
  }
  // "not_granted" is the well-defined degraded-mode signal.
  if (resp.status === 403 && parsed.error === "not_granted") {
    return { granted: false };
  }
  return {
    granted: true,
    ok: false,
    status: resp.status,
    error: typeof parsed.error === "string" ? parsed.error : `http_${resp.status}`,
    detail: parsed,
  };
}

/**
 * List the capabilities granted to this app (runtime-config style) so it can
 * decide up front what to attempt. Returns [] when the cloud plane is
 * unreachable rather than throwing (an app with no cloud plane simply has no
 * capabilities).
 */
export async function getGrantedCapabilities(appId: string): Promise<GrantedCapability[]> {
  let creds: AppCredentials;
  try {
    creds = await loadCloudCapabilityCreds(appId);
  } catch (err) {
    if (err instanceof CapabilityUnavailableError) return [];
    throw err;
  }
  const resp = await signedFetch(creds, "/capabilities", { method: "GET" });
  if (resp.status !== 200) return [];
  const parsed = (await resp.json().catch(() => ({}))) as { capabilities?: GrantedCapability[] };
  return parsed.capabilities ?? [];
}

// ---------------------------------------------------------------------------
// Streaming (plan §3.6/§3.7)
// ---------------------------------------------------------------------------

/** An SSE event from the streaming broker: incremental `text`, a terminal
 * `done` (usage + derived cost), or a mid-stream `error`. */
export type CapabilityStreamEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      model: string;
      usage: CapabilityUsage;
      estCostUsd: number;
      invocationId: string;
    }
  | { type: "error"; status: number; error: string; message?: string };

export type InvokeCapabilityStreamResult =
  | { granted: false }
  | { granted: true; ok: false; status: number; error: string; detail?: unknown }
  | { granted: true; ok: true; stream: AsyncGenerator<CapabilityStreamEvent> };

/**
 * Resolve the streaming target: the app's credentials (for HMAC signing) plus
 * the cloud-data-server streaming Lambda's NAME.
 *
 * The buffering API Gateway can't emit SSE, so streaming is served by a second
 * CDS Lambda invoked DIRECTLY via `InvokeWithResponseStream` — there is no
 * Function URL (this account blocks public NONE URLs, and CloudFront OAC can't
 * sign a RESPONSE_STREAM URL). The caller must therefore hold a per-app role
 * permitting `lambda:InvokeFunction` on that function; the AWS SDK signs the
 * invoke (SigV4) and the handler still verifies the HMAC over the payload.
 * The function name is threaded into per-app Lambdas as
 * `STARKEEP_CLOUD_STREAM_FUNCTION`.
 */
async function loadStreamTarget(
  appId: string,
): Promise<{ creds: AppCredentials; functionName: string }> {
  const creds = await loadAppCredentials(appId);
  if (!creds) {
    throw new CapabilityUnavailableError(
      `App "${appId}" is not installed / has no credentials on this host`,
    );
  }
  const functionName = process.env.STARKEEP_CLOUD_STREAM_FUNCTION;
  if (!functionName) {
    throw new CapabilityUnavailableError(
      "Streaming capabilities require the cloud streaming broker. Set " +
        "STARKEEP_CLOUD_STREAM_FUNCTION (the cloud-data-server streaming Lambda " +
        "name; the caller must hold a per-app role permitting " +
        "lambda:InvokeFunction on it).",
    );
  }
  return { creds, functionName };
}

// The subset of a RESPONSE_STREAM Lambda's event-stream we consume: incremental
// payload chunks and the terminal completion (which may carry a function error).
interface LambdaStreamEvent {
  PayloadChunk?: { Payload?: Uint8Array };
  InvokeComplete?: { ErrorCode?: string; ErrorDetails?: string };
}

/**
 * Decode a RESPONSE_STREAM Lambda event-stream into `CapabilityStreamEvent`s.
 * The handler writes raw SSE frames (`data: <json>\n\n`) with no HTTP prelude
 * (direct invoke has none), so we reassemble frames across chunk boundaries and
 * parse each `data:` payload. A Lambda-level failure at completion (function
 * error / throttle) surfaces as a synthetic `error` event.
 */
async function* parseLambdaSseStream(
  events: AsyncIterable<LambdaStreamEvent>,
): AsyncGenerator<CapabilityStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const ev of events) {
    if (ev.PayloadChunk?.Payload) {
      buffer += decoder.decode(ev.PayloadChunk.Payload, { stream: true });
      let sep: number;
      // SSE frames are separated by a blank line ("\n\n").
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try {
            yield JSON.parse(json) as CapabilityStreamEvent;
          } catch {
            /* skip a malformed frame rather than aborting the whole stream */
          }
        }
      }
    } else if (ev.InvokeComplete?.ErrorCode) {
      yield {
        type: "error",
        status: 502,
        error: "stream_invoke_failed",
        message: ev.InvokeComplete.ErrorDetails ?? ev.InvokeComplete.ErrorCode,
      };
    }
  }
}

// Lazy AWS Lambda client (kept off the load path in local/non-streaming use,
// mirroring credentials.ts's lazy client-ssm import). Constructed once per
// process; aws-sdk-client-mock intercepts at the client level so tests still
// see it regardless of when it's created.
let lambdaClientSingleton: unknown = null;
async function getLambdaClient(): Promise<{
  send: (cmd: unknown) => Promise<{ EventStream?: AsyncIterable<LambdaStreamEvent> }>;
}> {
  const { LambdaClient } = await import("@aws-sdk/client-lambda");
  if (!lambdaClientSingleton) {
    lambdaClientSingleton = new LambdaClient({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  }
  return lambdaClientSingleton as {
    send: (cmd: unknown) => Promise<{ EventStream?: AsyncIterable<LambdaStreamEvent> }>;
  };
}

/**
 * Invoke a capability with a STREAMED (SSE) response over direct Lambda
 * `InvokeWithResponseStream`. Because a raw invoke stream has no HTTP status,
 * pre-flight rejections arrive IN-BAND as a leading `error` frame: this reads
 * the first event and, if it's an error, maps it back to the same shape as
 * {@link invokeCapability} — `{ granted: false }` on `not_granted`, a structured
 * `ok: false` otherwise. On a real stream it returns `{ ok: true, stream }`
 * whose events end in a terminal `done` (or mid-invoke `error`). Throws only
 * when the streaming broker is unreachable (no `STARKEEP_CLOUD_STREAM_FUNCTION`).
 */
export async function invokeCapabilityStream(
  appId: string,
  capability: string,
  request: InvokeCapabilityRequest,
): Promise<InvokeCapabilityStreamResult> {
  const { creds, functionName } = await loadStreamTarget(appId);
  const subPath = `/capabilities/${encodeURIComponent(capability)}/invoke-stream`;
  const bodyStr = JSON.stringify(request);
  // HMAC headers over method + subPath + body — the SAME signature the buffered
  // route uses, verified by the handler against the per-app SecureString.
  const sigHeaders = signRequest({
    appId: creds.appId,
    hmacSecret: creds.hmacSecret,
    method: "POST",
    path: subPath,
    body: bodyStr,
  });
  // HTTP-shaped payload: the handler routes on rawPath and re-verifies the HMAC
  // from these headers, so a direct invoke is indistinguishable from a gateway
  // request to it. Header keys are lowercased (the handler normalizes anyway).
  const payload = {
    rawPath: `/apps/${appId}${subPath}`,
    requestContext: { http: { method: "POST" } },
    headers: {
      "content-type": "application/json",
      [APP_ID_HEADER.toLowerCase()]: sigHeaders[APP_ID_HEADER],
      [APP_SIG_HEADER.toLowerCase()]: sigHeaders[APP_SIG_HEADER],
      [APP_TS_HEADER.toLowerCase()]: sigHeaders[APP_TS_HEADER],
    },
    body: bodyStr,
    isBase64Encoded: false,
  };

  const { InvokeWithResponseStreamCommand } = await import("@aws-sdk/client-lambda");
  const client = await getLambdaClient();
  const resp = await client.send(
    new InvokeWithResponseStreamCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(payload), "utf8"),
    }),
  );
  if (!resp.EventStream) {
    return { granted: true, ok: false, status: 502, error: "no_stream" };
  }

  const gen = parseLambdaSseStream(resp.EventStream);
  // Peek the first event: a pre-flight rejection is a leading `error` frame.
  const first = await gen.next();
  if (first.done) {
    return { granted: true, ok: false, status: 502, error: "empty_stream" };
  }
  const firstEvt = first.value;
  if (firstEvt.type === "error") {
    if (firstEvt.error === "not_granted") return { granted: false };
    return {
      granted: true,
      ok: false,
      status: firstEvt.status,
      error: firstEvt.error,
      detail: firstEvt.message,
    };
  }
  // Real stream — re-emit the peeked event, then the remainder.
  async function* full(): AsyncGenerator<CapabilityStreamEvent> {
    yield firstEvt;
    yield* gen;
  }
  return { granted: true, ok: true, stream: full() };
}

// ---------------------------------------------------------------------------
// Async generation (StartAsyncInvoke) — plan §3.8
// ---------------------------------------------------------------------------
//
// Non-text output (video / large image) is produced ASYNCHRONOUSLY: the broker
// kicks off a job that writes the result to the app's OWN syncable area, and the
// app POLLS for completion. On completion the CDS returns the output object
// key(s); the app then ingests them as normal records via its ordinary data
// routes (POST /data/records) — the capability role never writes records.

/** Generation parameters passed to the async model (e.g. Nova Reel). */
export interface AsyncGenerationParams {
  /** Requested video length in seconds (also the CDS-derived cost basis). */
  durationSeconds?: number;
  fps?: number;
  /** e.g. "1280x720". */
  dimension?: string;
  seed?: number;
}

export interface InvokeCapabilityAsyncRequest {
  model: string;
  prompt: string;
  /** Optional conditioning item (e.g. an image for image-to-video), by reference. */
  contentRef?: CapabilityContentRef;
  modality?: RequestModality;
  generation?: AsyncGenerationParams;
  /** App-reported non-generic INPUT quantities, keyed by "dimension:unit". */
  reports?: Record<string, number>;
}

/** The S3 output location the job writes under (in the app's syncable area). */
export interface AsyncOutputLocation {
  bucket: string;
  keyPrefix: string;
}

export type InvokeCapabilityAsyncResult =
  | { granted: false }
  | { granted: true; ok: false; status: number; error: string; detail?: unknown }
  | { granted: true; ok: true; invocationId: string; status: "running"; output: AsyncOutputLocation };

export type CapabilityAsyncStatusResult =
  | { granted: false }
  | { granted: true; ok: false; status: number; error: string; detail?: unknown }
  | { granted: true; ok: true; status: "running" }
  | {
      granted: true;
      ok: true;
      status: "completed";
      /** The output object key(s) the app should ingest as records, and their
       * total size. */
      output: AsyncOutputLocation & { keys: string[]; totalBytes: number };
    }
  | { granted: true; ok: true; status: "failed"; error?: string };

/**
 * Start an async generation job (plan §3.8). Returns `{ granted: false }` when
 * the app has no grant, a `running` start result with the output location on
 * 202, or a structured failure otherwise. Poll {@link getCapabilityAsyncStatus}
 * with the returned `invocationId` until it is `completed`/`failed`.
 */
export async function invokeCapabilityAsync(
  appId: string,
  capability: string,
  request: InvokeCapabilityAsyncRequest,
): Promise<InvokeCapabilityAsyncResult> {
  const creds = await loadCloudCapabilityCreds(appId);
  const path = `/capabilities/${encodeURIComponent(capability)}/invoke-async`;
  const resp = await signedFetch(creds, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const parsed = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (resp.status === 202) {
    return {
      granted: true,
      ok: true,
      invocationId: String(parsed.invocationId ?? ""),
      status: "running",
      output: (parsed.output as AsyncOutputLocation) ?? { bucket: "", keyPrefix: "" },
    };
  }
  if (resp.status === 403 && parsed.error === "not_granted") {
    return { granted: false };
  }
  return {
    granted: true,
    ok: false,
    status: resp.status,
    error: typeof parsed.error === "string" ? parsed.error : `http_${resp.status}`,
    detail: parsed,
  };
}

/**
 * Poll an async generation job (plan §3.8). Returns `running` while in progress,
 * `completed` with the output key(s) to ingest, or `failed`. `{ granted: false }`
 * when the app has no grant. Throws only when the cloud plane is unreachable.
 */
export async function getCapabilityAsyncStatus(
  appId: string,
  capability: string,
  invocationId: string,
): Promise<CapabilityAsyncStatusResult> {
  const creds = await loadCloudCapabilityCreds(appId);
  const path = `/capabilities/${encodeURIComponent(capability)}/async/${encodeURIComponent(invocationId)}`;
  const resp = await signedFetch(creds, path, { method: "GET" });
  const parsed = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (resp.status === 200) {
    const status = String(parsed.status ?? "");
    if (status === "completed") {
      const out = (parsed.output as AsyncOutputLocation & { keys?: string[]; totalBytes?: number }) ?? {
        bucket: "",
        keyPrefix: "",
      };
      return {
        granted: true,
        ok: true,
        status: "completed",
        output: {
          bucket: out.bucket,
          keyPrefix: out.keyPrefix,
          keys: out.keys ?? [],
          totalBytes: Number(out.totalBytes ?? 0),
        },
      };
    }
    if (status === "failed") {
      return {
        granted: true,
        ok: true,
        status: "failed",
        ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      };
    }
    return { granted: true, ok: true, status: "running" };
  }
  if (resp.status === 403 && parsed.error === "not_granted") {
    return { granted: false };
  }
  return {
    granted: true,
    ok: false,
    status: resp.status,
    error: typeof parsed.error === "string" ? parsed.error : `http_${resp.status}`,
    detail: parsed,
  };
}

/**
 * Report app-measured OUTPUT quantities for a completed invocation (best-effort;
 * §3.5/§3.7). Reconciled into the ledger for best-effort output gates; a missing
 * report simply leaves those gates un-updated (never hard-blocks). No-op-safe.
 */
export async function reportCapabilityOutput(
  appId: string,
  capability: string,
  invocationId: string,
  reports: Record<string, number>,
): Promise<void> {
  const creds = await loadCloudCapabilityCreds(appId);
  const path = `/capabilities/${encodeURIComponent(capability)}/report`;
  await signedFetch(creds, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invocationId, reports }),
  });
}
