/**
 * The node-local half of an app's private blob plane.
 *
 * Four questions an app asks about its own bytes that the storage adapter
 * cannot answer, because every one of them is about *this machine*: what am I
 * holding here, note that I opened this, let these bytes go without letting the
 * file go, and get these bytes back. The answers live in the sync engine's
 * resident set and in the sync engine itself, and neither belongs in this
 * package — so the host supplies them and the app-syncable view calls them.
 *
 * ## Why an app asks at all
 *
 * The platform stopped deciding. An app namespace has one advisory ceiling and
 * the eviction pass does not run over it, because the platform cannot tell a
 * disposable rendition from the only recording of something somebody said —
 * both arrive as an opaque blob in an app's prefix. So the platform measures
 * and reports, and the app spends its own budget.
 *
 * ## Why a port rather than a direct dependency
 *
 * A data server with no residency manager is an ordinary configuration — the
 * cloud has no budget and holds everything — and it still has to answer these
 * four requests, or every app would branch on which backend it is talking to.
 * The port is optional, and {@link AppSpecificOperations} answers the
 * no-residency case from the file index alone.
 */

/**
 * How many sub-keys one targeted residency lookup may name.
 *
 * Matches the query grammar's `in`-list cap, because the cloud answers this
 * question with one, and a caller allowed to ask for more here would get a
 * parse error there instead of an answer.
 */
export const MAX_RESIDENCY_LOOKUP_KEYS = 500;

/** One blob of an app's private plane, as the app sees it. */
export interface AppBlobEntry {
  /** The app-relative key the app addresses the file by. */
  readonly subKey: string;
  readonly sizeBytes: number;
  /** Whether the bytes are on this node now. */
  readonly resident: boolean;
  /** Epoch ms this blob was last opened here, or null if never. */
  readonly lastOpenedAtMs: number | null;
}

/** One page of "what am I holding here". */
export interface AppBlobResidencyPage {
  /**
   * The ceiling this app may hold on this node, or null where there is none.
   *
   * Null is the cloud: it is the durable replica and holds what it is given.
   * A number is advisory — the platform reports an overrun and never acts on
   * one — and it is reported to the app rather than only to the operator
   * because the app is the party that can act on it.
   */
  readonly budgetBytes: number | null;
  /** What the app is holding here now, across every one of its blobs. */
  readonly heldBytes: number;
  readonly entries: readonly AppBlobEntry[];
  /** Pass back as `cursor` for the next page. Null at the end. */
  readonly nextCursor: string | null;
}

/** What the app's file row says about a blob, which only the app plane can read. */
export interface AppBlobIdentity {
  readonly objectStorageKey: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}

/** Why a drop went through, or did not. */
export interface AppBlobDropResult {
  readonly dropped: boolean;
  /**
   * `not-held` — this node does not have the bytes, so there is nothing to
   * drop. `not-durable` — this app did not declare its private blobs
   * re-derivable and no confirmed replica was found, so dropping would be
   * losing. `refused` — this node does not drop app blobs at all, which is the
   * cloud's answer.
   */
  readonly reason: "dropped" | "not-held" | "not-durable" | "refused";
  /** Confirmed replicas found, where a durability check ran. */
  readonly confirmedReplicas?: number;
}

/** Whether the bytes are here now, and why not if they are not. */
export interface AppBlobFetchResult {
  readonly landed: boolean;
  /**
   * `already-here` — the bytes were already on this node. `declined` — the
   * residency policy refused, which for an app plane means the operator has
   * budgeted this app to nothing. `unavailable` — nowhere to fetch from, or the
   * transfer failed.
   */
  readonly reason: "landed" | "already-here" | "declined" | "unavailable";
}

export interface AppBlobPlane {
  /**
   * What this node holds of the app's plane, or null when it keeps no
   * accounting of that at all.
   *
   * Null is a node with no retention policy, which is the ordinary laptop: it
   * has no ceiling, evicts nothing, and pulls every blob a round offers it. It
   * genuinely holds what it has rows for, and the caller answers from the file
   * index rather than reporting an empty plane — which is what an app would
   * otherwise read as "none of my bytes are here" for every file it owns.
   */
  residency(appId: string, cursor: string | null): Promise<AppBlobResidencyPage | null>;
  /**
   * The same answer as {@link residency}, for blobs the caller can already
   * name.
   *
   * The paged listing answers "what am I holding here", which is the question
   * an app asks when it is deciding what to give up. A read path asks the
   * opposite one — "of these forty blobs I am about to paint, which are
   * here" — and walking a plane of three hundred thousand renditions to learn
   * the state of forty is the wrong shape by five orders of magnitude.
   *
   * Keys with no row are omitted rather than reported absent, so a caller
   * reads presence off the result the way it reads it off a file listing.
   */
  lookup(
    appId: string,
    objectStorageKeys: readonly string[],
  ): Promise<readonly AppBlobEntry[] | null>;
  /**
   * Charge bytes the app just wrote here to the app's budget.
   *
   * Without it the whole surface is empty on the node that authored the bytes.
   * An app file is written by presigning, uploading straight to storage and
   * registering the row, so nothing on that path passes through the sync
   * engine — and a budget that only counts what *arrived* would report zero on
   * the machine actually holding the files, which is every desktop.
   */
  noteWritten(appId: string, blob: AppBlobIdentity): Promise<void>;
  /** Record an open, for the order the app gives blobs up in. */
  touch(appId: string, blob: AppBlobIdentity, atMs: number): Promise<void>;
  drop(appId: string, blob: AppBlobIdentity): Promise<AppBlobDropResult>;
  fetch(appId: string, blob: AppBlobIdentity): Promise<AppBlobFetchResult>;
}
