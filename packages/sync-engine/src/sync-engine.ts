import {
  compareHLC,
  type AnyRecord,
  type HLCTimestamp,
  type RecordLabel,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";

// Mirror of `FILE_RECORDS_TABLE` from `@starkeep/shared-space-api`. The sync
// engine cannot import that package (cycle), but it needs the table name to
// recognize which app-syncable rows carry blobs. Keep these in sync.
const FILE_RECORDS_TABLE = "_starkeep_sync_records";

/**
 * Default round budget, sized for a laptop on a home connection.
 *
 * Deliberately small in bytes. The round is the unit of lost work — a dropped
 * response costs one round's re-scan and re-upload — and on a blob channel the
 * bytes are the cost, not the row count. Handsets override both downward; see
 * `photos-mobile/src/node.ts`.
 */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Item cap, which binds on channels whose rows carry no blobs (labels,
 * captions, vision results). Much larger than the byte budget implies, because
 * a thousand rows of text is a small request and forcing it into ten rounds
 * would be pure round-trip overhead.
 */
const DEFAULT_MAX_ITEMS = 1000;

/**
 * How many blobs move at once within one round.
 *
 * Above one purely to fill the pipe: a single-stream 3 MB upload does not
 * saturate a fast link, so a sequential round is mostly idle. Bounded because
 * each in-flight transfer costs memory, and a handset has little.
 */
const DEFAULT_TRANSFER_CONCURRENCY = 4;

/**
 * Cap on rounds in one `sync()` call.
 *
 * A backstop, not a tuning knob: a loop driven by the peer's own "there is
 * more" answer terminates on its own, and a run that hits this bound means
 * something is not converging. Abandoning is free — the watermarks make the
 * next call resume where this one stopped — so the cap costs nothing but
 * bounds a pathological loop.
 */
const DEFAULT_MAX_ROUNDS = 10_000;
import type {
  AppSyncableRowEntry,
  ExchangeOptions,
  ExchangeResult,
  FileSyncEngine,
  FileSyncManifest,
  SyncEngine,
  SyncEngineOptions,
  SyncOptions,
  SyncResult,
  VerifyResult,
  Watermarks,
} from "./types.js";
import { SHARED_DIGEST_SCOPE } from "./types.js";
import { createChangeNotifier } from "./change-notifier.js";
import { createFileSyncEngine } from "./file-sync-engine.js";
import {
  applyRepairFloors,
  bucketsPeerIsMissing,
  mergeDigestBuckets,
  raiseInboundFloors,
  repairFloorsFor,
  totalRows,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
} from "@starkeep/storage-adapter";
import { advanceWatermark } from "./watermarks.js";
import {
  computeCeilings,
  cutRound,
  type RoundItem,
  type StreamTruncation,
} from "./round-cut.js";
import type { BlobCandidate, ResidencyVerdict } from "./residency-policy.js";

/**
 * What the outbound backlog check found.
 *
 * Two facts rather than one because a table that would not read is not a table
 * with nothing in it, and the two callers want opposite things from that:
 * `sync()` may safely guess "nothing owed" (the pushing round re-reads it and
 * logs properly), while `verify()` must decline the comparison entirely.
 */
interface OutboundBacklog {
  /** Something is owed to the peer, as far as we could see. */
  readonly owed: boolean;
  /** Every stream on this channel answered. False means `owed` is a guess. */
  readonly readable: boolean;
}

/**
 * The shape of "no check was performed", which is not the shape of "checked and
 * found nothing wrong". Every guard in `verify()` that declines to compare
 * returns this with `supported: false`, so a caller cannot mistake a refusal
 * for a clean bill of health.
 */
const NOT_VERIFIED: VerifyResult = {
  supported: true,
  localRows: 0,
  peerRows: 0,
  divergentBuckets: 0,
  missingLocally: 0,
  pendingUpload: 0,
  pendingDownload: 0,
};

/**
 * Sync engine: drives one version-vector exchange round per tick.
 *
 * Blob transfer is gated on the same watermark that drives metadata transfer.
 * A record's blob is pushed before its metadata ships; a record's blob is
 * pulled before its receipt is acknowledged. If either fails, the watermark
 * doesn't advance past it, and the next round naturally retries.
 *
 * Shared records (SR) and app-record rows in the reserved `_starkeep_sync_records`
 * table (AR) are interleaved per nodeId in HLC order so the contiguous-prefix
 * watermark rule covers both streams: a blob failure on an AR row blocks any
 * later SR record on the same nodeId from shipping in the same round (and vice
 * versa). Without that, the per-nodeId watermark could leapfrog a failed item.
 *
 * There is no scan-everything reconciliation pass. There is no `sync_status`.
 * Steady state issues zero storage HEAD requests: the watermark delta tells
 * us exactly which records (and therefore which blobs) need attention.
 */
export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const {
    localDatabaseAdapter,
    localObjectStorage,
    remoteObjectStorage,
    transport,
    clock,
    syncState,
    appSyncableSource,
    syncSharedRecords = true,
    residency,
  } = options;

  // Round budget. Bytes bind on a blob channel, item count on a row channel;
  // see the cut in `exchange()` for why both are needed and why neither alone
  // is enough.
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const transferConcurrency = Math.max(1, options.transferConcurrency ?? DEFAULT_TRANSFER_CONCURRENCY);

  const changeNotifier = createChangeNotifier();
  const fileSyncEngine = createFileSyncEngine();

  async function loadOwnWatermarks(): Promise<Watermarks> {
    if (!syncState) return {};
    return syncState.getWatermarks();
  }

  async function loadPeerWatermarks(): Promise<Watermarks> {
    if (!syncState) return {};
    return syncState.getPeerWatermarks();
  }

  async function loadRepairFloors(): Promise<Watermarks> {
    if (!syncState) return {};
    return syncState.getRepairFloors();
  }

  async function loadInboundFloors(): Promise<Watermarks> {
    if (!syncState) return {};
    return syncState.getInboundFloors();
  }

  /**
   * Bucketed row counts over **this channel's** data plane.
   *
   * Scoped the same way every other operation on the channel is: the Drive
   * channel digests shared records and labels, a per-app channel digests that
   * app's tables. A digest that always covered shared records would compare a
   * per-app channel against rows it never carries — arming floors for a repair
   * the channel cannot perform, and reporting divergence that means nothing.
   */
  async function localBucketDigest(
    prefixLength: number,
  ): Promise<{ buckets: DigestBucket[]; scopes: string[]; complete: boolean }> {
    const buckets: DigestBucket[] = [];
    const scopes: string[] = [];
    let complete = true;
    if (syncSharedRecords) {
      scopes.push(SHARED_DIGEST_SCOPE);
      try {
        buckets.push(...(await localDatabaseAdapter.bucketDigest(prefixLength)));
      } catch (err) {
        console.warn(`[sync] bucketDigest failed for shared records: ${(err as Error).message}`);
        complete = false;
      }
    }
    if (appSyncableSource) {
      for (const ns of appSyncableSource.namespaces.list()) {
        for (const tableInfo of ns.tables) {
          scopes.push(`${ns.appId}.${tableInfo.name}`);
          try {
            buckets.push(
              ...(await appSyncableSource.applier.bucketDigest(
                ns.appId,
                tableInfo.name,
                prefixLength,
              )),
            );
          } catch (err) {
            console.warn(
              `[sync] bucketDigest failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
            );
            // A table we could not count is not a table we hold nothing in.
            // Treating the failure as a zero makes every bucket in it look like
            // a hole — the loudest possible false alarm, and one that would arm
            // a full-library repair in both directions.
            complete = false;
          }
        }
      }
    }
    return { buckets: mergeDigestBuckets(buckets), scopes: scopes.sort(), complete };
  }

  /**
   * Is anything owed to the peer right now?
   *
   * Deliberately asks for a single row rather than counting: the delta scans
   * short-circuit on the per-author watermark comparison, so with nothing owed
   * this is one grouped index read per stream and no table access at all.
   *
   * The round that follows repeats those grouped reads, which looks like an
   * obvious thing to thread through and is not worth it. Caching them would
   * mean holding a snapshot of `MAX(updated_at)` across rounds while rows are
   * being written underneath — trading two index-only reads for a staleness
   * bug on the scan the whole design rests on. Pay the reads.
   */
  async function hasOutboundBacklog(): Promise<OutboundBacklog> {
    const peerWatermarks = applyRepairFloors(
      await loadPeerWatermarks(),
      await loadRepairFloors(),
    );
    if (syncSharedRecords) {
      if ((await localDatabaseAdapter.querySince(peerWatermarks, 1)).rows.length > 0) {
        return { owed: true, readable: true };
      }
      if ((await localDatabaseAdapter.queryLabelsSince(peerWatermarks, 1)).rows.length > 0) {
        return { owed: true, readable: true };
      }
    }
    // `readable` exists because the two callers want opposite things from a
    // table that would not read. `sync()` only needs to know whether to spend a
    // pull-first round, and guessing "no backlog" there costs nothing — the
    // pushing round that follows reads the same table and logs the failure
    // properly. `verify()` is about to compare row counts and arm repairs off
    // the answer, and for that a swallowed error is a comparison it should have
    // declined: an unreadable table would read as a drained outbound side, so
    // every bucket it holds gets reported as loss on the peer's end.
    let readable = true;
    if (appSyncableSource) {
      for (const ns of appSyncableSource.namespaces.list()) {
        for (const tableInfo of ns.tables) {
          try {
            const page = await appSyncableSource.applier.scanSince(
              ns.appId,
              tableInfo.name,
              peerWatermarks,
              1,
            );
            if (page.rows.length > 0) return { owed: true, readable };
          } catch (err) {
            console.warn(
              `[sync] backlog check failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
            );
            readable = false;
          }
        }
      }
    }
    return { owed: false, readable };
  }

  async function exchange(options?: ExchangeOptions): Promise<ExchangeResult> {
      // A pull-only round ships nothing and scans nothing outbound. It exists
      // so a sync session can **pull before it pushes**: `peerWatermarks` is a
      // cache of what the peer last said about itself, and after a round whose
      // response was lost it is stale-low, so pushing against it re-ships items
      // the peer already took.
      //
      // This is not an extra round trip to justify. The round still carries our
      // own watermarks and still takes delivery of everything the peer has for
      // us — it does the entire inbound half of the sync. The reason it has
      // nothing to push is simply that we have not yet learned what the peer
      // needs.
      const push = options?.push ?? true;
      const ownWatermarks = await loadOwnWatermarks();
      // What we *advertise* is what the responder scans above, so an inbound
      // repair is expressed by advertising less than we hold. Same trick as the
      // outbound floors, same reason it has to be a separate map: `ownWatermarks`
      // is recomputed from what lands every round and would swallow the
      // correction immediately. Understating coverage is always safe — it costs
      // a re-ship, and LWW makes the re-ship a no-op.
      const advertisedWatermarks = applyRepairFloors(
        ownWatermarks,
        await loadInboundFloors(),
      );
      // Repair, when one is outstanding, is expressed by lowering the bound the
      // scan already takes — not by a second scan and not by a branch. The
      // scans below cannot tell a repair from an ordinary round.
      const priorPeerWatermarks = await loadPeerWatermarks();
      const peerWatermarks = applyRepairFloors(
        priorPeerWatermarks,
        await loadRepairFloors(),
      );

      // ---------------------------------------------------------------------
      // Outbound: gather SR records and AR/AW rows the peer hasn't seen, then
      // walk per nodeId in HLC order with a contiguous-prefix rule. Blobs
      // (SR or AR) are pushed before their owning item is allowed to ship.
      // ---------------------------------------------------------------------
      //
      // Every scan below is a **delta scan**: the per-nodeId watermark filter
      // is pushed into the query, which seeks the `(node_id, updated_at)` index
      // once per author instead of reading the table and discarding whatever
      // the peer already has. That is what makes round N cost the same as round
      // 1. The previous shape read every row every round, so a node that had
      // shipped 30k of 60k records still read 30k rows to find the next 100.
      //
      // There is no cursor loop any more, and none is needed: every row that
      // comes back is genuinely owed, so `limit` rows is a full page by
      // construction. What gets left behind is not resumed from a token — the
      // peer's watermark has not advanced past it, so the next round selects it
      // again from the top. `hasMore` here therefore answers "should we run
      // another round?", not "where do I continue from?".
      let outboundHasMore = false;

      // Every stream reports how far it got, per author. Those marks are the
      // whole reason a shipment can be cut safely: the coverage watermark spans
      // all of them, so an item may only ship once *every* stream can vouch
      // that nothing older is still owed for its author. See `round-cut.ts`.
      const truncations: StreamTruncation[] = [];
      const candidates: RoundItem<OutboundItem>[] = [];
      let unreadableStream = false;

      // Only the Drive channel ships shared records. Per-app channels set
      // syncSharedRecords=false and leave this empty — they carry only
      // app-specific rows.
      if (push && syncSharedRecords) {
        const page = await localDatabaseAdapter.querySince(peerWatermarks, maxItems);
        truncations.push(page.truncated);
        for (const rec of page.rows) {
          candidates.push({
            value: { kind: "record", record: rec },
            hlc: rec.updatedAt,
            // A tombstone or a record with no blob transfers no bytes, so it
            // must not be charged for them — otherwise a delete-heavy round
            // budgets as if it were re-uploading the library.
            bytes: manifestForRecord(rec) ? rec.sizeBytes : 0,
          });
        }

        // Labels are shared data too, so the same channel rule and the same
        // delta scan apply. A label is a row, never a blob, so it costs no
        // byte budget.
        const labelPage = await localDatabaseAdapter.queryLabelsSince(
          peerWatermarks,
          maxItems,
        );
        truncations.push(labelPage.truncated);
        for (const label of labelPage.rows) {
          candidates.push({
            value: { kind: "label", label },
            hlc: label.updatedAt,
            bytes: 0,
          });
        }
      }

      // AR/AW scan. Every registered table is scanned every round, each with
      // the full item budget rather than a share of a running total. A table
      // skipped for lack of budget would be a stream that enumerated nothing,
      // which forces every author's ceiling to "nothing safe" and shuts the
      // round down entirely — a far worse outcome than reading a few hundred
      // extra indexed rows. The cut below discards the surplus.
      if (push && appSyncableSource) {
        for (const ns of appSyncableSource.namespaces.list()) {
          for (const tableInfo of ns.tables) {
            try {
              const page = await appSyncableSource.applier.scanSince(
                ns.appId,
                tableInfo.name,
                peerWatermarks,
                maxItems,
              );
              truncations.push(page.truncated);
              for (const entry of page.rows) {
                candidates.push({
                  value: { kind: "appRow", entry },
                  hlc: entry.timestamp,
                  bytes: appRowBlobBytes(entry),
                });
              }
            } catch (err) {
              console.warn(
                `[sync] exchange scanSince failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
              );
              // A table we could not read might hold rows older than anything
              // else this round would ship, for any author. Treating that as
              // "nothing owed" is what opens a gap, so the round ships nothing
              // and asks to be retried. It used to warn and carry on.
              unreadableStream = true;
            }
          }
        }
      }

      const cut = unreadableStream
        ? { taken: [] as RoundItem<OutboundItem>[], hasMore: true }
        : cutRound(candidates, computeCeilings(truncations), { maxBytes, maxItems });
      if (cut.hasMore) outboundHasMore = true;

      const cappedRecords: AnyRecord[] = [];
      const cappedLabels: RecordLabel[] = [];
      const cappedAppRows: AppSyncableRowEntry[] = [];
      for (const item of cut.taken) {
        if (item.value.kind === "record") cappedRecords.push(item.value.record);
        else if (item.value.kind === "label") cappedLabels.push(item.value.label);
        else cappedAppRows.push(item.value.entry);
      }

      const outboundByNode = groupOutboundByNodeId(
        cappedRecords,
        cappedLabels,
        cappedAppRows,
      );

      const outboundRecords: AnyRecord[] = [];
      const outboundLabels: RecordLabel[] = [];
      const outboundAppRows: AppSyncableRowEntry[] = [];

      // Upload this round's blobs with bounded concurrency, then decide what
      // ships.
      //
      // Concurrency is the reason a small round is affordable: a single-stream
      // 3 MB upload does not come close to saturating a fast link, so a
      // strictly sequential round leaves the node idle for most of it
      // regardless of how the budget is set.
      //
      // It does **not** relax the contiguous-prefix rule. Transfers overlap,
      // but the decision about what ships is made afterwards, per author, in
      // HLC order, stopping at that author's first failure. Uploading a later
      // item concurrently with one that fails is harmless — the bytes are
      // content-addressed and the item simply doesn't ship this round, so the
      // next round finds them already there.
      // Grouped by object key, not by item, because a key can belong to more
      // than one item. Record blobs are content-addressed
      // (`shared/<category>/<shard>/<sha256>`), so two records with identical
      // bytes name the same object — a photo saved twice, two renditions that
      // compress alike. Dispatching those as separate transfers means the
      // second one meets the first still in flight, and `transferFile` answers
      // `false` for a key it is already moving. The engine cannot tell that
      // apart from a failed upload, so it truncated the author's shipment on a
      // transfer that was in fact succeeding.
      //
      // One transfer per key, and every item naming it takes the same outcome.
      // Cheaper as well as correct: identical bytes were being sent twice.
      const uploadOutcomes = new Map<OutboundItem, boolean>();
      const itemsByKey = new Map<string, OutboundItem[]>();
      for (const items of outboundByNode.values()) {
        for (const item of items) {
          const manifest = outboundManifest(item);
          if (!manifest) continue;
          pushToBucket(itemsByKey, manifest.objectStorageKey, item);
        }
      }
      await forEachConcurrent(
        [...itemsByKey.values()],
        transferConcurrency,
        async (sharing) => {
          const representative = sharing[0]!;
          const ok = await transferBlobSafe(
            outboundManifest(representative)!,
            localObjectStorage,
            remoteObjectStorage,
            fileSyncEngine,
            "upload",
            outboundItemId(representative),
          );
          for (const item of sharing) uploadOutcomes.set(item, ok);
        },
      );

      // Authors whose shipment this round was cut short by a failed transfer,
      // as opposed to by the budget. The two are not interchangeable: the
      // budget leaves a tidy prefix behind and the peer's watermark records
      // exactly where to resume, while a failed transfer leaves rows unshipped
      // that a repair floor may be the only thing still asking for. Retiring a
      // floor on such a round is how a repair reports success and does nothing.
      const truncatedByFailure = new Set<string>();
      for (const [nodeId, items] of outboundByNode) {
        for (const item of items) {
          // `false` only for an item that had a blob and failed it; an item
          // with no blob was never entered into the map at all.
          if (uploadOutcomes.get(item) === false) {
            truncatedByFailure.add(nodeId);
            break;
          }
          if (item.kind === "record") {
            outboundRecords.push(item.record);
          } else if (item.kind === "label") {
            outboundLabels.push(item.label);
          } else {
            outboundAppRows.push(item.entry);
          }
        }
      }

      const response = await transport.exchange({
        watermarks: advertisedWatermarks,
        records: outboundRecords.length > 0 ? outboundRecords : undefined,
        labels: outboundLabels.length > 0 ? outboundLabels : undefined,
        appSyncableRows: outboundAppRows.length > 0 ? outboundAppRows : undefined,
        limit: maxItems,
        maxBytes,
      });

      // Authors the responder stopped applying part-way through. Our shipment
      // for them left this node fine and was then discarded, so it is a failure
      // this side has no other way to see: the scans both report drained, every
      // upload succeeded, and the round nonetheless landed nothing. Treated
      // exactly like a failed upload from here on — it is the same event with
      // the failure at the other end of the wire.
      const haltedByPeer = new Set(response.haltedAuthors ?? []);
      if (haltedByPeer.size > 0) {
        console.warn(
          `[sync] peer halted ${haltedByPeer.size} author(s) this round: ${[...haltedByPeer].join(", ")}`,
        );
      }

      // ---------------------------------------------------------------------
      // Inbound: apply records (and pull their blobs) per nodeId in HLC order,
      // interleaving SR snapshots and AR/AW rows. Own watermark advances only
      // past items that fully landed locally. peerWatermarks needs no
      // per-item bookkeeping here: the responder reports its coverage in
      // `responderWatermarks` (computed after applying our outbound), which
      // replaces the whole map below.
      // ---------------------------------------------------------------------
      // A per-app channel (syncSharedRecords=false) must never apply shared
      // records. The responder shouldn't ship them, but guard inbound too so
      // the channel split holds even if a peer over-ships.
      if (!syncSharedRecords && (response.records?.length ?? 0) > 0) {
        console.warn(
          `[sync] dropped ${response.records?.length ?? 0} shared record(s) received on a per-app channel (syncSharedRecords=false)`,
        );
      }
      // Labels are shared data too, so the same guard applies. Without this
      // the channel split would hold for records and silently not for
      // labels — the kind of gap that gets left out because the responder
      // "shouldn't" ship them.
      if (!syncSharedRecords && (response.labels?.length ?? 0) > 0) {
        console.warn(
          `[sync] dropped ${response.labels?.length ?? 0} record label(s) received on a per-app channel (syncSharedRecords=false)`,
        );
      }
      const inboundByNode = groupInboundByNodeId(
        syncSharedRecords ? response.records : [],
        syncSharedRecords ? (response.labels ?? []) : [],
        response.appSyncableRows,
      );
      const appliedIds: StarkeepId[] = [];
      const ownSafeAdvance = new Map<string, HLCTimestamp>();
      let elidedCount = 0;

      /**
       * Pull a blob unless this node has decided it doesn't want it.
       *
       * The three outcomes are deliberately distinct and only two of them
       * existed before:
       *   - "landed"  — bytes are here (or there were none to fetch).
       *   - "elided"  — bytes deliberately declined. **Advances the watermark**,
       *                 because the record is not owed. This is the whole point
       *                 of the residency work: without it, declining a blob is
       *                 indistinguishable from failing to fetch one, so the
       *                 watermark holds and the peer re-ships forever.
       *   - "failed"  — wanted and didn't arrive. Watermark holds; retry next
       *                 round, exactly as before.
       */
      async function pullBlob(
        manifest: FileSyncManifest | null,
        candidate: BlobCandidate | null,
        itemId: string,
      ): Promise<"landed" | "elided" | "failed"> {
        if (!manifest) return "landed";
        let verdict: ResidencyVerdict | null = null;
        if (residency && candidate) {
          verdict = await residency.decide(candidate);
          if (verdict.decision === "elide") {
            elidedCount += 1;
            return "elided";
          }
        }
        const ok = await transferBlobSafe(
          manifest,
          remoteObjectStorage,
          localObjectStorage,
          fileSyncEngine,
          "download",
          itemId,
        );
        if (!ok) return "failed";
        // Accounting moves only once the bytes are here. Crediting a decision
        // rather than an arrival would let a node with a flaky link slowly
        // convince itself it is full of things it doesn't have.
        if (residency?.onLanded && candidate && verdict) {
          await residency.onLanded(candidate, verdict);
        }
        return "landed";
      }

      // Authors whose inbound run broke — a blob that would not download, a row
      // that would not apply. The mirror of `truncatedByFailure`, and it gates
      // inbound-floor retirement for the same reason: the floor is the only
      // thing still asking the peer for the rows underneath the hole.
      const inboundBrokeFor = new Set<string>();
      for (const [nodeId, items] of inboundByNode) {
        let contiguous = true;
        for (const item of items) {
          if (item.kind === "record") {
            const snapshot = item.record;
            const current = await localDatabaseAdapter.get(snapshot.id);
            const metadataAlreadyApplied =
              current !== null &&
              compareHLC(current.updatedAt, snapshot.updatedAt) >= 0;

            if (!metadataAlreadyApplied) {
              clock.receive(snapshot.updatedAt);
              await localDatabaseAdapter.put(snapshot);
            }

            // Always attempt blob pull when the record needs one. The
            // "metadata already applied" branch covers the case where a
            // prior round landed the row but failed the blob pull (Staged
            // residency) — without this, the watermark would advance past
            // the failed blob in round 2 and the record would be stuck.
            const manifest = manifestForRecord(snapshot);
            const outcome = await pullBlob(
              manifest,
              candidateForRecord(snapshot),
              snapshot.id,
            );
            if (outcome === "failed") {
              // Metadata applied (or already was), but blob fetch failed.
              // Don't advance own watermark past this item — next round the
              // responder still ships it (because our advertised watermarks
              // haven't moved past it) and we'll retry the blob.
              contiguous = false;
              inboundBrokeFor.add(nodeId);
              continue;
            }

            // Only fire the change notifier when metadata was newly applied
            // this round. A blob-retry on already-applied metadata isn't a
            // user-visible "data change."
            if (!metadataAlreadyApplied) appliedIds.push(snapshot.id);
            if (contiguous) ownSafeAdvance.set(nodeId, snapshot.updatedAt);
          } else if (item.kind === "label") {
            const incoming = item.label;
            // HLC LWW on the label's own row, which is the whole reason
            // labels are a separate table: a record's whole-row LWW would
            // otherwise let a concurrent metadata update eat a label.
            //
            // `value` is part of the row's identity, so each value of a
            // set-valued key gets its own LWW domain. Looking up without it
            // would compare an incoming `faces=Bob` against whichever row
            // happened to be found — and drop it as stale.
            const current = await localDatabaseAdapter.getLabel(
              incoming.recordId,
              incoming.appId,
              incoming.key,
              incoming.value,
            );
            if (
              current === null ||
              compareHLC(current.updatedAt, incoming.updatedAt) < 0
            ) {
              clock.receive(incoming.updatedAt);
              // putLabel, not upsertLabels: this writes the snapshot verbatim
              // including its tombstone, so an inbound retraction stays
              // retracted instead of being revived.
              await localDatabaseAdapter.putLabel(incoming);
              // Surface the labelled record as changed. Nothing on the record
              // row moved — a label write must never touch records.updated_at
              // — but subscribers key on record ids.
              appliedIds.push(incoming.recordId);
            }
            // No blob to pull, so a label can never fail the way a record
            // with a missing blob can; the prefix stays contiguous.
            if (contiguous) ownSafeAdvance.set(nodeId, incoming.updatedAt);
          } else {
            const entry = item.entry;
            if (!appSyncableSource) {
              // No applier configured — skip without advancing own watermark
              // (we have no way to durably accept this row).
              contiguous = false;
              inboundBrokeFor.add(nodeId);
              continue;
            }
            clock.receive(entry.timestamp);
            try {
              await appSyncableSource.applier.apply(entry);
            } catch (err) {
              console.warn(
                `[sync] appSyncableRow apply failed (app=${entry.appId} table=${entry.table}): ${(err as Error).message}`,
              );
              contiguous = false;
              inboundBrokeFor.add(nodeId);
              continue;
            }

            const manifest = manifestForAppRow(entry);
            const outcome = await pullBlob(
              manifest,
              candidateForAppRow(entry),
              `${entry.appId}.${entry.table}`,
            );
            if (outcome === "failed") {
              contiguous = false;
              inboundBrokeFor.add(nodeId);
              continue;
            }

            if (contiguous) ownSafeAdvance.set(nodeId, entry.timestamp);
          }
        }
      }

      // ---------------------------------------------------------------------
      // Persist updated watermarks.
      // ---------------------------------------------------------------------
      // Did this round change anything that survives it?
      //
      // Counting applied/shipped/elided is not enough to answer that. A repair
      // round re-receives rows the peer already has, applies none of them —
      // they are LWW no-ops — and still makes real progress by advancing its
      // floor. Judging it by item counts would call it stalled and abandon the
      // repair one roundful in. What matters is whether any persisted position
      // moved, because if none did, the next request is byte-identical to this
      // one and running it again cannot help.
      //
      // Rows the peer halted are not counted, and that is what keeps the loop
      // from spinning. A shipment the responder discarded left our side looking
      // busy — the rows went out, `shipped` is non-zero — while changing nothing
      // anywhere; counting it as progress would make a peer whose apply fails
      // persistently run every round of the budget re-sending the same row.
      // Excluded here, the stall detector sees the round for what it is and
      // `sync()` returns `complete: false, stalled: true`.
      const acceptedOutbound =
        outboundRecords.filter((r) => !haltedByPeer.has(r.updatedAt.nodeId)).length +
        outboundLabels.filter((l) => !haltedByPeer.has(l.updatedAt.nodeId)).length +
        outboundAppRows.filter((e) => !haltedByPeer.has(e.timestamp.nodeId)).length;
      let progressed =
        appliedIds.length > 0 || acceptedOutbound > 0 || elidedCount > 0;

      if (syncState) {
        const nextOwnWatermarks: Watermarks = { ...ownWatermarks };
        for (const hlc of ownSafeAdvance.values()) {
          advanceWatermark(nextOwnWatermarks, hlc);
        }
        if (!sameWatermarks(ownWatermarks, nextOwnWatermarks)) progressed = true;
        await syncState.setWatermarks(nextOwnWatermarks);

        // Authoritative replace (never merge): the responder's coverage
        // report is the truth about what it holds. Replacing lets the map
        // move *down* after peer-side loss, which is what triggers re-ship.
        if (!sameWatermarks(priorPeerWatermarks, response.responderWatermarks)) {
          progressed = true;
        }
        await syncState.setPeerWatermarks(response.responderWatermarks);

        // Retire repair floors, per author, once a **pushing** round has
        // drained the outbound side *and that author's shipment was not cut
        // short by a failed transfer*.
        //
        // Not on the peer's coverage watermark: the floor sits *below* that
        // watermark by construction — that is the whole point, since the hole
        // is under it — so a watermark comparison reads as "already covered"
        // from the very first round and retires the floor before it has
        // re-shipped anything. Nor on a pull-only round, which ships nothing
        // and so proves nothing. And not on an author whose upload failed
        // mid-batch: `outboundHasMore` describes the *scan*, so it stays false
        // while the shipment was silently truncated, and clearing the floor
        // there discards the only record that the hole still needs filling.
        //
        // Nor on an author the *peer* dropped. A repair round whose rows shipped
        // fine and were then discarded on arrival is the same event as a failed
        // upload — the hole is still a hole — and only `haltedAuthors` says so,
        // because every local signal reports a clean round.
        if (push && !outboundHasMore) {
          const floors = await loadRepairFloors();
          const retained: Watermarks = {};
          for (const [nodeId, floor] of Object.entries(floors)) {
            if (truncatedByFailure.has(nodeId) || haltedByPeer.has(nodeId)) {
              retained[nodeId] = floor;
            }
          }
          if (Object.keys(floors).length !== Object.keys(retained).length) {
            progressed = true;
            await syncState.setRepairFloors(retained);
          }
        }

        // The inbound mirror, and it has to be a **cursor**, not a fixed mark.
        //
        // The floor is what we advertise, and what we advertise is what the
        // responder scans above. Our own watermark cannot move it along: it is
        // already above the hole (that is what made the hole invisible), so
        // re-receiving rows underneath it advances nothing. Leave the floor
        // where it is and every round asks for the same range, gets the same
        // answer, and the repair never gets past its first roundful.
        //
        // So the floor climbs to wherever this round's contiguous run reached.
        // `ownSafeAdvance` already stops at the first item that did not land,
        // which is exactly where the next request should resume.
        const inbound = await loadInboundFloors();
        if (Object.keys(inbound).length > 0) {
          const next: Watermarks = {};
          for (const [nodeId, floor] of Object.entries(inbound)) {
            // Retire only when the peer has nothing further and this author's
            // run was unbroken — the one event meaning the gap is filled.
            if (!response.hasMore && !inboundBrokeFor.has(nodeId)) continue;
            const landed = ownSafeAdvance.get(nodeId);
            next[nodeId] =
              landed && compareHLC(landed, floor) > 0 ? landed : floor;
          }
          if (!sameWatermarks(inbound, next)) progressed = true;
          await syncState.setInboundFloors(next);
        }
      }

      if (appliedIds.length > 0) {
        changeNotifier.emit({
          eventType: "local-data-synced",
          recordIds: appliedIds,
          timestamp: clock.now(),
        });
      }

      return {
        applied: appliedIds.length,
        // All three streams, including labels. Counting two of the three made
        // `shipped` unusable as a progress signal on a label-heavy round — the
        // caller sees a frozen counter while the round is doing real work — and
        // unusable as a stall detector, which is what `sync()` needs it for.
        shipped:
          outboundRecords.length + outboundLabels.length + outboundAppRows.length,
        hasMore: response.hasMore,
        outboundHasMore,
        elided: elidedCount,
        progressed,
        // Something this round *selected* could not be moved — a blob that
        // would not transfer, a row that would not apply — so an author's run
        // stopped short in one direction or the other.
        //
        // Kept separate from `outboundHasMore`, which describes only the scan
        // and is therefore false in exactly this case: the scan fit the budget,
        // the shipment did not survive. Without this the loop below reads a
        // permanently failing upload as "both directions drained" and reports
        // the sync complete with the record still not in the cloud.
        //
        // The third term is the peer's half of the same observation. A round
        // whose rows the responder threw away drains both scans and fails no
        // local transfer, so on the first two terms alone it reported a
        // finished sync while nothing had ever landed — F2's silent success,
        // reached from the other end of the wire.
        blocked:
          truncatedByFailure.size > 0 ||
          inboundBrokeFor.size > 0 ||
          haltedByPeer.size > 0,
      };
  }

  return {
    exchange,

    async sync(options?: SyncOptions): Promise<SyncResult> {
      const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;
      const totals: SyncResult = {
        rounds: 0,
        applied: 0,
        shipped: 0,
        elided: 0,
        complete: false,
        stalled: false,
      };

      // Refresh before pushing, but only when there is something to push.
      //
      // `peerWatermarks` is a cache of what the peer last said about itself,
      // and a round whose response was lost leaves it stale-low — so pushing
      // against it re-ships items the peer already took. A pull-only round
      // fixes that for the cost of one small request, and it is not wasted
      // work: it still carries our watermarks and takes delivery of everything
      // the peer holds for us.
      //
      // Gated on there being a backlog because in steady state a pull-only
      // round followed by a pushing round are *byte-identical requests* — the
      // second would be pure doubling of the quietest, most frequent case. The
      // check is local and cheap (a grouped index read, and one seek only if
      // that read shows something owed), so it costs nothing when it says no.
      let pullFirst = false;
      if ((await hasOutboundBacklog()).owed) {
        const result = await exchange({ push: false });
        totals.rounds += 1;
        totals.applied += result.applied;
        totals.elided += result.elided;
        options?.onRound?.(result, totals.rounds);
        pullFirst = true;
      }

      for (let round = pullFirst ? 1 : 0; round < maxRounds; round += 1) {
        if (options?.signal?.aborted) return totals;
        const result = await exchange();
        totals.rounds += 1;
        totals.applied += result.applied;
        totals.shipped += result.shipped;
        totals.elided += result.elided;
        options?.onRound?.(result, totals.rounds);

        // Drained means drained in every sense: nothing left to scan on either
        // side, *and* nothing this round selected was left behind.
        //
        // `blocked` is the third term and it is not redundant. `hasMore` and
        // `outboundHasMore` describe scans; a round whose scan fit the budget
        // and whose upload then failed reports both false while shipping
        // nothing, and without the third term takes this exit — returning
        // `complete: true, stalled: false` for a record that is not in the
        // cloud and never will be. That is the value `/sync/now` hands back and
        // the one the phone's "Sync now" button reads, so it is the difference
        // between a silent success and "something could not transfer".
        if (!result.hasMore && !result.outboundHasMore && !result.blocked) {
          totals.complete = true;
          break;
        }

        // Stop when a round achieves nothing.
        //
        // `hasMore` and `outboundHasMore` are *predictions* — "there is more
        // owed" — and neither is monotone under failure. A blob that will never
        // upload is swallowed into a `false` return (deliberately: the
        // contiguous-prefix rule needs it swallowed, so it is not an error at
        // this layer and "break on error" never fires), leaving a round that
        // scans a backlog, ships nothing, and reports more owed — identically,
        // forever. Before the loop existed the poll interval bounded that to
        // one retry per tick; the loop removed the bound without replacing it.
        //
        // So terminate on an *observation* instead: a round that applied
        // nothing, shipped nothing and declined nothing has left the world
        // exactly as it found it, and the next round is a byte-identical
        // request. Stopping is safe and free — the watermarks make the next
        // call resume in place — and `stalled` says why, so a caller can
        // surface "sync is not making progress" rather than a silent no-op.
        if (!result.progressed) {
          totals.stalled = true;
          break;
        }
      }

      return totals;
    },

    async verify(): Promise<VerifyResult> {
      // Whether *we* still owe the peer anything, asked before the comparison
      // so the answer describes the same moment the digests do.
      const outboundBacklog = await hasOutboundBacklog();
      if (!outboundBacklog.readable) {
        // A table we could not read is not a table with nothing owed in it, and
        // "drained" is what the comparison below would take from it — arming
        // repair floors and reporting divergence against a question we never
        // answered. Same family as the digest guard further down.
        console.warn("[sync] outbound backlog unreadable; skipping verification");
        return { ...NOT_VERIFIED, supported: false };
      }
      // Ask the peer for its counts while sending nothing. This is an integrity
      // check, not a sync round: mixing it into a pushing round would make the
      // comparison a moving target, since the peer's counts would include rows
      // this very request had just delivered.
      //
      // The prefix length goes on the wire rather than being assumed. Both
      // sides bucketing by a different width would make every bucket disagree —
      // a full-library "repair" reported as catastrophic divergence — and there
      // would be nothing in the response to notice it by.
      //
      // `limit: 0` is what makes "sending nothing" also mean "receiving
      // nothing", and the mechanism is worth naming because it is not
      // `cutRound`: that always takes a first item regardless of budget, so an
      // empty round cannot come from the budget alone. It comes from
      // `collectSince`'s `limit <= 0` branch, which pins every author's ceiling
      // to `null` — nothing safe to ship for anyone — and `cutRound` then has
      // no item to take. Removing that branch would silently turn this into a
      // one-item sync round.
      const response = await transport.exchange({
        // The **floored** map, not the raw one. An outstanding inbound repair
        // *is* an inbound backlog, and advertising as if it were not made
        // `hasMore` describe a node with no repair running: `inboundDrained`
        // read true, `missingLocally` was reported as loss rather than as work
        // in progress, and the floor was re-armed on every press — resetting a
        // cursor that had been climbing. Two presses during a long repair meant
        // the repair never finished.
        watermarks: applyRepairFloors(
          await loadOwnWatermarks(),
          await loadInboundFloors(),
        ),
        limit: 0,
        requestDigest: true,
        digestPrefixLength: DEFAULT_BUCKET_PREFIX_LENGTH,
      });

      const peerDigest = response.digest;
      if (!peerDigest) {
        // A peer that cannot answer is not a peer that agrees. Reporting
        // `divergentBuckets: 0` here would read as "verified clean".
        return { ...NOT_VERIFIED, supported: false };
      }
      if (
        response.digestPrefixLength !== undefined &&
        response.digestPrefixLength !== DEFAULT_BUCKET_PREFIX_LENGTH
      ) {
        // Buckets that mean different things cannot be compared. Better to
        // report "not verified" than to compare them and act on the result.
        console.warn(
          `[sync] digest prefix mismatch (asked ${DEFAULT_BUCKET_PREFIX_LENGTH}, peer used ${response.digestPrefixLength}); skipping verification`,
        );
        return { ...NOT_VERIFIED, supported: false };
      }

      // The width we asked for, passed rather than defaulted: the two values
      // are the same constant, and passing it is what keeps them from drifting
      // apart if either side ever stops using the default.
      const local = await localBucketDigest(DEFAULT_BUCKET_PREFIX_LENGTH);
      if (!local.complete) {
        // A table we could not count locally would read as rows the peer has
        // and we do not — the loudest possible false alarm, and one that would
        // arm an inbound repair over the whole library. "Not checked" is the
        // honest answer.
        console.warn("[sync] local digest incomplete; skipping verification");
        return { ...NOT_VERIFIED, supported: false };
      }
      if (
        response.digestScopes !== undefined &&
        !sameScopes(local.scopes, response.digestScopes)
      ) {
        // Same reasoning as the prefix-length check above, one level up: both
        // sides sum their *own* tables into shared buckets, so a table set that
        // differs — an app upgraded on one end, a table added — makes every
        // bucket disagree in both directions over a schema difference. Refusing
        // is the only answer that does not manufacture a whole-library repair.
        console.warn(
          `[sync] digest scope mismatch (ours ${local.scopes.join(",")}, peer ${response.digestScopes.join(",")}); skipping verification`,
        );
        return { ...NOT_VERIFIED, supported: false };
      }
      const localDigest = local.buckets;

      // Two comparisons, because they are two different questions and only one
      // of them is a repair trigger.
      //
      // `missing` — buckets where the peer holds fewer rows than we do — is what
      // arms an outbound repair. It is deliberately one-directional: a bucket
      // where the *peer* has more is ordinary data we have not pulled yet, and
      // treating that as corruption would make every mid-sync check look like a
      // disaster.
      //
      // `missingLocally` is the mirror, and it is the one a person means by "is
      // my library backed up?" — it says whether *we* are whole. Reusing the
      // repair trigger for that reads "clean" to a node that is itself missing
      // rows, which is precisely the case worth knowing about.
      const missing = bucketsPeerIsMissing(localDigest, peerDigest);
      const missingHere = bucketsPeerIsMissing(peerDigest, localDigest);

      // Neither comparison can tell a hole from a queue on its own, and the
      // backlog is what separates them. A bucket the peer is short on is loss
      // only if we owe it nothing; a bucket we are short on is loss only if it
      // owes us nothing. Mid-first-sync every bucket of the backlog disagrees,
      // and reporting that as loss — and arming a repair over it — turns the
      // ordinary state of a phone catching up into a whole-library alarm.
      //
      // `inboundBacklog` comes from the zero-limit exchange this method already
      // sent: `collectSince`'s `limit <= 0` branch pins every author's ceiling
      // to `null`, and a ceiling exists per author `planNodeScans` found
      // something owed for — so `hasMore` here means "the peer has rows for us"
      // and nothing else. Both flags describe the same moment as the digests.
      const outboundDrained = !outboundBacklog.owed;
      const inboundDrained = !response.hasMore;

      if (syncState) {
        if (missing.length > 0 && outboundDrained) {
          // Arm the repair rather than performing it. The floors lower the bound
          // the ordinary outbound scan already takes, so the next `sync()` does
          // the re-shipping through the path that is already tested — LWW makes
          // everything the peer still holds a no-op.
          await syncState.setRepairFloors(
            applyRepairFloors(await loadRepairFloors(), repairFloorsFor(missing)),
          );
        }
        if (missingHere.length > 0 && inboundDrained) {
          // The symmetric repair, and it works the same way from the other end:
          // what we *advertise* as our own coverage is what the responder scans
          // above, so lowering it makes the peer re-ship into the hole. Nothing
          // else can — our watermark is unchanged by a loss underneath it, so
          // the peer believes we have the row.
          //
          // `raiseInboundFloors`, not `applyRepairFloors`: this floor is a
          // cursor the exchange loop climbs, and taking the *lower* of the two
          // — right for lowering a coverage watermark — would drop a repair
          // already halfway through back to the bottom of the range.
          await syncState.setInboundFloors(
            raiseInboundFloors(await loadInboundFloors(), repairFloorsFor(missingHere)),
          );
        }
      }

      return {
        supported: true,
        localRows: totalRows(localDigest),
        peerRows: totalRows(peerDigest),
        divergentBuckets: outboundDrained ? missing.length : 0,
        missingLocally: inboundDrained ? missingHere.length : 0,
        pendingUpload: outboundDrained ? 0 : missing.length,
        pendingDownload: inboundDrained ? 0 : missingHere.length,
      };
    },

    changeNotifier,
  };
}

/** Two watermark maps holding the same positions for the same authors. */
function sameWatermarks(a: Watermarks, b: Watermarks): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (!left || !right) return false;
    if (compareHLC(left, right) !== 0) return false;
  }
  return true;
}

/** Two digests built over the same set of data planes, in any order. */
function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const right = [...b].sort();
  return [...a].sort().every((scope, i) => scope === right[i]);
}

type OutboundItem =
  | { kind: "record"; record: AnyRecord }
  | { kind: "label"; label: RecordLabel }
  | { kind: "appRow"; entry: AppSyncableRowEntry };

type InboundItem =
  | { kind: "record"; record: AnyRecord }
  | { kind: "label"; label: RecordLabel }
  | { kind: "appRow"; entry: AppSyncableRowEntry };

function outboundItemHlc(item: OutboundItem): HLCTimestamp {
  if (item.kind === "record") return item.record.updatedAt;
  if (item.kind === "label") return item.label.updatedAt;
  return item.entry.timestamp;
}

function inboundItemHlc(item: InboundItem): HLCTimestamp {
  if (item.kind === "record") return item.record.updatedAt;
  if (item.kind === "label") return item.label.updatedAt;
  return item.entry.timestamp;
}

function outboundItemId(item: OutboundItem): string {
  if (item.kind === "record") return item.record.id;
  if (item.kind === "label") {
    return `${item.label.recordId}.${item.label.appId}.${item.label.key}`;
  }
  return `${item.entry.appId}.${item.entry.table}`;
}

/**
 * Merge SR records and AR/AW rows into per-nodeId buckets sorted in HLC order.
 * The contiguous-prefix watermark rule walks these buckets and stops on the
 * first failure, regardless of which stream that failure came from.
 */
function groupOutboundByNodeId(
  records: AnyRecord[],
  labels: RecordLabel[],
  appRows: AppSyncableRowEntry[],
): Map<string, OutboundItem[]> {
  const out = new Map<string, OutboundItem[]>();
  for (const r of records) {
    pushToBucket(out, r.updatedAt.nodeId, { kind: "record", record: r });
  }
  for (const l of labels) {
    pushToBucket(out, l.updatedAt.nodeId, { kind: "label", label: l });
  }
  for (const e of appRows) {
    pushToBucket(out, e.timestamp.nodeId, { kind: "appRow", entry: e });
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => compareHLC(outboundItemHlc(a), outboundItemHlc(b)));
  }
  return out;
}

function groupInboundByNodeId(
  records: readonly AnyRecord[],
  labels: readonly RecordLabel[],
  appRows: readonly AppSyncableRowEntry[],
): Map<string, InboundItem[]> {
  const out = new Map<string, InboundItem[]>();
  for (const r of records) {
    pushToBucket(out, r.updatedAt.nodeId, { kind: "record", record: r });
  }
  for (const l of labels) {
    pushToBucket(out, l.updatedAt.nodeId, { kind: "label", label: l });
  }
  for (const e of appRows) {
    pushToBucket(out, e.timestamp.nodeId, { kind: "appRow", entry: e });
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => compareHLC(inboundItemHlc(a), inboundItemHlc(b)));
  }
  return out;
}

function pushToBucket<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key) ?? [];
  arr.push(value);
  map.set(key, arr);
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Order of completion is deliberately not preserved — the caller re-derives
 * ordering from the items themselves, because for the contiguous-prefix rule
 * what matters is HLC order, not the order transfers happened to finish in.
 */
async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

/** Blob bytes an app-syncable row will transfer, or 0 when it carries none. */
function appRowBlobBytes(entry: AppSyncableRowEntry): number {
  const manifest = manifestForAppRow(entry);
  return manifest ? manifest.sizeBytes : 0;
}

function outboundManifest(item: OutboundItem): FileSyncManifest | null {
  if (item.kind === "record") return manifestForRecord(item.record);
  // A label is a row, never a blob — it has nothing to transfer.
  if (item.kind === "label") return null;
  return manifestForAppRow(item.entry);
}

/**
 * Normalize a shared record into the shape the residency decision reads.
 *
 * Deliberately carries no size class: the sync engine must not learn what
 * `image-medium` is. The host's decider resolves the class from the record's
 * labels, so class names and maxima can move without touching the platform.
 *
 * `recencyAtMs` is left null here because capture time lives in the
 * per-category metadata table, not on the record row, and this function has
 * only the row. A null reads as "unknown", which makes `recent-only` fetch
 * rather than decline — a metadata gap must not silently cost you the bytes.
 * A host that can do better (it has the metadata join) overrides it in its
 * decider.
 */
function candidateForRecord(record: AnyRecord): BlobCandidate | null {
  if (!record.objectStorageKey) return null;
  return {
    recordId: record.id,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    type: record.type,
    parentId: record.parentId,
    appId: null,
    recencyAtMs: null,
    lastOpenedAtMs: null,
  };
}

/** Same, for a row in the reserved `_starkeep_sync_records` table. */
function candidateForAppRow(entry: AppSyncableRowEntry): BlobCandidate | null {
  if (entry.table !== FILE_RECORDS_TABLE || entry.op === "delete") return null;
  const row = entry.row;
  if (!row) return null;
  const key = row["object_storage_key"];
  if (typeof key !== "string" || key.length === 0) return null;
  const sizeBytes = row["size_bytes"];
  const id = row["id"];
  return {
    recordId: typeof id === "string" ? id : key,
    objectStorageKey: key,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : Number(sizeBytes) || 0,
    type: null,
    parentId: null,
    appId: entry.appId,
    recencyAtMs: null,
    lastOpenedAtMs: null,
  };
}

function manifestForRecord(record: AnyRecord): FileSyncManifest | null {
  if (!record.objectStorageKey || record.deletedAt) return null;
  return {
    fileHash: record.contentHash || record.objectStorageKey,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    mimeType: record.mimeType ?? undefined,
  };
}

/**
 * Derive a blob manifest from an app-syncable row entry. Only the reserved
 * `_starkeep_sync_records` table carries blobs at the protocol level; plain
 * app-row tables (AW) never do. Tombstones return null — blob retention on
 * delete is a GC concern, not a sync concern.
 */
function manifestForAppRow(entry: AppSyncableRowEntry): FileSyncManifest | null {
  if (entry.table !== FILE_RECORDS_TABLE) return null;
  if (entry.op === "delete") return null;
  const row = entry.row;
  if (!row) return null;
  const key = row["object_storage_key"];
  if (typeof key !== "string" || key.length === 0) return null;
  const contentHash = row["content_hash"];
  const mimeType = row["mime_type"];
  const sizeBytes = row["size_bytes"];
  return {
    fileHash:
      typeof contentHash === "string" && contentHash.length > 0
        ? contentHash
        : key,
    objectStorageKey: key,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : Number(sizeBytes) || 0,
    mimeType: typeof mimeType === "string" ? mimeType : undefined,
  };
}

/**
 * Run a blob transfer through the file-sync engine, swallowing exceptions as a
 * false return so the caller can apply the contiguous-prefix rule uniformly.
 * Returns true when there is no blob to transfer.
 *
 * `transferFile` short-circuits to true if the destination already has the
 * key, so repeated invocations across ticks cost at most one HEAD per item.
 */
async function transferBlobSafe(
  manifest: FileSyncManifest | null,
  source: ObjectStorageAdapter,
  destination: ObjectStorageAdapter,
  fileSyncEngine: FileSyncEngine,
  direction: "upload" | "download",
  itemId: string,
): Promise<boolean> {
  if (!manifest) return true;
  try {
    return await fileSyncEngine.transferFile(manifest, source, destination);
  } catch (err) {
    console.warn(
      `[sync] blob ${direction} failed for ${itemId} (${manifest.objectStorageKey}): ${(err as Error).message}`,
    );
    return false;
  }
}
