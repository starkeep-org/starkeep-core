import type {
  SyncTransport,
  SyncExchangeRequest,
  SyncExchangeResponse,
} from "../types.js";
import { SyncError } from "../errors.js";
import { sanitizeWatermarkMap } from "../exchange-request.js";

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
 *
 * ## Watermark *values*, not just the map's shape
 *
 * Checking that `responderWatermarks` is an object and stopping there was the
 * expensive half-measure. `{ responderWatermarks: { L: "not-an-hlc" } }` against
 * an engine holding one unshipped record produced `complete: true` — a record
 * reported as safely at the peer when it never left — and wrote the junk to disk,
 * where it drove every subsequent scan. That is precisely the hazard
 * `sanitizeWatermarkMap` spends thirty lines on for the request direction, left
 * unguarded in the direction where the value is *persisted*. Same function, same
 * rules, different error type.
 *
 * ## Elements, not just containers
 *
 * `digest` being an array said nothing about its entries, and `digestScopes`
 * was unchecked entirely — a string survives `sameScopes` by coincidence of
 * `.length`, so two nodes could agree they were comparing the same table set on
 * the strength of a typo. A malformed `records` element was worse in a quieter
 * way: it threw a bare `TypeError` out of `groupInboundByNodeId`, deep enough
 * that the stack said nothing about a peer having answered wrongly.
 */
function sanitizeExchangeResponse(body: unknown): SyncExchangeResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SyncError("/sync/exchange response is not a JSON object");
  }
  const raw = body as Record<string, unknown>;
  const fail = (message: string) => new SyncError(`/sync/exchange response ${message}`);

  if (typeof raw["hasMore"] !== "boolean") {
    throw fail('is missing "hasMore"');
  }
  if (
    typeof raw["responderWatermarks"] !== "object" ||
    raw["responderWatermarks"] === null ||
    Array.isArray(raw["responderWatermarks"])
  ) {
    throw fail('is missing "responderWatermarks"');
  }
  // Every entry an HLC, by the same rules the request direction applies — and
  // the normalized map is what gets returned, so a nodeId disagreeing with its
  // map key cannot reach the scan planner.
  const responderWatermarks = sanitizeWatermarkMap(raw["responderWatermarks"], {
    field: "responderWatermarks",
    fail,
  });

  for (const field of ["records", "labels", "appSyncableRows", "digest"] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      throw fail(`field "${field}" is not an array`);
    }
    // Elements checked only for being objects at all. Their *contents* are
    // validated where they are applied — `put()` throws on a malformed record
    // and halts that author's contiguous prefix, which is the behaviour the
    // protocol is built around, and duplicating it here would be a second,
    // weaker copy. What this catches is the case that never reaches an applier:
    // a string or a null in the array, which throws reading `.updatedAt` off it
    // while grouping, before any of that machinery runs.
    const bad = value.findIndex((item) => typeof item !== "object" || item === null);
    if (bad !== -1) {
      throw fail(`field "${field}[${bad}]" is not an object`);
    }
  }

  // `digestPrefixLength` and `digestScopes` decide whether a comparison happens
  // at all. An unusable value must make `verify()` decline rather than compare —
  // and the guards that do the declining read these fields directly, so a string
  // where an array belongs slips past them by having a `.length`.
  const prefixLength = raw["digestPrefixLength"];
  if (prefixLength !== undefined && prefixLength !== null) {
    if (typeof prefixLength !== "number" || !Number.isInteger(prefixLength) || prefixLength < 1) {
      throw fail('field "digestPrefixLength" is not a positive integer');
    }
  }
  const digestScopes = raw["digestScopes"];
  if (digestScopes !== undefined && digestScopes !== null) {
    if (!Array.isArray(digestScopes) || digestScopes.some((s) => typeof s !== "string")) {
      throw fail('field "digestScopes" is not an array of scope names');
    }
  }
  // `haltedAuthors` is read as a set of nodeIds and feeds both the `blocked`
  // flag and repair-floor retention, so a non-array here would silently mean
  // "nothing halted" — the exact failure the field exists to end.
  const halted = raw["haltedAuthors"];
  if (halted !== undefined && halted !== null) {
    if (!Array.isArray(halted) || halted.some((a) => typeof a !== "string")) {
      throw fail('field "haltedAuthors" is not an array of node ids');
    }
  }
  // Absent means complete, which is what every responder too old to send it
  // means. Present and not a boolean is refused rather than coerced: the whole
  // value of the field is that `false` changes how the coverage map is merged,
  // and a truthy string would silently take the `true` branch.
  const coverageComplete = raw["coverageComplete"];
  if (coverageComplete !== undefined && coverageComplete !== null) {
    if (typeof coverageComplete !== "boolean") {
      throw fail('field "coverageComplete" is not a boolean');
    }
  }

  return {
    ...(raw as unknown as SyncExchangeResponse),
    responderWatermarks,
    records: (raw["records"] as SyncExchangeResponse["records"]) ?? [],
    labels: (raw["labels"] as SyncExchangeResponse["labels"]) ?? [],
    appSyncableRows:
      (raw["appSyncableRows"] as SyncExchangeResponse["appSyncableRows"]) ?? [],
  };
}
