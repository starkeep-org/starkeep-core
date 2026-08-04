import type {
  SyncTransport,
  SyncExchangeRequest,
  SyncExchangeResponse,
} from "../types.js";
import { SyncError } from "../errors.js";

export interface HttpSyncTransportOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Produce per-request auth headers given the HTTP method, the request path
   * (relative to the per-app mount), and the serialized body bytes. Used to
   * HMAC-sign requests for the cloud verifier; mirrors the shape
   * `@starkeep/app-client/sign.ts`'s `signRequest` emits (method/path/ts bound).
   */
  readonly signRequest?: (
    method: string,
    path: string,
    body: string,
  ) => Record<string, string>;
}

/**
 * `SyncTransport` that talks to a remote Starkeep-compatible HTTP server
 * over `fetch`. Single endpoint: `POST {baseUrl}/sync/exchange`.
 */
export function createHttpSyncTransport(
  options: HttpSyncTransportOptions,
): SyncTransport {
  const { baseUrl, fetch: fetchImpl = globalThis.fetch, signRequest } = options;
  const trimmed = baseUrl.replace(/\/+$/, "");

  async function postJson<TRequest, TResponse>(
    path: string,
    body: TRequest,
  ): Promise<TResponse> {
    const serialized = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(signRequest?.("POST", path, serialized) ?? {}),
    };

    const response = await fetchImpl(`${trimmed}${path}`, {
      method: "POST",
      headers,
      body: serialized,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SyncError(
        `${path} failed: ${response.status} ${response.statusText} ${text}`,
      );
    }

    return (await response.json()) as TResponse;
  }

  return {
    async exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
      return sanitizeExchangeResponse(
        await postJson<SyncExchangeRequest, unknown>("/sync/exchange", request),
      );
    },
  };
}

/**
 * What this side is willing to be told back.
 *
 * The request direction got a validator; this one was a bare `as
 * SyncExchangeResponse`, and the two fields that matter most fail quietly when
 * they are missing. A response with no `hasMore` reads as falsy — "drained" —
 * so a sync loop stops with a backlog still owed and reports itself complete. A
 * response with no `responderWatermarks` throws out of `sameWatermarks` deep
 * inside the engine, where the stack says nothing about a peer that answered
 * wrongly.
 *
 * Refused rather than defaulted, for both. There is no safe default for either:
 * guessing `hasMore: true` loops forever against a peer that will never say
 * otherwise, and guessing `{}` for the coverage map means "the peer holds
 * nothing", which re-ships the entire library. A `SyncError` naming the field is
 * the honest answer, and the round is retried the way any failed round is.
 *
 * The payload arrays are *tolerated* when absent — an empty round legitimately
 * omits them over JSON — and refused when present and not arrays, which is the
 * same distinction `sanitizeExchangeRequest` draws on the way in.
 */
function sanitizeExchangeResponse(body: unknown): SyncExchangeResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SyncError("/sync/exchange response is not a JSON object");
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw["hasMore"] !== "boolean") {
    throw new SyncError('/sync/exchange response is missing "hasMore"');
  }
  const watermarks = raw["responderWatermarks"];
  if (typeof watermarks !== "object" || watermarks === null || Array.isArray(watermarks)) {
    throw new SyncError(
      '/sync/exchange response is missing "responderWatermarks"',
    );
  }

  for (const field of ["records", "labels", "appSyncableRows", "digest"] as const) {
    const value = raw[field];
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      throw new SyncError(`/sync/exchange response field "${field}" is not an array`);
    }
  }
  // `haltedAuthors` is read as a set of nodeIds and feeds both the `blocked`
  // flag and repair-floor retention, so a non-array here would silently mean
  // "nothing halted" — the exact failure the field exists to end.
  const halted = raw["haltedAuthors"];
  if (halted !== undefined && halted !== null) {
    if (!Array.isArray(halted) || halted.some((a) => typeof a !== "string")) {
      throw new SyncError(
        '/sync/exchange response field "haltedAuthors" is not an array of node ids',
      );
    }
  }

  return {
    ...(raw as unknown as SyncExchangeResponse),
    records: (raw["records"] as SyncExchangeResponse["records"]) ?? [],
    labels: (raw["labels"] as SyncExchangeResponse["labels"]) ?? [],
    appSyncableRows:
      (raw["appSyncableRows"] as SyncExchangeResponse["appSyncableRows"]) ?? [],
  };
}
