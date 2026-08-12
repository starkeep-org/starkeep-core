import type {
  StarkeepId,
  HLCTimestamp,
  AnyRecord,
  RecordLabel,
} from "@starkeep/protocol-primitives";
import type {
  DatabaseAdapter,
  DigestBucket,
  ObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import type {
  BlobCandidate,
  ResidencyTrigger,
  ResidencyVerdict,
  ResolvedSizeClass,
} from "./residency-policy.js";
import type { StreamTruncation } from "./round-cut.js";

/**
 * The fetch-time residency decision. Async because a real implementation reads
 * the node's byte accounting and the record's labels.
 *
 * `trigger` names what is asking, because two of the policy's rules turn on it
 * and a decider that could not tell a round from a background pass would have
 * to apply the same one to both. See {@link ResidencyTrigger}: a round may not
 * displace already-held bytes, and only a direct request ignores `prefetch`.
 *
 * Passed as an argument rather than split into two hooks because it is a
 * property of the *occasion*, not an authority the caller is claiming — the one
 * thing this codebase does insist on naming at the call site is the right to
 * bypass the policy, and none of these three do.
 */
export type ResidencyDecider = (
  candidate: BlobCandidate,
  trigger: ResidencyTrigger,
) => Promise<ResidencyVerdict> | ResidencyVerdict;

/**
 * The decision and the accounting that follows from it, together — because a
 * budget that isn't updated when bytes land is a budget that never binds. The
 * two were split in an earlier draft and the split let a node decide "yes,
 * room for this" forever.
 */
export interface ResidencyHooks {
  decide: ResidencyDecider;
  /**
   * Called after a blob has actually landed locally, not when it was decided
   * on. A transfer that fails must not move the byte accounting, or the node
   * slowly convinces itself it is full of things it doesn't have.
   */
  onLanded?(candidate: BlobCandidate, verdict: ResidencyVerdict): void | Promise<void>;
  /**
   * Charge the budget for bytes a `fetch` verdict is about to pull, before they
   * arrive; `release` undoes it when they do not.
   *
   * The pair exists for one situation and is a no-op everywhere else: several
   * engines sharing one host's byte accounting. The supervisor hands the same
   * hooks to the Drive engine and to every per-app engine, each with its own
   * timer, so two ticking at once each read the usage, each see room for a
   * 400 MB video, and each land it. Within a single engine the inbound loop is
   * sequential and no reservation is needed — which is why this is optional and
   * why a host without the problem can leave both out.
   */
  reserve?(candidate: BlobCandidate, verdict: ResidencyVerdict): void | Promise<void>;
  release?(objectStorageKey: string): void | Promise<void>;
  /**
   * Which size class this candidate belongs to, without deciding anything.
   *
   * Exists for {@link SyncEngine.fetchBlob}, which must charge an arrival to the
   * right budget while **not** consulting {@link decide} — the fetch answers a
   * direct request, and asking the decider would let a policy refuse a photo
   * somebody just opened, or record a second decision that never happened.
   *
   * Resolving the class is the host's job either way: the sync engine must not
   * learn what `image-medium` is.
   */
  classOf?(
    candidate: BlobCandidate,
  ): Promise<ResolvedSizeClass | null> | ResolvedSizeClass | null;
  /**
   * Write down a blob this round wanted and could not take, so something can
   * come back for it.
   *
   * Called for exactly one verdict — `elide` with `budget-exhausted` — and the
   * narrowness is the point. The other elide reasons are standing refusals:
   * `not-prefetched` classes exist *precisely* so they are not acquired
   * speculatively, and queueing them would make `prefetch: false` mean nothing;
   * `class-disabled` and `record-constraint` are the node saying no rather than
   * saying not now.
   *
   * A round that defers keeps its own behaviour otherwise: the blob is still
   * elided, the watermark still advances. What changes is that the record is no
   * longer only reachable through a user tapping it — which is what made a
   * budget on a phone a one-way door.
   *
   * Optional, and a host without a queue simply omits it. It must also never be
   * allowed to fail a round: see the call site in `pullBlob`.
   */
  defer?(candidate: BlobCandidate, verdict: ResidencyVerdict): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-table schema info stored in the namespace registry so appliers can UPSERT
// by PK without re-consulting the manifest at apply time.
// ---------------------------------------------------------------------------

export interface AppSyncableTableInfo {
  readonly name: string;
  readonly pkColumns: string[];
}

export interface AppSyncableNamespace {
  readonly appId: string;
  readonly tables: AppSyncableTableInfo[];
  readonly filesEnabled: boolean;
  /** Derived from tables — convenience accessor. */
  readonly tableNames: string[];
}

export interface AppSyncableNamespaceStore {
  get(appId: string): AppSyncableNamespace | null;
  list(): AppSyncableNamespace[];
}

// ---------------------------------------------------------------------------
// App-syncable row wire type — the exchange protocol synthesizes these inline
// by scanning updated_at per table and filtering against the caller's
// watermarks.
// ---------------------------------------------------------------------------

export interface AppSyncableRowEntry {
  readonly timestamp: HLCTimestamp;
  readonly appId: string;
  /** Bare table name (no engine prefix on the wire). */
  readonly table: string;
  readonly op: "insert" | "update" | "delete";
  readonly row?: Record<string, unknown>;
  readonly where?: Record<string, unknown>;
}

export interface AppSyncableApplier {
  apply(entry: AppSyncableRowEntry): Promise<void> | void;
}

/** Page returned by `ScanCapableApplier.scanSince`. */
export interface ScanSincePage {
  readonly rows: AppSyncableRowEntry[];
  /**
   * Whether rows were left behind by the `limit`. Not a pagination token —
   * there is nothing to resume from, because the peer's watermark has not
   * advanced past the leftovers and the next round selects them again from
   * the top. It exists to answer "should we sync again immediately?".
   */
  readonly hasMore: boolean;
  /**
   * How far this table's scan got, per author — the input `round-cut.ts` needs
   * to keep a shipment a contiguous prefix across every table the coverage
   * watermark spans.
   *
   * Absent entry → enumerated completely. `HLCTimestamp` → complete only up to
   * that row. `null` → not read at all, so nothing may ship for that author.
   */
  readonly truncated: StreamTruncation;
}

/**
 * Optional capability that appliers can implement to support exchange
 * synthesis. Returns rows the peer hasn't seen —
 * `updated_at > peerWatermarks[node_id]` per author, oldest first within each
 * author, capped at `limit`.
 *
 * The bound is **per author**, not one global floor. A global floor could only
 * safely be the minimum across authors, which on a node holding writes from
 * several peers at different positions degrades to "scan everything" — the cost
 * this method exists to avoid. Backed by the `(node_id, updated_at)` index that
 * every app-syncable table already carries
 * (`admin-installer/src/local/registry.ts`, `src/dsql-ddl.ts`).
 *
 * No cursor: every row returned is genuinely owed, so a caller wanting more
 * asks again once the peer's watermark advances. See `DatabaseAdapter.querySince`
 * for the same contract on shared records.
 */
export interface ScanCapableApplier extends AppSyncableApplier {
  scanSince(
    appId: string,
    table: string,
    peerWatermarks: Watermarks,
    limit: number,
  ): Promise<ScanSincePage>;

  /**
   * Per-nodeId MAX(updated_at) over every stored row of one table
   * (tombstones included) —
   * the responder-side summary that feeds `responderWatermarks`. Backed by
   * the denormalized `node_id` column + `(node_id, updated_at)` index so it
   * doesn't scan the table.
   *
   * A **missing** table returns `{}` — the app is not installed here, it
   * genuinely holds nothing, and an omitted node only causes a re-ship. A table
   * that exists and will not read **throws**, and the two must not be
   * conflated: `scanSince` plans its authors from this map, so a `{}` for an
   * unreadable table becomes a scan that reports "nothing owed, every author
   * complete" — silent loss, one frame above the catch written to prevent it.
   */
  getNodeWatermarks(appId: string, table: string): Promise<Watermarks>;

  /**
   * Bucketed row counts for one table — the app-syncable half of
   * `DatabaseAdapter.bucketDigest`, and the reason a per-app channel can be
   * integrity-checked at all.
   *
   * Without it `verify()` on a per-app channel would compare shared-record
   * digests over a channel that never carries shared records: divergence that
   * means nothing, and repair floors for rows the channel cannot ship.
   *
   * A **missing** table returns `[]`. A table that exists and will not read
   * **throws**. `[]` is the wire value for "this table holds nothing", and
   * using it for "I could not count it" makes every bucket in the table read as
   * a hole — an undercount locally reports the peer's rows as our own loss and
   * arms a full re-download; an undercount on the responder re-ships the
   * library. Neither is fail-safe, which is why this is the one place in the
   * applier contract that is allowed to fail loudly.
   */
  bucketDigest(
    appId: string,
    table: string,
    prefixLength?: number,
  ): Promise<DigestBucket[]>;
}

/**
 * A row read from the framework-owned `_starkeep_sync_records` table.
 * Mirrors the column shape declared in `@starkeep/shared-space-api`'s
 * `FILE_RECORDS_COLUMNS` plus the always-appended HLC bookkeeping columns.
 * The sync engine's file-transfer pass derives upload/download decisions
 * from blob presence (`localObjectStorage.has(key)`), not from any stored
 * status — there is no `sync_status` column on this row. See
 * `residency.ts` (`RecordResidency`, `residencyOf`) for the named derived
 * state, and `system-design.md` "Per-record residency" for the rationale.
 */
export interface FileRecordRow {
  readonly id: string;
  readonly object_storage_key: string;
  readonly content_hash: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly original_filename: string | null;
  readonly origin_app_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Version-vector exchange protocol — each side maintains a per-channel
// { [nodeId]: HLC } map of "what I've seen per replica" and ships records the
// peer hasn't seen. Conflict resolution is pure HLC LWW on shared records.
// ---------------------------------------------------------------------------

export type Watermarks = Record<string /* nodeId */, HLCTimestamp>;

export interface SyncExchangeRequest {
  /** Caller's view of what it has seen per nodeId. */
  readonly watermarks: Watermarks;
  /** Records the caller believes the peer hasn't seen yet. */
  readonly records?: AnyRecord[];
  /**
   * Cross-app record labels the caller believes the peer hasn't seen. Shared
   * data, so they ride the **Drive channel** with records under
   * `app-starkeep-drive-role` — no new channel, and a per-app channel
   * (`syncSharedRecords=false`) must drop them inbound exactly as it drops
   * shared records.
   *
   * Labels are a second stream on the same channel, applied in merged per-node
   * HLC order with records. That merge is what keeps the coverage watermark
   * honest: it is only valid because holdings stay a contiguous per-node
   * prefix, and with two streams that has to hold *across both*.
   */
  readonly labels?: RecordLabel[];
  /** App-syncable row deltas the caller believes the peer hasn't seen. */
  readonly appSyncableRows?: AppSyncableRowEntry[];
  /** Max items the responder should ship in this round. */
  readonly limit?: number;
  /**
   * Byte budget for what the responder ships back, mirroring the requester's
   * own round budget. Rows with no blob spend none of it.
   *
   * Without this the cap is asymmetric: a node that limits itself to 10 MB
   * outbound could still be handed a hundred blob-carrying records inbound and
   * be expected to pull every one of them.
   *
   * Optional so an older peer that omits it still works — the responder then
   * falls back to its own default rather than shipping unbounded bytes.
   */
  readonly maxBytes?: number;
  /**
   * Ask the responder to include its bucketed row counts in the reply.
   *
   * The integrity check the coverage watermark cannot perform: a peer that
   * loses a row from the *middle* of an author's range keeps the same
   * `MAX(updated_at)`, so its watermark is unchanged and the sender never
   * learns. Comparing per-bucket counts finds it. See `digest-queries.ts`.
   *
   * Opt-in and occasional. It is a `GROUP BY` over the whole index — cheap, but
   * far too expensive to run every round, and it answers a question that only
   * changes when something has gone wrong.
   */
  readonly requestDigest?: boolean;
  /**
   * Bucket width, as a count of leading `updated_at` hex digits.
   *
   * On the wire rather than assumed on both sides, because two peers bucketing
   * at different widths would find *every* bucket disagreeing — a whole-library
   * "repair" reported as catastrophic divergence — and nothing in the exchange
   * would reveal why. The responder echoes back what it actually used
   * ({@link SyncExchangeResponse.digestPrefixLength}) so the requester can
   * refuse to compare rather than compare wrongly.
   */
  readonly digestPrefixLength?: number;
}

export interface SyncExchangeResponse {
  /** Records the caller hasn't seen (`updated_at > callerWatermarks[nodeId]`). */
  readonly records: AnyRecord[];
  /** Labels the caller hasn't seen, by the same per-nodeId delta rule. */
  readonly labels: RecordLabel[];
  /** Same delta logic per app schema. */
  readonly appSyncableRows: AppSyncableRowEntry[];
  /**
   * The responder's **coverage watermark** per nodeId, computed over its full
   * channel state *after* applying this request's inbound payload.
   *
   * Coverage semantics, not "live MAX": `responderWatermarks[n] = h` asserts
   * "I have durably incorporated everything from node `n` up to `h`; anything
   * at-or-below `h` that I don't hold, I chose to discard." Today no
   * discard/compaction mechanism exists, so the value is simply the per-node
   * MAX(updated_at) over live rows — but callers must treat it as coverage so
   * a future GC can fold a persisted compaction floor into this value
   * (raising the floor before deleting) without a protocol change.
   *
   * The caller replaces (not merges) its `peerWatermarks` with this map.
   * Replacement is what lets the watermark move *down* when the responder
   * genuinely holds less (wipe, redeploy, failed apply), forcing a re-ship.
   * Valid as a summary only because holdings stay a contiguous per-node
   * prefix — both sides apply per node in HLC order and stop on failure.
   *
   * On the Drive channel this is a **union over both tables**: records and
   * labels. The contiguous-prefix claim therefore has to hold across two
   * streams, which is why they are merged into one per-node HLC order and a
   * failure halts the whole node rather than just its own stream. Getting
   * that wrong doesn't corrupt data — LWW is idempotent and a re-ship is
   * harmless — but it can make a watermark overstate coverage and silently
   * drop a label.
   *
   * ## Rows, never bytes
   *
   * **This is coverage over *rows*. It says nothing about whether the responder
   * holds a record's blob.** The two came apart when residency landed: a node
   * that declines a blob (`Elided`) applies the row and advances its watermark
   * *precisely because* it decided not to want the bytes, so a node answering an
   * exchange can honestly report coverage over records whose blobs it does not
   * have.
   *
   * That is harmless while only the cloud responds — nothing pulls from a
   * handset — and it is the one place the "every node is just a peer" symmetry
   * is not true today. It must not be allowed to leak: concluding "the photo is
   * safe on that node" from a watermark would be wrong the first time a node
   * with a retention budget answers a pull.
   *
   * `durability.ts` states the same rule from the consuming side and refuses to
   * accept a watermark as evidence of a blob anywhere in the eviction path —
   * the path where being wrong destroys data. This is the reporting side of
   * that rule. Blob presence is a **per-object** fact: ask
   * `assessDurability` for proof, or `shared_object_availability` for what a
   * node can currently serve. Never a timestamp.
   */
  readonly responderWatermarks: Watermarks;
  /**
   * Whether {@link responderWatermarks} is the responder's whole coverage, or a
   * lower bound because some scope of it would not read.
   *
   * **Absent means true**, which is what every responder too old to send it
   * means and what the field defaulted to before it existed.
   *
   * ## Why an omission needed a word for itself
   *
   * The map is a union over the responder's own tables, and a per-table query
   * that throws omits that table's authors. Omission is indistinguishable from
   * "I hold nothing from node N" — and those two facts want opposite handling.
   * The first is the case `responderWatermarks`' replace-not-merge rule exists
   * to serve: it is how peer-side loss triggers a re-ship. The second is "I
   * could not look", which under this codebase's own rule must not lower
   * anything.
   *
   * With no way to distinguish them, a single unreadable table on the responder
   * made the requester re-scan that author's history from the floor — every
   * tick, forever, with `progressed` true, `complete: true`, and the supervisor
   * resetting its backoff on the "success". The trigger is durable rather than
   * transient (a per-app grant denying one table, schema drift after an app
   * update), so it does not resolve on its own.
   *
   * A requester seeing `false` merges **upward** — `max(prior, reported)` per
   * node — instead of replacing. Raising on a partial report is safe in a way
   * lowering is not: an omitted table can only understate the union, never
   * invent coverage.
   *
   * A single boolean rather than per-node or per-scope detail is deliberate. The
   * watermarks are already a union across scopes, so a gap in one scope cannot
   * be attributed to particular nodes; if any scope failed, the whole map is a
   * lower bound. {@link coverageDetail} carries the scope names for logging, and
   * nothing branches on it.
   */
  readonly coverageComplete?: boolean;
  /** Human-readable note naming the scopes that would not read. Never parsed. */
  readonly coverageDetail?: string;
  readonly hasMore: boolean;
  /**
   * Authors (nodeIds) whose inbound run the responder **stopped applying**
   * part-way through this round — a row that would not apply, a namespace it
   * does not have. Absent or empty means nothing was dropped.
   *
   * On the wire because the requester cannot infer it. The responder already
   * halts an author on its first failed apply and skips the rest of that
   * author's items, which is correct; the *watermark* half of that reaches the
   * requester (coverage stays behind the row, so it re-ships) but the *report*
   * half did not. Without this field a round the peer discarded entirely is
   * indistinguishable from one that landed perfectly: `blocked` is computed
   * from the requester's own failures, so `sync()` returned
   * `complete: true` — a "backup finished" for a peer whose schema is behind or
   * whose grant was never made — and a repair floor retired against a round
   * that filled nothing.
   *
   * Optional so a responder too old to send it still works; absent reads as
   * "nothing halted", which is the pre-existing behaviour and no worse than it.
   */
  readonly haltedAuthors?: readonly string[];
  /**
   * Per-author, per-time-bucket row counts over the responder's whole channel
   * state. Present only when the request set `requestDigest`, and absent from a
   * responder too old to know the field — which reads as "no check performed",
   * never as "no divergence".
   */
  readonly digest?: DigestBucket[];
  /**
   * The bucket width the responder actually used. Absent from a responder too
   * old to know the field; a value that differs from what was asked for means
   * the two digests are not comparable and must not be compared.
   */
  readonly digestPrefixLength?: number;
  /**
   * What the responder actually counted: one sorted scope name per data plane
   * folded into {@link digest} — `"shared"` for the Drive channel's records and
   * labels, `"<appId>.<table>"` for each app-syncable table.
   *
   * On the wire for the same reason the prefix length is. Both sides build the
   * digest by walking *their own* namespace store, so an app upgraded on one
   * end and not the other has each side summing a different set of tables into
   * the same buckets. Every bucket then disagrees in both directions and
   * `verify()` reports catastrophic divergence over a schema difference. The
   * requester compares this against its own scope list and refuses to compare
   * on a mismatch. Absent from a responder too old to know the field, which
   * skips the check rather than failing it.
   */
  readonly digestScopes?: readonly string[];
}

/**
 * The scope name for the Drive channel's shared records and labels in
 * {@link SyncExchangeResponse.digestScopes}. App-syncable tables name
 * themselves `"<appId>.<table>"`, which cannot collide with this.
 */
export const SHARED_DIGEST_SCOPE = "shared";

export interface SyncTransport {
  exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse>;
}

export interface FileSyncManifest {
  readonly fileHash: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  readonly mimeType?: string;
}

export interface FileSyncEngine {
  /** True if a transferFile for this key is currently running in this process. */
  isTransferInFlight(key: string): boolean;
  /**
   * Resolve true on a successful transfer (or if the source key is now present
   * at the destination). Resolves false if the source file doesn't exist.
   *
   * A call for a key already being transferred **joins** that transfer and
   * resolves with its outcome, rather than answering false. Answering false was
   * indistinguishable from a failure, so a user opening a photo whose bytes a
   * sync round happened to be moving was told the fetch had failed.
   */
  transferFile(
    manifest: FileSyncManifest,
    source: ObjectStorageAdapter,
    destination: ObjectStorageAdapter,
  ): Promise<boolean>;
  /**
   * Fetch a blob this node previously declined.
   *
   * This exists because eliding **advances the watermark**: the peer will not
   * re-ship the record, so nothing in a sync round will ever bring those bytes
   * down again. Without an explicit path, `prefetch: false` would mean "never",
   * and raising a budget would not backfill anything.
   *
   * Deliberately bypasses `decideResidency` — it is the answer to a direct
   * request ("the user opened this photo"), not a policy question. Byte
   * accounting still sees the arrival, so an on-demand fetch can push a class
   * over budget and be evicted later; that is the intended shape, because
   * refusing to show someone their own photo to stay under a cache budget is
   * not a defensible behaviour.
   */
  fetchBlobOnDemand(
    manifest: FileSyncManifest,
    source: ObjectStorageAdapter,
    destination: ObjectStorageAdapter,
  ): Promise<boolean>;
}

export type ChangeEventType =
  | "remote-update-available"
  | "local-data-synced"
  | "local-change-recorded";

export interface ChangeEvent {
  readonly eventType: ChangeEventType;
  readonly recordIds: StarkeepId[];
  readonly timestamp: HLCTimestamp;
  /**
   * For `local-change-recorded`: the appId whose sync channel owns this write.
   * Set when an app-specific data write happens (the calling app); left unset
   * for shared-record writes (those are owned by the always-on Drive channel
   * by Shape-A convention, which is a deployment fact the SDK doesn't name).
   * The sync supervisor uses this to nudge only the affected engine.
   */
  readonly originAppId?: string;
}

export type ChangeListener = (event: ChangeEvent) => void;

export interface ChangeNotifier {
  subscribe(listener: ChangeListener): () => void;
  emit(event: ChangeEvent): void;
}

export interface SyncStateStore {
  /** Caller's "what I've seen per nodeId" — advanced by records actually applied from peers. */
  getWatermarks(): Promise<Watermarks>;
  setWatermarks(watermarks: Watermarks): Promise<void>;

  /**
   * The peer's coverage watermarks as reported in `responderWatermarks` on
   * the previous exchange — authoritative, replaced wholesale each round
   * (never merged with local optimism). Used by the caller to compute
   * outbound deltas without an extra round-trip. Defaults to {} on first
   * exchange, which ships everything.
   */
  getPeerWatermarks(): Promise<Watermarks>;
  setPeerWatermarks(watermarks: Watermarks): Promise<void>;

  /**
   * Per-author floors a repair has asked the outbound scan to drop to.
   *
   * Separate from `peerWatermarks` because that map is replaced wholesale by
   * the peer's own report every round, so a local correction to it would be
   * overwritten immediately — by design. Keeping repair as its own map lets the
   * scan take `min(peerWatermarks, repairFloors)` and re-ship a range with no
   * second code path and no branch through the scan itself.
   *
   * Cleared per author once a **pushing** round has drained the outbound side
   * without that author's shipment being cut short by a failed transfer. Not on
   * the peer's coverage watermark, which sits *above* the floor by construction
   * and so reads "already covered" from the first round.
   */
  getRepairFloors(): Promise<Watermarks>;
  setRepairFloors(floors: Watermarks): Promise<void>;

  /**
   * The inbound mirror of {@link getRepairFloors}: per-author floors applied to
   * what this node **advertises** as its own coverage.
   *
   * A hole on our own side is invisible to everything else in the protocol. Our
   * watermark is `MAX(updated_at)`, so losing a row from the middle of a range
   * does not move it, and the peer goes on believing we hold that row. The only
   * lever is the number we advertise: the responder ships what sits above it, so
   * advertising less makes the peer re-ship into the hole.
   *
   * Separate from `watermarks` for exactly the reason the outbound floors are
   * separate from `peerWatermarks` — that map is recomputed from what lands
   * every round and would swallow the correction immediately.
   */
  getInboundFloors(): Promise<Watermarks>;
  setInboundFloors(floors: Watermarks): Promise<void>;

  getHlcClockState(): Promise<{ wallTime: number; counter: number } | null>;
  setHlcClockState(state: { wallTime: number; counter: number }): Promise<void>;
}

export interface ExchangeResult {
  readonly applied: number;
  readonly shipped: number;
  /**
   * The **responder** had more to send us than fit in this round.
   *
   * Strictly an inbound signal — it says nothing about whether *we* still have
   * things to push. A caller looping until sync is complete needs
   * {@link outboundHasMore} too; using this alone leaves a first upload of a
   * large library requiring one round per page forever, because the responder
   * has nothing to send and reports false the whole time.
   */
  readonly hasMore: boolean;
  /**
   * **We** had more to send than fit in this round — a candidate scan hit the
   * round's cap.
   *
   * The push-side counterpart to {@link hasMore}, and the reason `shipped` is
   * not a usable substitute: `shipped` counts records and app rows but not
   * labels, while the cap covers all three, so a round full of labels reports a
   * `shipped` well under the cap with plenty still owed.
   */
  readonly outboundHasMore: boolean;
  /**
   * An author's run was cut short by something that would not move — a blob
   * that failed to transfer in either direction, or a row that would not apply.
   *
   * Distinct from both `hasMore` fields, which describe **scans**. A round can
   * scan a backlog that fits the budget, select it, fail every transfer, and
   * report `hasMore: false, outboundHasMore: false` while shipping nothing —
   * the two predictions are about what is owed, and this is an observation
   * about what happened. `sync()` needs all three: a drained scan with a
   * blocked shipment is not a completed sync.
   */
  readonly blocked: boolean;
  /**
   * This round changed something that outlives it — a row applied or shipped, a
   * blob declined, or any persisted position moved.
   *
   * The loop's termination signal, and it has to be an observation rather than
   * a count. A repair round re-receives rows the peer already holds, applies
   * none of them (they are LWW no-ops) and still makes real progress by
   * advancing its floor; judged on item counts it looks idle and the repair
   * gets abandoned one roundful in. False here means the next request would be
   * byte-identical, so running it again cannot help.
   */
  readonly progressed: boolean;
  /**
   * Inbound items whose metadata landed and whose blob was **deliberately not
   * fetched**. Counted separately from `applied` because a declined blob is a
   * legitimate terminal state, not a partial success and not a failure — and
   * because a node that is quietly declining everything looks identical to a
   * healthy one if this number isn't surfaced.
   */
  readonly elided: number;
  /**
   * The peer could not report its own coverage for some scope this round, so
   * {@link SyncExchangeResponse.responderWatermarks} was a lower bound and was
   * merged upward rather than replacing the map.
   *
   * Surfaced this far up because the alternative was a `console.warn` on the
   * *responder*, which in the deployment that matters is a Lambda writing to
   * CloudWatch — somewhere no user and no local node will ever see it. "The
   * cloud cannot report its own coverage" is a degraded state someone should be
   * able to read off the node's status, not a line in a log nobody reads.
   */
  readonly peerCoverageDegraded?: string;
  /**
   * Highest position actually **shipped** per author this round.
   *
   * Read from what left this node rather than from what the scan selected, so a
   * shipment cut short by a failed transfer is not credited with the part that
   * never went. `sync()` compares it against the peer's coverage to notice a
   * range being re-shipped forever; see `RESHIP_STRIKES_BEFORE_REFUSAL`.
   */
  readonly shippedHighWater?: Readonly<Record<string, HLCTimestamp>>;
  /**
   * Authors this round declined to push, because several consecutive drained
   * syncs shipped their range and the peer's coverage never reached it.
   *
   * Not a failure of this round — nothing was attempted. It is this node
   * refusing to spend another full re-scan of an author's history on something
   * that has demonstrably not been working, and saying which author so the
   * condition is diagnosable rather than merely quiet.
   */
  readonly refusedAuthors?: readonly string[];
}

export interface SyncEngine {
  /**
   * One version-vector exchange round with the peer:
   *   1. Read own + last-reported peer watermarks
   *   2. For each outbound record (peer hasn't seen): push its blob if any,
   *      then ship metadata. Blob push failure excludes that record from the
   *      round; the peer's reported watermarks stay behind it for an
   *      automatic retry.
   *   3. For each inbound record: apply metadata, then pull its blob if any.
   *      Blob pull failure leaves own watermark behind it; next round the
   *      responder still ships it.
   *   4. Persist watermarks: own advances past fully-landed inbound items;
   *      peer is **replaced** with `response.responderWatermarks` — the
   *      peer's own coverage report, not local optimism — so peer-side loss
   *      (wipe, redeploy, failed apply) is detected and re-shipped.
   */
  exchange(options?: ExchangeOptions): Promise<ExchangeResult>;

  /**
   * Run rounds until both directions are drained.
   *
   * **Pulls before it pushes**: round 0 ships nothing, so every later round
   * decides what to send against a `peerWatermarks` map at most one round old.
   * That is what makes a stale cache — the state left behind by a round whose
   * response was lost — cost one small request instead of a whole redundant
   * re-ship. Round 0 is not overhead: it still carries our watermarks and takes
   * delivery of everything the peer holds for us, which is the entire inbound
   * half of the sync.
   *
   * Abandoning mid-loop is free. Each round persists its own watermarks, so a
   * process killed between rounds resumes from where it stopped; there is no
   * partial state to clean up and nothing to resume *from* beyond the
   * watermarks already on disk.
   */
  sync(options?: SyncOptions): Promise<SyncResult>;

  /**
   * Compare row counts with the peer, and arm a repair for anything it is
   * missing.
   *
   * The check the sync protocol cannot make on its own. The contiguous-prefix
   * rule stops a *sender* from ever leaving a gap below its watermark; nothing
   * stops a *receiver* from developing one. A peer that loses a row from the
   * middle of an author's range keeps the same `MAX(updated_at)`, so its
   * coverage report is unchanged and no number of sync rounds will ever offer
   * that row again.
   *
   * Arms rather than repairs: divergence is recorded as per-author floors that
   * lower the bound the ordinary outbound scan already takes, so the next
   * {@link sync} does the re-shipping through the path that is already tested.
   * LWW makes everything the peer still holds a no-op.
   *
   * Occasional, not per-round — a `GROUP BY` over the whole index on both
   * sides. Run it on a slow schedule, on demand, or after an unclean shutdown.
   */
  verify(): Promise<VerifyResult>;

  /**
   * Pull a blob this node previously declined, on request.
   *
   * The reversal half of eliding, and the reason eliding is safe at all. An
   * elided record **advances the watermark** — that is what makes it a terminal
   * state rather than a permanent retry — so the peer will never offer those
   * bytes again and no sync round can bring them back. Without this,
   * `prefetch: false` would mean "never", and raising a budget would backfill
   * nothing.
   *
   * On the engine rather than on `FileSyncEngine` for two reasons. It saves
   * every caller from re-deriving which storage is local and which is remote,
   * which is a thing to get backwards exactly once. And it shares the engine's
   * own in-flight table, so a fetch for a key a round is currently transferring
   * joins that transfer instead of racing it.
   *
   * Deliberately bypasses the residency decision: this is the answer to a direct
   * request ("the user opened this photo"), not a policy question. Byte
   * accounting still sees the arrival, so an on-demand fetch can push a class
   * over budget and be evicted later — the intended shape, because refusing to
   * show someone their own photo to stay under a cache budget is not a
   * defensible behaviour.
   */
  fetchBlob(manifest: FileSyncManifest, candidate?: BlobCandidate): Promise<boolean>;

  /**
   * Pull a blob the acquisition queue says this node wants — speculatively, and
   * **subject to the policy**.
   *
   * The other half of {@link fetchBlob}, and deliberately a separate method
   * rather than a flag on it. `fetchBlob` answers a direct request ("the user
   * opened this photo") and bypasses the residency decision on purpose; this
   * answers a background pass working through a queue, and the decision is
   * exactly what it must respect — a pass that ignored the budget would fetch
   * the whole library back the moment the queue existed.
   *
   * Passing the difference as a boolean would put those two authorities on the
   * same call, which is the mistake `file-sync-engine.ts` already names: the
   * right to override a policy is named at the call site, never handed over as
   * an argument.
   *
   * Three outcomes, and the middle one is what makes a pass cheap:
   *   - `"landed"`   — the bytes are here and charged to their budget.
   *   - `"declined"` — the policy said no. The verdict's reason rides on
   *     {@link AcquireResult.reason}, because `budget-exhausted` means "stop
   *     walking this line" while `class-disabled` means "drop this row".
   *   - `"failed"`   — wanted, and did not arrive. The queue row stays and the
   *     next tick retries; this is the retry path a watermark that has already
   *     advanced cannot provide.
   */
  acquireBlob(
    manifest: FileSyncManifest,
    candidate: BlobCandidate,
  ): Promise<AcquireResult>;

  readonly changeNotifier: ChangeNotifier;
}

/** What {@link SyncEngine.acquireBlob} did, and why. */
export interface AcquireResult {
  readonly outcome: "landed" | "declined" | "failed";
  /**
   * The verdict's reason when the policy declined, so the caller can tell
   * "this line is full" from "this node will never want this".
   *
   * Null on `landed` and on `failed` — a transfer that did not happen has no
   * policy reason attached, and inventing one would let a network fault read as
   * a decision.
   */
  readonly reason: ResidencyVerdict["reason"] | null;
}

export interface VerifyResult {
  /**
   * False when the peer does not implement the digest. Distinguished from a
   * clean result on purpose: a peer that cannot answer is not a peer that
   * agrees, and reporting zero divergence for it would read as "verified".
   */
  readonly supported: boolean;
  /**
   * Rows held locally and by the peer, over this channel.
   *
   * The pair that answers "is my library backed up?" — which a coverage
   * watermark cannot, because it is a timestamp per author and not a count.
   * Counts rows, so it includes tombstones and labels; it is an integrity
   * comparison between two nodes, not a user-facing photo count.
   */
  readonly localRows: number;
  readonly peerRows: number;
  /**
   * Buckets where **the peer** holds fewer rows than we do *and we owe it
   * nothing* — the repair trigger, and the answer to "did the other end lose
   * something?".
   *
   * One-directional on purpose: a bucket where the peer has more is ordinary
   * data we have not pulled yet, not corruption.
   *
   * Zero while an outbound backlog exists, because a bucket the peer is behind
   * on is indistinguishable from one it has lost — see {@link pendingUpload}.
   */
  readonly divergentBuckets: number;
  /**
   * Buckets where **we** hold fewer rows than the peer *and it owes us
   * nothing* — the answer to "is my library whole?", which is a different
   * question and needs a different comparison.
   *
   * Reusing {@link divergentBuckets} for it reports "clean" to a node that is
   * itself missing rows, which is the case a person most wants to know about.
   * A non-zero value arms the inbound repair; the next sync pulls the gap.
   *
   * Zero while an inbound backlog exists — see {@link pendingDownload}.
   */
  readonly missingLocally: number;
  /**
   * The same two comparisons when the channel is **not** drained: buckets the
   * peer is behind on ({@link pendingUpload}) or we are behind on
   * ({@link pendingDownload}), with a backlog outstanding in that direction.
   *
   * Counting these as holes is the mistake this pair exists to prevent. A phone
   * mid-first-sync or a laptop back from a week offline disagrees in every
   * bucket of its backlog, and a check run then would otherwise read as loss
   * across the whole library — and arm a repair that re-requests a backlog the
   * ordinary round was already going to deliver. "Still to download" and
   * "missing" are different sentences and this is where they part.
   *
   * A direction is drained when nothing is owed in it: outbound by
   * `hasOutboundBacklog()`, inbound by the responder's `hasMore` on the
   * zero-limit exchange `verify()` already sends. Exactly one of
   * {@link divergentBuckets}/{@link pendingUpload} can be non-zero, and
   * likewise for the inbound pair.
   */
  readonly pendingUpload: number;
  readonly pendingDownload: number;
}

export interface ExchangeOptions {
  /**
   * Whether this round may send anything. Default true.
   *
   * `false` makes it a pull: no outbound scan, no blob uploads, an empty
   * payload. Used for the first round of {@link SyncEngine.sync} — see there
   * for why that is an ordering choice rather than an extra request.
   */
  readonly push?: boolean;
}

export interface SyncOptions {
  /**
   * Backstop on rounds in one call. Default 10,000.
   *
   * Not a tuning knob — the loop terminates on the peer's own "there is more"
   * answer. Hitting it means something is not converging, and stopping is safe
   * because the watermarks make the next call resume in place.
   */
  readonly maxRounds?: number;
  /**
   * Checked after each round. Set it to stop early — mid-loop abandonment costs
   * nothing, so a caller can cancel on app background or user navigation
   * without leaving anything half-done.
   */
  readonly signal?: { readonly aborted: boolean };
  /** Called after each round, for progress reporting. */
  onRound?(result: ExchangeResult, round: number): void;
}

export interface SyncResult {
  rounds: number;
  applied: number;
  shipped: number;
  elided: number;
  /**
   * True when the loop ended because both directions were drained **and
   * nothing was left behind** — no scan had more to give and no transfer or
   * apply failed. False when it ended on `maxRounds`, an abort, a stall, or a
   * round that could not move what it had selected. False is not an error — it
   * means work remains, and the next call picks it up.
   *
   * The "nothing was left behind" half is load-bearing and used not to be: a
   * permanently failing upload drains both scans, so on the scan signals alone
   * this reported a finished sync for a record that was not in the cloud.
   */
  complete: boolean;
  /**
   * The loop stopped because a round achieved nothing while still reporting
   * work outstanding — applied nothing, shipped nothing, declined nothing.
   *
   * Almost always a transfer that will not succeed: blob failures are swallowed
   * into a contiguous-prefix truncation by design, so they never surface as an
   * error, and without this the loop would reissue a byte-identical request
   * until `maxRounds`. Worth surfacing rather than hiding — it is the
   * difference between "sync finished" and "sync is stuck".
   */
  stalled: boolean;
  /**
   * Authors this node has stopped pushing, because several consecutive drained
   * syncs shipped their range and the peer's coverage never reached it.
   *
   * A degraded state that needs a person, not a retry: the realistic causes are
   * a per-app grant that denies one table on the responder, schema drift after
   * an app update, or a peer that applies rows and loses them. Surfaced here
   * because every other signal about this condition reads as success — the
   * scans drain, the uploads succeed, and the round reports progress precisely
   * *because* it re-shipped the library.
   *
   * Cleared by a `verify()`, which is the deliberate "try again" — an integrity
   * check is exactly the thing a person runs when they think sync is wrong, and
   * making it re-arm the push is more useful than a counter nothing can reset.
   */
  refusedAuthors?: readonly string[];
  /**
   * The peer reported that its own coverage map was incomplete during this sync.
   * Carries the scopes it named. See `SyncExchangeResponse.coverageComplete`.
   */
  peerCoverageDegraded?: string;
}

export interface SyncEngineOptions {
  readonly localDatabaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  readonly remoteObjectStorage: ObjectStorageAdapter;
  readonly transport: SyncTransport;
  readonly clock: import("@starkeep/protocol-primitives").HLCClock;
  readonly syncState?: SyncStateStore;
  /**
   * Provides the applier (for applying incoming exchange rows) and namespace
   * store (for scanning local rows on the outbound side). Without it,
   * app-syncable rows are silently skipped on both directions.
   */
  readonly appSyncableSource?: {
    readonly namespaces: AppSyncableNamespaceStore;
    readonly applier: AppSyncableApplier & ScanCapableApplier;
  };
  /**
   * Channel split. When true (default), this engine ships and applies
   * shared records (SR — the `shared.records` table). The always-on Starkeep
   * Drive channel sets this true and provides no `appSyncableSource`, so it is
   * the *only* channel that carries shared records. Per-app channels set this
   * false and carry only their own app-specific (`appSyncableSource`) rows, so
   * shared-record sync is identical regardless of which apps are cloud-installed.
   */
  readonly syncSharedRecords?: boolean;
  /**
   * Consulted before every inbound blob pull. Returning `"elide"` applies the
   * metadata, skips the blob, and **advances the watermark** — the record is
   * not owed and will not be re-shipped.
   *
   * Omitting this preserves the pre-residency behaviour exactly: every blob is
   * wanted, and a missing one is a failure that holds the watermark. That is
   * the right default for the cloud node and for any node that has not been
   * given a retention policy, because the failure mode of over-fetching is a
   * full disk and the failure mode of under-fetching is data that quietly
   * isn't anywhere.
   *
   * Fetch-time only. It cannot stop an *outbound* push, so a constraint that
   * must hold cloud-side (`starkeep/no-cloud`) needs a server-side refusal as
   * well — a decision consulted on one side of a transfer is not an invariant.
   */
  readonly residency?: ResidencyHooks;
  /**
   * Byte budget for one round's blob transfers. Default 25 MB; a handset
   * should set this lower.
   *
   * The primary budget on any channel carrying files, because bytes are what a
   * round actually costs — six photos is ~18 MB, six labels is nothing. Items
   * with no blob spend none of it and are bounded by {@link maxItems} instead,
   * which is what lets one pair of numbers suit both a photo channel and a
   * channel of captions with no per-app tuning.
   *
   * A single item larger than the whole budget still ships, alone. The
   * alternative is a 400 MB video stalling its channel permanently.
   */
  readonly maxBytes?: number;
  /**
   * Item cap for one round, across records, labels and app rows combined,
   * applied to both the outbound scan and the inbound request limit.
   * Default 1000.
   *
   * Binds on channels whose rows carry no blobs. Kept well above what the byte
   * budget implies for a photo channel: a thousand rows of text is a small
   * request, and splitting it into ten rounds would be pure round-trip
   * overhead. Tests use small values to exercise multi-round behaviour without
   * seeding thousands of records.
   */
  readonly maxItems?: number;
  /**
   * How many blobs transfer at once within a round. Default 4.
   *
   * Exists because a single-stream upload does not saturate a fast link, so a
   * strictly sequential round leaves the node idle for most of it — which
   * matters more, not less, once rounds are small. Bounded because every
   * in-flight transfer costs memory, and a handset has little.
   *
   * Does not weaken the contiguous-prefix rule: transfers overlap, but what
   * ships is decided afterwards per author in HLC order, stopping at that
   * author's first failure.
   */
  readonly transferConcurrency?: number;
}
