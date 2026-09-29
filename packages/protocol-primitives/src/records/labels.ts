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
 *
 * ## A key is set-valued, and there is no NULL
 *
 * The primary key is `(record, app, key, value)`, so one app may assert the same
 * key many times over one record with different values: `photos/faces=Alice` and
 * `photos/faces=Bob` are two rows. That is what makes a value *searchable* —
 * `findByLabel({ key: "faces", value: "Alice" })` is an index range scan, where a
 * joined `"Alice,Bob"` packed into one row would need a substring match that no
 * index can serve and that would match "Alicent" besides.
 *
 * Because a PK column cannot be nullable, `value` is NOT NULL and **a bare flag
 * is just the empty string**. There is no "flag vs. valued" distinction to model:
 * the state that carries meaning is row-present vs. row-absent, and NULL only
 * ever duplicated what absence already said. Dropping it also removes a real
 * divergence — SQLite sorts NULLs first in an ASC scan and Postgres sorts them
 * last, so the reverse cursor previously had to normalize an ordering the two
 * backends disagreed about.
 *
 * A set-valued key needs a **value cardinality** cap as well as a key cardinality
 * one, for the same reason the key cap exists — see
 * {@link LABEL_VALUES_PER_KEY_MAX}.
 */

import type { StarkeepId } from "../identifiers/types.js";
import type { HLCTimestamp } from "../hlc/types.js";

/** Max characters in a label key. */
/**
 * The label key that advises the platform against archiving a record.
 *
 * Labels live in per-app namespaces, so the platform cannot reserve one shared
 * key every app writes. It defines this key *name* instead and honours it in
 * any app's namespace: Photos writes `photos/do-not-archive`, another app the
 * same key under its own id. A record stays unarchived while any namespace
 * holds it, and each app removes only its own.
 */
export const DO_NOT_ARCHIVE_LABEL_KEY = "do-not-archive";

/**
 * Keys every app may write in its own namespace without declaring them in its
 * manifest, because the platform itself gives them their meaning. They do not
 * count against {@link LABEL_KEYS_PER_APP_MAX}: the cap bounds an app's own
 * schema, and these are the platform's.
 */
export const WELL_KNOWN_LABEL_KEYS: ReadonlySet<string> = new Set([DO_NOT_ARCHIVE_LABEL_KEY]);

export const LABEL_KEY_MAX_LENGTH = 64;
/** Max distinct keys one app may declare in its manifest. */
export const LABEL_KEYS_PER_APP_MAX = 64;
/** Max bytes (UTF-8, not characters) in a label value. */
export const LABEL_VALUE_MAX_BYTES = 128;
/**
 * Max distinct values one app may assert for one key on one record.
 *
 * The per-app key cap is what forces keys to be schema; this is its counterpart
 * now that a key is set-valued, and it exists for the same reason. Without it an
 * app can chunk arbitrary content across the values of a single declared key,
 * which both evades the key cap and bloats the reverse index — where a scan for
 * one value pays for every value stored beside it.
 *
 * 32 is far past any honest use (a 32-person group photo) and far short of
 * useful as a smuggling channel.
 */
export const LABEL_VALUES_PER_KEY_MAX = 32;

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
  /**
   * Small scalar, and part of the primary key — one key may carry many. Never
   * null: `""` is the whole representation of a bare flag.
   */
  value: string;
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

/** `""` is valid — it is how a bare flag is stored, not a missing value. */
export function isValidLabelValue(value: string): boolean {
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
  value: string;
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
      `${labelValueByteLength(input.value)} bytes, over the ` +
      `${LABEL_VALUE_MAX_BYTES}-byte limit`
    );
  }
  return null;
}

/** One label a caller asked to set. `appId` is absent by construction — it is
 *  the authenticated subject, not something the request can name. */
export interface LabelWriteRequest {
  recordId: StarkeepId;
  key: string;
  /** Omitted sets a bare flag — i.e. the empty string. */
  value?: string;
}

/** One label a caller asked to retract. */
export interface LabelRetractRequest {
  recordId: StarkeepId;
  key: string;
  /**
   * Which value to retract. **Omitted retracts every value of this key on this
   * record** — the only reading that keeps `{recordId, key}` meaning "take this
   * assertion back" now that a key is set-valued. Passing `""` retracts the bare
   * flag specifically, and nothing else.
   */
  value?: string;
}

export interface PlannedLabelWrite {
  recordId: StarkeepId;
  key: string;
  value: string;
  recordType: string;
}

/**
 * Map key for the per-`(record, key)` value set — see
 * {@link planLabelWrites}'s `existingValues`. Exported so the servers that
 * build the map and the check that reads it cannot disagree about the encoding.
 */
export function labelValueSetKey(recordId: StarkeepId, key: string): string {
  return JSON.stringify([recordId, key]);
}

export type LabelPlan<T> =
  | { ok: true; writes: T[] }
  | { ok: false; error: string; status: 400 | 403 };

/**
 * Collapse repeats of the same `(recordId, key, value)` in one batch, keeping
 * the **last** — which is what a caller who wrote the same row twice meant, and
 * what SQLite already does.
 *
 * The tuple includes `value` because `value` is in the primary key: two entries
 * differing only in value are two *different* rows and must both survive.
 * Deduping on `(recordId, key)` would silently keep only the last value, turning
 * every set-valued write into a single-valued one — a bug that produces
 * perfectly plausible output and no error.
 *
 * This is not a tidiness measure. A multi-row `INSERT … ON CONFLICT DO UPDATE`
 * that touches the same row twice is an *error* on Postgres/DSQL —
 * `21000: ON CONFLICT DO UPDATE command cannot affect row a second time` —
 * while SQLite applies them in order and keeps the last. Left undeduped, the
 * same batch succeeds against a local data server and fails against the cloud
 * one, which is the worst shape a divergence can take: it passes every test
 * that runs offline.
 *
 * Deduping rather than rejecting because a repeat is not a mistake worth
 * failing a 3,000-row bulk job over, and "last wins" is the only reading that
 * matches the row it would have left behind.
 */
export function dedupeLabelWrites<
  T extends { recordId: StarkeepId; key: string; value?: string },
>(entries: T[]): T[] {
  const byPk = new Map<string, T>();
  // JSON, not a delimiter-joined string. The tuple now includes a caller-supplied
  // value, so a single-character separator would let ("a b", "c") and ("a", "b c")
  // collide and silently drop one of two distinct rows. A NUL separator dodges
  // that, but makes this file binary to git and invisible to grep — which is a
  // steep price for a hot path that runs once per batch.
  for (const entry of entries) {
    byPk.set(JSON.stringify([entry.recordId, entry.key, entry.value ?? null]), entry);
  }
  return [...byPk.values()];
}

/**
 * Decide whether a batch of label writes is allowed, and shape it for the
 * adapter. Pure, so both data servers share one gate rather than two that
 * drift — the failure mode being one backend enforcing a rule the other
 * doesn't.
 *
 * `recordTypes` maps record id → `records.type` for the records that exist.
 * The caller loads it in one `SELECT id, type WHERE id IN (…)` over the batch,
 * which is very likely the dominant cost of a bulk labelling job — the
 * single-statement upsert hides that this read has to happen first.
 *
 * `existingValues` maps {@link labelValueSetKey} → the values this app already
 * has live on that `(record, key)`. It exists so the
 * {@link LABEL_VALUES_PER_KEY_MAX} cap counts *stored* values and not merely
 * the ones in front of it: a cap that only looked at the batch would be cleared
 * by sending 32 values thirty times, which is precisely the smuggling channel
 * it is there to close. Omitting it checks the batch alone — right for a caller
 * that has no store to consult yet, wrong for a data server.
 *
 * Five things are checked, in the order that fails cheapest first:
 *
 *  1. **Key and value shape** — see {@link validateLabelWrite}.
 *  2. **The key is declared** in the app's manifest. This is what makes the
 *     per-app key-cardinality cap enforceable, and it is the reason keys are
 *     schema rather than content.
 *  3. **The record exists.** No FK backs `record_id`, so a write against a
 *     missing record would create an orphan silently. (Orphans arriving over
 *     *sync* are fine and expected — that path must not check this.)
 *  4. **The caller can read the record's type.** A `read` grant, not
 *     `readwrite`: requiring write access would force every labelling app —
 *     an OCR service, a classifier — to hold destructive power over photos it
 *     only ever reads. Labelling is additive, namespaced, quota-bounded and
 *     advisory, so reading is the right price.
 *  5. **The value cardinality cap**, over stored ∪ incoming values — see
 *     `existingValues` above.
 *
 * Every entry is checked before anything is deduped, so a repeated key that is
 * *also* malformed still fails rather than being collapsed away — and the
 * writes returned are {@link dedupeLabelWrites}d, because the multi-row upsert
 * they feed cannot touch one row twice on DSQL.
 */
export function planLabelWrites(input: {
  entries: LabelWriteRequest[];
  recordTypes: ReadonlyMap<string, string>;
  declaredKeys: ReadonlySet<string>;
  canReadType: (type: string) => boolean;
  /** Live values already stored for this app, keyed by {@link labelValueSetKey}. */
  existingValues?: ReadonlyMap<string, ReadonlySet<string>>;
}): LabelPlan<PlannedLabelWrite> {
  const writes: PlannedLabelWrite[] = [];
  for (const entry of input.entries) {
    // Omitted value = bare flag = the empty string. There is no null.
    const value = entry.value ?? "";

    const shapeError = validateLabelWrite({ key: entry.key, value });
    if (shapeError) return { ok: false, error: shapeError, status: 400 };

    if (!input.declaredKeys.has(entry.key) && !WELL_KNOWN_LABEL_KEYS.has(entry.key)) {
      return {
        ok: false,
        error:
          `label key "${entry.key}" is not declared in this app's manifest ` +
          `(infraRequirements.labelKeys)`,
        status: 400,
      };
    }

    const recordType = input.recordTypes.get(entry.recordId);
    if (recordType === undefined) {
      return {
        ok: false,
        error: `record "${entry.recordId}" does not exist`,
        status: 400,
      };
    }

    if (!input.canReadType(recordType)) {
      return {
        ok: false,
        error: `no read grant on type "${recordType}" (record "${entry.recordId}")`,
        status: 403,
      };
    }

    writes.push({ recordId: entry.recordId, key: entry.key, value, recordType });
  }

  // Value cardinality, checked after deduping so a caller who repeated a row is
  // not charged twice for it, and counted over the union with what is already
  // stored — re-writing a value the app already has costs nothing, adding a new
  // one costs a slot.
  const deduped = dedupeLabelWrites(writes);
  const perKey = new Map<string, Set<string>>();
  for (const w of deduped) {
    const k = labelValueSetKey(w.recordId, w.key);
    let seen = perKey.get(k);
    if (!seen) {
      seen = new Set(input.existingValues?.get(k) ?? []);
      perKey.set(k, seen);
    }
    seen.add(w.value);
    if (seen.size > LABEL_VALUES_PER_KEY_MAX) {
      return {
        ok: false,
        error:
          `more than ${LABEL_VALUES_PER_KEY_MAX} values for key "${w.key}" on ` +
          `record "${w.recordId}"`,
        status: 400,
      };
    }
  }
  return { ok: true, writes: deduped };
}

/**
 * Validate a batch of retractions.
 *
 * Deliberately checks **less** than {@link planLabelWrites}:
 *
 *  - **The key need not still be declared.** An uninstall, or an upgrade that
 *    drops a key, revokes the declaration while the label rows survive as
 *    shared data. Validating the key here would strand those rows permanently
 *    out of their own author's reach — which is exactly what the obvious
 *    implementation, one that runs every write through the same gate, does.
 *  - **The record need not exist.** Retracting a label on a deleted record is
 *    a no-op, not an error.
 *  - **No grant check.** Retraction is scoped by the primary key, which
 *    contains the server-set `app_id`, so an app can only ever reach its own
 *    rows. There is nothing further to authorize.
 */
export function planLabelRetractions(
  entries: LabelRetractRequest[],
): LabelPlan<LabelRetractRequest> {
  for (const entry of entries) {
    if (!isValidLabelKey(entry.key)) {
      return {
        ok: false,
        error: `invalid label key "${entry.key}"`,
        status: 400,
      };
    }
  }
  // Deduped for the round trips, not for correctness: retraction is a loop of
  // primary-key UPDATEs, so a repeat is merely a second identical statement.
  return { ok: true, writes: dedupeLabelWrites(entries) };
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
