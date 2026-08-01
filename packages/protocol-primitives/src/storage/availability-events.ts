/**
 * Turning storage events into availability observations.
 *
 * Availability is a *maintained* fact — a `HeadObject` per record on listing is
 * O(library) and would make every grid scroll a storm of requests. Maintained
 * means something has to feed it, and this is the translation layer: raw
 * notifications in, observations out.
 *
 * Kept pure and provider-shaped-but-not-provider-coupled so it can be tested
 * without a cloud, and so the reconcile path (which sees inventory rows rather
 * than events) can produce the same observations by a different route.
 *
 * ## Why observations carry a timestamp
 *
 * These arrive out of order. A transition event and the daily inventory can
 * disagree about a key that moved in between, and delivery is at-least-once
 * with no ordering guarantee. Without an observation time there is no way to
 * tell which of two disagreeing answers is *newer* — only which arrived last,
 * which is not the same thing and is wrong about half the time.
 */

/** The storage-event kinds that change whether bytes can be read. */
export type AvailabilityEventKind =
  /** An object moved to a different storage class (lifecycle or manual copy). */
  | "transition"
  /** A restore finished; a temporary readable copy now exists. */
  | "restore-completed"
  /** A restored copy lapsed; the object is archived again. */
  | "restore-expired"
  /** The object no longer exists here. */
  | "removed";

export interface AvailabilityEvent {
  readonly kind: AvailabilityEventKind;
  readonly objectStorageKey: string;
  /** Storage class after the event, when the event reports one. */
  readonly storageClass?: string;
  /** Epoch ms the event describes. */
  readonly observedAtMs: number;
  /** For `restore-completed`: when the thawed copy lapses. */
  readonly restoredUntilMs?: number;
}

/** The shape this maps into — mirrors the stored availability row. */
export interface AvailabilityObservation {
  readonly objectStorageKey: string;
  readonly state: "instant" | "restoring" | "archived" | "absent";
  readonly tier: string | null;
  readonly expectedLatencyHours: number | null;
  readonly readyAtMs: number | null;
  readonly restoredUntilMs: number | null;
  readonly observedAtMs: number;
}

/**
 * Storage classes whose objects exist and **cannot be read**.
 *
 * `DEEP_ARCHIVE_ACCESS` and `ARCHIVE_ACCESS` are Intelligent-Tiering's
 * asynchronous tiers. Our bucket must never enable them — the installer asserts
 * no such configuration is created — but they are handled here anyway, because
 * "must never" is doing a lot of work in a sentence about someone else's
 * console, and the cost of ignoring them is a read that hangs for twelve hours
 * while `availability` insists everything is fine.
 */
const ARCHIVED_CLASSES: Readonly<Record<string, number>> = {
  DEEP_ARCHIVE: 12,
  DEEP_ARCHIVE_ACCESS: 12,
  GLACIER: 5,
  ARCHIVE_ACCESS: 5,
};

export function isArchivedClass(storageClass: string | undefined): boolean {
  return storageClass !== undefined && storageClass in ARCHIVED_CLASSES;
}

export function expectedLatencyHoursFor(storageClass: string): number {
  return ARCHIVED_CLASSES[storageClass] ?? 12;
}

/**
 * Map one event onto what it says about readability.
 *
 * Returns `null` for events that say nothing — a transition *into* an
 * instantly-readable class from another instantly-readable one, for instance.
 * Writing a row for those would be churn without information.
 */
export function observationFor(event: AvailabilityEvent): AvailabilityObservation | null {
  const base = {
    objectStorageKey: event.objectStorageKey,
    observedAtMs: event.observedAtMs,
  };

  switch (event.kind) {
    case "removed":
      return {
        ...base,
        state: "absent",
        tier: null,
        expectedLatencyHours: null,
        readyAtMs: null,
        restoredUntilMs: null,
      };

    case "restore-completed":
      // Readable *now*, but only until the thawed copy lapses. Recorded as
      // instant with an expiry rather than as its own state: a caller asking
      // "can I read this" wants yes, and the expiry is what lets a later
      // reconcile notice it has passed without another round trip.
      return {
        ...base,
        state: "instant",
        tier: event.storageClass ?? null,
        expectedLatencyHours: null,
        readyAtMs: null,
        restoredUntilMs: event.restoredUntilMs ?? null,
      };

    case "restore-expired":
      return {
        ...base,
        state: "archived",
        tier: event.storageClass ?? "DEEP_ARCHIVE",
        expectedLatencyHours: expectedLatencyHoursFor(event.storageClass ?? "DEEP_ARCHIVE"),
        readyAtMs: null,
        restoredUntilMs: null,
      };

    case "transition": {
      if (isArchivedClass(event.storageClass)) {
        const storageClass = event.storageClass!;
        return {
          ...base,
          state: "archived",
          tier: storageClass,
          expectedLatencyHours: expectedLatencyHoursFor(storageClass),
          readyAtMs: null,
          restoredUntilMs: null,
        };
      }
      // A transition between readable classes (Standard → Intelligent-Tiering,
      // or I-T's own automatic tiers) changes cost, not readability. Recording
      // it would be churn: one row per object per tiering decision, saying the
      // same thing every time.
      return null;
    }
  }
}

/**
 * Should a new observation replace a stored one?
 *
 * Strictly newer wins. Equal timestamps keep what is already there, because
 * at-least-once delivery means the same event can arrive twice and rewriting on
 * a tie is pure churn.
 *
 * The important case is the out-of-order one: a nightly inventory snapshot
 * taken at 03:00 must not overwrite a transition event that happened at 04:00,
 * even though it arrives afterwards. Comparing arrival order instead of
 * observation time gets that backwards and leaves the record claiming a state
 * it left an hour ago.
 */
export function shouldReplace(
  stored: { observedAtMs: number } | null,
  incoming: { observedAtMs: number },
): boolean {
  if (!stored) return true;
  return incoming.observedAtMs > stored.observedAtMs;
}
