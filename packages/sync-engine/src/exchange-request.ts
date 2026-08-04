/**
 * What a responder is willing to be told.
 *
 * `SyncExchangeRequest` is a TypeScript type, and a TypeScript type is a claim
 * about a value that arrived over a network only if something checks it. At the
 * HTTP entry points nothing did: the cloud handler parsed JSON and handed the
 * result straight to `transport.exchange()`, where the numbers in it reach a
 * `LIMIT ?`, a byte budget, and a `substr(updated_at, 1, N)`.
 *
 * The exchange routes are signed — device- or app-identified, not anonymous —
 * so this is not a hostile-internet surface, and nothing here is a fix for one.
 * It is a fix for the fact that a peer running an older build, a truncated
 * body, or a field that drifted type produced a 500 out of the query layer
 * instead of a 400 out of the door, and that `limit: 1e9` was a per-author scan
 * of that size for the asking.
 *
 * Two different answers, for two different kinds of wrong:
 *
 * - **Budgets are clamped**, not rejected. `limit` and `maxBytes` are requests
 *   for *less* than the responder's own maximum; a caller asking for more is
 *   asking for something it has no say in, and the sane reply is the maximum
 *   rather than an error. Clamping low ends at zero preserves the existing
 *   fail-safe reading of a non-positive limit — `collectSince` pins every
 *   author's ceiling to `null` and the round ships nothing.
 * - **Shapes are rejected.** A `watermarks` value that is not an HLC, or a
 *   payload field that is not an array, cannot be interpreted at all. Guessing
 *   would mean applying a round derived from a request nobody sent; the caller
 *   gets a 400 and the exact field.
 *
 * `digestPrefixLength` is a third case and takes the milder answer: an
 * unusable value is *dropped*, because the field is an optimization hint and
 * the responder echoes back the width it actually used
 * ({@link SyncExchangeResponse.digestPrefixLength}). A requester that asked for
 * nonsense sees a width it did not ask for and refuses to compare, which is
 * already the right outcome and needs no error to reach it.
 */

import { StarkeepError } from "@starkeep/protocol-primitives";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import type { SyncExchangeRequest, Watermarks } from "./types.js";

/** Mirrors the engine's own defaults; see `SyncEngineOptions.maxItems`. */
export const DEFAULT_RESPONDER_MAX_ITEMS = 1000;
export const DEFAULT_RESPONDER_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Widest `digestPrefixLength` worth honouring — the wall-clock field of a
 * serialized HLC. A longer prefix reaches into the counter and then the nodeId,
 * so buckets stop being time ranges and the digest stops meaning anything.
 */
const MAX_DIGEST_PREFIX_LENGTH = 12;

/**
 * A request that cannot be interpreted, as opposed to one asking for too much.
 * HTTP callers should map this to 400 — it is the only error out of
 * {@link sanitizeExchangeRequest}, and it always names the offending field.
 */
export class InvalidExchangeRequest extends StarkeepError {
  constructor(message: string) {
    super(message, "INVALID_EXCHANGE_REQUEST");
    this.name = "InvalidExchangeRequest";
  }
}

export interface SanitizeExchangeRequestOptions {
  /** Item ceiling this responder will honour. */
  readonly maxItems?: number;
  /** Byte ceiling this responder will honour. */
  readonly maxBytes?: number;
}

/**
 * Turn a parsed JSON body into a `SyncExchangeRequest` a responder can act on,
 * or throw {@link InvalidExchangeRequest}.
 *
 * Payload arrays (`records`, `labels`, `appSyncableRows`) are checked for being
 * arrays and nothing more. Their *elements* are validated where they are
 * applied — `put()` throws on a malformed record, and a failed apply halts that
 * author's contiguous prefix, which is the behaviour the protocol is built
 * around. Duplicating that here would be a second, weaker copy of it.
 */
export function sanitizeExchangeRequest(
  body: unknown,
  options: SanitizeExchangeRequestOptions = {},
): SyncExchangeRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidExchangeRequest("exchange body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  const maxItems = options.maxItems ?? DEFAULT_RESPONDER_MAX_ITEMS;
  const maxBytes = options.maxBytes ?? DEFAULT_RESPONDER_MAX_BYTES;

  const request: {
    -readonly [K in keyof SyncExchangeRequest]: SyncExchangeRequest[K];
  } = {
    watermarks: sanitizeWatermarks(raw["watermarks"]),
  };

  for (const field of ["records", "labels", "appSyncableRows"] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      throw new InvalidExchangeRequest(`"${field}" must be an array`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request[field] = value as any;
  }

  const limit = clampBudget(raw["limit"], "limit", maxItems);
  if (limit !== undefined) request.limit = limit;
  const bytes = clampBudget(raw["maxBytes"], "maxBytes", maxBytes);
  if (bytes !== undefined) request.maxBytes = bytes;

  if (raw["requestDigest"] !== undefined && raw["requestDigest"] !== null) {
    if (typeof raw["requestDigest"] !== "boolean") {
      throw new InvalidExchangeRequest(`"requestDigest" must be a boolean`);
    }
    request.requestDigest = raw["requestDigest"];
  }

  const prefixLength = raw["digestPrefixLength"];
  if (
    typeof prefixLength === "number" &&
    Number.isInteger(prefixLength) &&
    prefixLength >= 1 &&
    prefixLength <= MAX_DIGEST_PREFIX_LENGTH
  ) {
    request.digestPrefixLength = prefixLength;
  }
  // Anything else is dropped rather than rejected — see the module note.

  return request;
}

/**
 * A budget as a whole number within `[0, max]`, or `undefined` when the caller
 * did not ask for one (which means "use the responder's default", not "zero").
 */
function clampBudget(
  value: unknown,
  field: string,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidExchangeRequest(`"${field}" must be a finite number`);
  }
  return Math.min(Math.max(Math.floor(value), 0), max);
}

/**
 * The caller's watermarks, with every entry confirmed to be an HLC.
 *
 * These reach `compareHLC` and `serializeHLC` on the scan path, where a value
 * of the wrong shape becomes either a comparison against `undefined` — which
 * silently selects the wrong rows — or a throw from inside the query builder.
 * The first is worse than the second, and this catches both.
 *
 * "HLC-shaped" is not the same as "an HLC", and the two ways they came apart
 * are both refused here:
 *
 * - **A negative or fractional `wallTime`.** `Number.isFinite` admits both.
 *   `serializeHLC` renders a negative wall time as a string that sorts below
 *   every stored row, so `updated_at > since` selects the whole table — a full
 *   re-ship of the library for the asking. Fail-safe in the loss sense, which is
 *   why it went unnoticed, and not a thing a responder should do because a
 *   number arrived with a minus sign on it.
 * - **A key that disagrees with the value's own `nodeId`.** `planNodeScans` keys
 *   off the map key while the serialized bound carries the value's `nodeId`, so
 *   a mismatched pair shifts the tie-break at identical `(wallTime, counter)` —
 *   selecting or skipping a row at exactly the boundary. Normalized to the map
 *   key, which is the one the scan is planned around.
 */
function sanitizeWatermarks(value: unknown): Watermarks {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidExchangeRequest(`"watermarks" must be an object`);
  }
  const out: Record<string, HLCTimestamp> = {};
  for (const [nodeId, hlc] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof hlc !== "object" ||
      hlc === null ||
      !isHlcComponent((hlc as HLCTimestamp).wallTime) ||
      !isHlcComponent((hlc as HLCTimestamp).counter) ||
      typeof (hlc as HLCTimestamp).nodeId !== "string"
    ) {
      throw new InvalidExchangeRequest(
        `"watermarks[${nodeId}]" is not an HLC timestamp`,
      );
    }
    const { wallTime, counter, nodeId: author } = hlc as HLCTimestamp;
    if (author !== nodeId) {
      // Normalized rather than rejected: the map key is what the scan is
      // planned around, and an older peer that filled the field carelessly is
      // asking for this author's rows either way. Rejecting would refuse a
      // request whose intent is unambiguous.
      console.warn(
        `[sync] watermarks["${nodeId}"] carries nodeId "${author}"; using the map key`,
      );
    }
    out[nodeId] = { wallTime, counter, nodeId };
  }
  return out;
}

/** A non-negative integer — what both numeric fields of an HLC actually are. */
function isHlcComponent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
