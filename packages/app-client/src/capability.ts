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

import { signedFetch } from "./sign";
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
