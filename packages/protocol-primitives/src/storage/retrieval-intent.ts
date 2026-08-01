/**
 * Declared retrieval intent — what an app promises about how it will read these
 * bytes later.
 *
 * ## The vocabulary says nothing about AWS
 *
 * An app declares `instant` or `archive`. It does not name a storage class, a
 * tier, or a retrieval mode, because those are facts about one provider and the
 * app's actual claim is about *latency it can tolerate*. Keeping the vocabulary
 * at that level is what lets the storage layer change tiers — or run on a
 * different provider — without every writer being wrong.
 *
 * ## Why declared rather than inferred
 *
 * The alternative is a rule somewhere that decides "originals are cold". That
 * rule would have to know what an original is, which is app knowledge, and it
 * would be applied by a component with no way to know whether a given blob is
 * about to be read. Declaring it at write time puts the claim next to the
 * knowledge, and makes it reviewable: the set of `archive` writes in a codebase
 * is greppable, the set of blobs a heuristic decided to freeze is not.
 *
 * ## The safety property
 *
 * `instant` must be a promise the storage layer can *keep*, not a preference.
 * Anything written `instant` has to remain readable at normal latency for its
 * whole life — which is why the bucket must never enable Intelligent-Tiering's
 * asynchronous archive tiers, and why no app can freeze another app's data by
 * accident. `archive` is the only way to make something slow to read, and it
 * has to be asked for.
 */

/** What an app promises about reading these bytes later. */
export type RetrievalIntent =
  /**
   * Readable now, at normal latency, whenever read. The default, because a
   * write that forgot to think about retrieval must not produce something that
   * takes 12 hours to read.
   */
  | "instant"
  /**
   * May be unavailable for up to 48 hours when read. Only ever chosen for bytes
   * that no interactive path needs — in practice, an original whose derived
   * ladder is complete and durable.
   */
  | "archive";

export const RETRIEVAL_INTENTS: readonly RetrievalIntent[] = ["instant", "archive"];

/**
 * The default when a writer says nothing.
 *
 * `instant` rather than "whatever is cheapest", deliberately. The cost of a
 * wrong default in this direction is money; in the other direction it is a
 * user waiting half a day for a photo, having never asked for that trade.
 */
export const DEFAULT_RETRIEVAL_INTENT: RetrievalIntent = "instant";

export function isRetrievalIntent(value: string): value is RetrievalIntent {
  return (RETRIEVAL_INTENTS as readonly string[]).includes(value);
}

/**
 * Object tag marking a blob whose writer declared `archive` intent.
 *
 * This string is written by the presign path and read by the bucket's single
 * lifecycle rule, which live in different packages. It is defined once, here,
 * because a typo on either side is silent in both directions: objects that
 * never transition (a bill nobody notices) or — far worse, if the *other* tag
 * drifted — objects that transition before their ladder is complete, putting
 * the only readable copy of something behind a 48-hour thaw.
 */
export const INTENT_TAG_KEY = "starkeep:intent";

/**
 * Object tag asserting that every applicable derived class for this blob's
 * record is confirmed present in cloud storage.
 *
 * The archive lifecycle rule requires **both** this and the intent tag. That
 * conjunction is the whole safety argument for archiving originals: an original
 * whose ladder is incomplete is still the only readable form of that record, so
 * it stays instantly readable until something cheaper exists to read instead.
 */
export const LADDER_TAG_KEY = "starkeep:ladder";
export const LADDER_TAG_COMPLETE = "complete";

/** The tag set a blob of the given intent is written with. */
export function tagsForIntent(intent: RetrievalIntent): Record<string, string> {
  // `instant` carries no tag at all rather than `intent=instant`. The lifecycle
  // rule filters on the presence of the archive tag, so an untagged object is
  // structurally ineligible to transition — a stronger guarantee than one that
  // depends on a rule reading a value correctly.
  return intent === "archive" ? { [INTENT_TAG_KEY]: "archive" } : {};
}
