/**
 * Record availability — whether the bytes behind a record can be read right
 * now, reported by whichever data server was asked, about **its own** storage.
 *
 * The same record is `instant` on the laptop and `archived` in the cloud, and
 * both answers are correct. That is why this is not a field on the shared
 * record: it is not a property of the record, it is a property of a node's
 * relationship to it.
 *
 * ## Why this exists at all
 *
 * Without it, "can I read this?" is answerable only by trying, and the failure
 * arrives as a stalled image somewhere in a UI. With it, the question is
 * answered in the listing the client already fetched, before anything is
 * attempted — which is what makes archiving originals safe *by construction*
 * rather than by every call site remembering not to touch them.
 *
 * ## Maintained, not computed
 *
 * A per-record `HeadObject` on listing is O(library) and would make every grid
 * scroll a storm of storage requests. So this is a stored fact, updated by
 * transition and restore events, with a periodic inventory reconcile as the
 * backstop. The consequence to accept: it can be briefly stale. It is designed
 * so staleness fails safe — see {@link DEFAULT_AVAILABILITY}.
 */

/** Whether a node can serve these bytes, and if not, what it would take. */
export type RecordAvailability =
  /** Readable now, at normal latency. */
  | { readonly state: "instant" }
  /** A restore is in flight. `readyAt` is an ISO timestamp, or null if unknown. */
  | { readonly state: "restoring"; readonly readyAt: string | null }
  /**
   * Requires an explicit restore. Carries what the caller needs to decide
   * whether to ask for one — never to trigger one.
   */
  | {
      readonly state: "archived";
      readonly tier: string;
      readonly expectedLatencyHours: number;
    }
  /**
   * This node does not hold the bytes. An `Elided` record on a node that
   * declined them, or a `no-cloud` record in the cloud.
   *
   * Distinct from `archived`: archived bytes exist and can be thawed, absent
   * bytes are simply not here and must be fetched from a node that has them.
   * Collapsing the two would send a client to a restore endpoint that has
   * nothing to restore.
   */
  | { readonly state: "absent" };

/**
 * What a node assumes about an object it has never heard anything about.
 *
 * `instant`, deliberately. Objects are written to an instantly-readable class
 * and only *become* archived by a transition — which is an event this store is
 * told about. So "no row" genuinely means "nothing has moved it", and the
 * failure mode of being wrong is a 409 from the read path (recoverable, and
 * self-correcting once the event or the reconcile lands). Defaulting to
 * `archived` would be safe in the opposite direction and useless: every record
 * would look unreadable until something proved otherwise.
 */
export const DEFAULT_AVAILABILITY: RecordAvailability = { state: "instant" };

/** True when a read can be served without restoring anything first. */
export function isReadableNow(availability: RecordAvailability): boolean {
  return availability.state === "instant";
}

/**
 * An estimate for restoring one object, returned *before* anything is done.
 *
 * A restore costs money and takes hours, and both numbers are invisible at the
 * moment someone clicks. Returning them as a distinct step — rather than as a
 * message alongside a restore already in flight — is what makes the cost a
 * decision instead of a discovery.
 */
export interface RestoreEstimate {
  readonly objectCount: number;
  readonly bytes: number;
  /** Retrieval tier that would be used, e.g. "Standard". */
  readonly tier: string;
  readonly estimatedHours: number;
  /** Retrieval charge in USD. Approximate, and labelled as such to callers. */
  readonly estimatedCostUsd: number;
  /** How long the thawed copy stays readable before lapsing back. */
  readonly availableForDays: number;
}

/**
 * Retrieval pricing, per GB, for the tiers we actually use.
 *
 * Standard rather than Bulk for single-item restores: the difference is
 * hundredths of a cent and 36 hours. Bulk is only worth it for batch restores,
 * where the wait is expected and the object count makes the cents add up.
 */
export const RESTORE_TIERS = {
  Standard: { hours: 12, usdPerGb: 0.02 },
  Bulk: { hours: 48, usdPerGb: 0.0025 },
} as const;

export type RestoreTier = keyof typeof RESTORE_TIERS;

export function estimateRestore(
  bytes: number,
  objectCount: number,
  tier: RestoreTier,
  availableForDays: number,
): RestoreEstimate {
  const { hours, usdPerGb } = RESTORE_TIERS[tier];
  return {
    objectCount,
    bytes,
    tier,
    estimatedHours: hours,
    estimatedCostUsd: (bytes / 1024 ** 3) * usdPerGb,
    availableForDays,
  };
}
