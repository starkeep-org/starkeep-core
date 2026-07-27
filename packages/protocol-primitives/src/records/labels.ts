/**
 * Cross-app record labels — attributed assertions one app makes about a shared
 * record, including records it did not create.
 *
 * The shared plane holds exactly two kinds of thing: **facts derived from the
 * bytes** (the per-category metadata tables, `content_hash`, `size_bytes`) and
 * **attributed assertions by a named app** (`origin_app_id`, and these). A
 * label is the second kind. Attribution being part of the data is what makes
 * disagreement representable rather than a conflict: `alpha/quality=high` and
 * `gamma/quality=low` coexist as two rows, and readers decide whom to believe.
 *
 * ## `app_id` is a column, not a prefix
 *
 * There is no `<appId>/<key>` string anywhere in storage. `appId` is its own
 * field, and both data servers set it from the **authenticated subject** — an
 * app cannot express another app's namespace, so there is nothing to validate
 * and nothing to squat. The `<appId>/<key>` string form survives only as the
 * wire/UI rendering (`alpha/ocr-available`), parsed on the way in by
 * {@link parseLabelRef} and reassembled on the way out by
 * {@link formatLabelRef}. This is strictly stronger than a prefix check on a
 * single string, which is what it replaces.
 *
 * ## Keys are schema, values are not data
 *
 * Keys are capped in *cardinality* (§6 of the plan: 64 distinct keys per app,
 * declared in the app manifest), not just in length. That is the cap that
 * matters: byte limits alone don't stop an app from smuggling content through
 * an unbounded key space (`alpha/ocr-<first-40-chars>` as a flag), which would
 * also poison the reverse index. Capping distinct keys forces keys to be
 * schema, which is what a label is.
 *
 * A value is an enum, an opaque id pointing at the app's own API, a count, or a
 * timestamp. Never a sentence, and never a pointer into the shared data model.
 * No cap can enforce that semantically; 128 bytes is small enough that anything
 * substantive has to be chunked across keys, which the key cap then bounds.
 */

import type { StarkeepId } from "../identifiers/types.js";
import type { HLCTimestamp } from "../hlc/types.js";

/** Max characters in a label key. */
export const LABEL_KEY_MAX_LENGTH = 64;
/** Max distinct keys one app may declare in its manifest. */
export const LABEL_KEYS_PER_APP_MAX = 64;
/** Max bytes (UTF-8, not characters) in a label value. */
export const LABEL_VALUE_MAX_BYTES = 128;

/**
 * Keys are identifiers, not content: lowercase, starting alphanumeric, and
 * limited to `.`, `-` and `_` thereafter.
 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One row of `shared.record_labels` / `shared_record_labels`.
 *
 * `recordType` is denormalized from `records.type` so read gating never has to
 * join back to `shared.records` — on the reverse path ("which records has
 * `alpha` labelled X?") that join would be over an unbounded set. It can't go
 * stale: `type` is declared at creation and immutable thereafter. Same trade
 * already made for `nodeId`.
 */
export interface RecordLabel {
  /** The labelled record. No FK — DSQL has none — so orphans are possible. */
  recordId: StarkeepId;
  /** Namespace. **Always** server-set from the authenticated subject. */
  appId: string;
  /** Key within that app's namespace. */
  key: string;
  /** Optional small scalar; `null` means a pure flag. */
  value: string | null;
  /** Denormalized from `records.type` (immutable), for read gating. */
  recordType: string;
  createdAt: HLCTimestamp;
  /** LWW key. Label rows have their own HLC and their own LWW domain. */
  updatedAt: HLCTimestamp;
  /** Denormalized from `updatedAt.nodeId`, per the existing convention. */
  nodeId: string;
  /** Retraction is a tombstone, not a hard delete, so the retraction syncs. */
  deletedAt: HLCTimestamp | null;
}

/**
 * A label identified for reading — `{ appId, key }` rather than a joined
 * string, so callers never construct the wire form themselves.
 */
export interface LabelRef {
  appId: string;
  key: string;
}

export function isValidLabelKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** UTF-8 byte length, which is what {@link LABEL_VALUE_MAX_BYTES} bounds. */
export function labelValueByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isValidLabelValue(value: string | null): boolean {
  if (value === null) return true;
  return labelValueByteLength(value) <= LABEL_VALUE_MAX_BYTES;
}

/**
 * Why a label write was rejected, as a caller-facing reason string, or `null`
 * when it is well-formed. Deliberately not an exception: both data servers turn
 * this into a 400 body, and the SDK surfaces it at the call site so a bulk job
 * fails on entry rather than three hours in.
 *
 * Note this validates *shape* only. Whether the key is declared in the app's
 * manifest is a separate check against `shared.app_label_keys`, made by the
 * data servers, because it depends on installed state this module can't see.
 */
export function validateLabelWrite(input: {
  key: string;
  value: string | null;
}): string | null {
  if (!isValidLabelKey(input.key)) {
    return (
      `invalid label key "${input.key}": must match ${KEY_PATTERN.source} ` +
      `(lowercase, starts alphanumeric, max ${LABEL_KEY_MAX_LENGTH} chars)`
    );
  }
  if (!isValidLabelValue(input.value)) {
    return (
      `label value for key "${input.key}" is ` +
      `${labelValueByteLength(input.value!)} bytes, over the ` +
      `${LABEL_VALUE_MAX_BYTES}-byte limit`
    );
  }
  return null;
}

/**
 * Render the wire/UI form of a label reference: `alpha/ocr-available`.
 * Storage never sees this — see the module docstring.
 */
export function formatLabelRef(ref: LabelRef): string {
  return `${ref.appId}/${ref.key}`;
}

/**
 * Parse the wire/UI form back into its parts. Returns `null` when malformed.
 *
 * Splits on the **first** `/` only: app ids contain no slash, and splitting
 * later would silently accept a key containing one — which `isValidLabelKey`
 * then rejects, so a malformed ref fails as a bad key rather than being
 * quietly reinterpreted.
 */
export function parseLabelRef(ref: string): LabelRef | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  const appId = ref.slice(0, slash);
  const key = ref.slice(slash + 1);
  if (!isValidLabelKey(key)) return null;
  return { appId, key };
}
