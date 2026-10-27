import {
  compareHLC,
  type DataRecord,
  type HLCClock,
  type HLCTimestamp,
  type RecordLabel,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { admitIncomingStandIn } from "../stand-in-slots.js";
import {
  applyRecordMetadata,
  deleteRecordMetadata,
  restoreRecordMetadata,
  loadMetadataForRecords,
  mergeDigestBuckets,
  scopeDigestBuckets,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DatabaseAdapter,
  type DigestBucket,
  type ObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import type {
  ByteCoverageStore,
  SyncTransport,
  SyncExchangeRequest,
  SyncExchangeResponse,
  AppSyncableRowEntry,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  ScanCapableApplier,
  SyncRecordItem,
  Watermarks,
} from "../types.js";
import { SHARED_DIGEST_SCOPE } from "../types.js";
import { advanceWatermark } from "../watermarks.js";
import {
  advanceBytesWatermark,
  carriesFiles,
  clampToRows,
  FILE_RECORDS_TABLE,
  scanFileRows,
  type FileRow,
  type FileRowSources,
} from "../file-rows.js";
import { computeCeilings, cutRound, type RoundItem, type StreamTruncation } from "../round-cut.js";
import { DEFAULT_RESPONDER_MAX_ITEMS, DEFAULT_RESPONDER_MAX_BYTES } from "../exchange-request.js";

/** One row eligible to ship back, tagged with which stream it came from. */
type OutboundRow =
  | { kind: "record"; record: SyncRecordItem }
  | { kind: "label"; label: RecordLabel }
  | { kind: "appRow"; entry: AppSyncableRowEntry };

export interface InProcessTransportOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly clock: HLCClock;
  /**
   * When provided, the transport synthesizes app-syncable row entries on
   * exchange (by scanning updated_at per table) and applies incoming rows on
   * apply (LWW UPSERT).
   */
  readonly appSyncableSource?: {
    readonly namespaces: AppSyncableNamespaceStore;
    readonly applier: AppSyncableApplier;
  };
  /**
   * Object storage backing the records this transport serves. Used only as a
   * reference for the file-transfer pass elsewhere; the exchange protocol
   * itself does no blob inspection.
   */
  readonly objectStorage: ObjectStorageAdapter;
  /**
   * Channel split (responder side). When true (default), this transport
   * applies and scans shared records (the `shared.records` table). The
   * cloud-side Drive channel sets this true with no `appSyncableSource`; per-app
   * channels set it false and serve only that app's app-specific rows. Mirrors
   * `SyncEngineOptions.syncSharedRecords` on the requester side.
   */
  readonly syncSharedRecords?: boolean;
  /**
   * Asked before a synced tombstone replaces a live row this side holds. True
   * refuses the tombstone: the live row is re-written under this side's clock,
   * so the same response carries it back and the sender's copy comes back to
   * life by ordinary last-writer-wins.
   *
   * The cloud uses it for the one row it must never lose: the canonical
   * stand-in of an archived original, which is all the person can see until a
   * restore. A sync apply cannot answer "no" any other way — a thrown apply
   * stops the channel.
   */
  readonly keepLiveOnTombstone?: (
    current: DataRecord,
    incoming: DataRecord,
    request: SyncExchangeRequest,
  ) => Promise<boolean>;
  /**
   * Called once per exchange, after every incoming row has been applied and
   * before the reply is scanned, with the records and labels this side
   * actually stored. The cloud decides archiving from it.
   *
   * A failure here is logged and never fails the exchange: the rows are
   * already stored, and the work it drives is re-derivable.
   */
  readonly onApplied?: (applied: {
    readonly records: readonly DataRecord[];
    readonly labels: readonly RecordLabel[];
  }) => Promise<void>;
  /**
   * Where this side keeps its own bytes watermark between exchanges. See
   * `SyncExchangeResponse.responderByteWatermarks`.
   *
   * Defaults to memory held by this transport instance, which suits tests and
   * any responder that lives as long as its transport. A responder that builds
   * a transport per request — the cloud — must pass a durable store, or every
   * exchange walks each author's files from the beginning.
   */
  readonly byteCoverage?: ByteCoverageStore;
  /**
   * The shared records the bytes watermark walks, when they differ from
   * `databaseAdapter`'s. A mobile app's exchange runs on an adapter narrowed to
   * the app's types, but the bytes watermark is stored per channel and every
   * caller of the Drive channel shares it: a walk over the narrowed rows would
   * step past files of other types it never checked, and save that for
   * everyone. With this set, the walk reads the whole library and the reply's
   * bytes watermark is cut back to the narrowed rows watermark.
   */
  readonly fileRecords?: DatabaseAdapter;
  /**
   * True when this side declines the file under an object key, so the walk
   * counts it as held. The cloud declines `starkeep/no-cloud` files, which it
   * also refuses to accept.
   */
  readonly declinesBlob?: (objectStorageKey: string) => Promise<boolean>;
  /**
   * Called with the shared records whose files this side's bytes watermark has
   * just moved past, after the walk saves the new value. A declined file
   * counts, as it does for the watermark.
   *
   * The walk is where a responder first learns that a file has arrived. A
   * requester uploads through presigned URLs the responder never sees, and
   * rows now land ahead of their files, so a decision taken when the row
   * applied may have found no bytes. The cloud re-decides archiving here.
   *
   * A file waiting behind an earlier missing file is reported only once the
   * watermark reaches it. A throw is logged and never fails the exchange.
   */
  readonly onFilesHeld?: (recordIds: readonly StarkeepId[]) => Promise<void>;
  /**
   * Called once per exchange with what the walk did: the stored bytes
   * watermark it started from, where it ended, and per author the first file
   * it found missing. The cloud logs this, because the pin is where a
   * requester's uploads are waited on. Called before the reply is built; a
   * throw is ignored.
   */
  readonly onWalk?: (walk: ByteWalkReport) => void;
}

/** What one exchange's walk over the bytes watermark found. */
export interface ByteWalkReport {
  readonly from: Watermarks;
  readonly to: Watermarks;
  /** Per author, the first file the walk found missing, where it stopped. */
  readonly pins: Readonly<Record<string, { readonly key: string; readonly hlc: HLCTimestamp }>>;
}

/**
 * `SyncTransport` that talks directly to an in-process database adapter.
 * Used for tests and for running a "cloud" side in the same Node process.
 *
 * Exchange semantics:
 *   - Apply incoming records via `put(snapshot)` with HLC LWW.
 *   - Scan local records the caller hasn't seen (per-nodeId watermark filter).
 *   - Return `responderWatermarks` = MAX(updated_at) per nodeId.
 *
 * Conflict resolution is pure HLC LWW — no rejected[], no OCC.
 */
export function createInProcessSyncTransport(options: InProcessTransportOptions): SyncTransport {
  const {
    databaseAdapter,
    clock,
    appSyncableSource,
    syncSharedRecords = true,
    keepLiveOnTombstone,
    onApplied,
    declinesBlob,
    onFilesHeld,
    onWalk,
  } = options;
  const byteCoverage = options.byteCoverage ?? createMemoryByteCoverageStore();

  // This channel's file-bearing rows on this side: shared records on the Drive
  // channel, each app's reserved file table on a per-app channel.
  const scanCapableApplier = appSyncableSource?.applier as ScanCapableApplier | undefined;
  const fileRowSources: FileRowSources = {
    records: syncSharedRecords ? (options.fileRecords ?? databaseAdapter) : null,
    fileTables:
      appSyncableSource && typeof scanCapableApplier?.scanSince === "function"
        ? appSyncableSource.namespaces
            .list()
            .filter((ns) => ns.tables.some((t) => t.name === FILE_RECORDS_TABLE))
            .map((ns) => ({
              appId: ns.appId,
              scanSince: (watermarks: Watermarks, limit: number) =>
                scanCapableApplier.scanSince(ns.appId, FILE_RECORDS_TABLE, watermarks, limit),
            }))
        : [],
  };

  /**
   * Advance this side's bytes watermark over the files now in its storage.
   *
   * Starts from the stored value, lowered to the rows watermark wherever rows
   * were lost, and checks files above it in timestamp order per author,
   * stopping at each author's first missing file. The checks are spread
   * across authors and capped per exchange, so a first walk over an existing
   * library takes several exchanges rather than one long one.
   *
   * Undefined when the stored value will not load. The response then carries
   * no bytes watermark, and a requester stops pushing rather than ship rows
   * whose uploads nothing would remember.
   */
  async function walkByteCoverage(rowsWatermarks: Watermarks): Promise<Watermarks | undefined> {
    // A channel with no file-bearing table owes no file for any row.
    if (!carriesFiles(fileRowSources)) return { ...rowsWatermarks };
    if (!options.fileRecords) return walkFrom(rowsWatermarks);
    // The walk runs over the whole library, clamped by the whole library's
    // rows; the reply never claims more than the narrowed rows hold.
    let wholeRows: Watermarks;
    try {
      wholeRows = {};
      for (const hlc of Object.values(await options.fileRecords.getNodeWatermarks())) {
        advanceWatermark(wholeRows, hlc);
      }
      for (const hlc of Object.values(await options.fileRecords.getLabelNodeWatermarks())) {
        advanceWatermark(wholeRows, hlc);
      }
    } catch (err) {
      console.warn(
        `[sync] could not read the library's rows watermark for the bytes walk: ${(err as Error).message}`,
      );
      return undefined;
    }
    const walked = await walkFrom(wholeRows);
    return walked === undefined ? undefined : clampToRows(walked, rowsWatermarks);
  }

  /** The walk itself, clamped by `rowsWatermarks`. See {@link walkByteCoverage}. */
  async function walkFrom(rowsWatermarks: Watermarks): Promise<Watermarks | undefined> {
    let stored: Watermarks;
    try {
      stored = await byteCoverage.load();
    } catch (err) {
      console.warn(`[sync] could not load this side's bytes watermark: ${(err as Error).message}`);
      return undefined;
    }
    const from = clampToRows(stored, rowsWatermarks);
    const scan = await scanFileRows(fileRowSources, from, BYTE_WALK_MAX_ROWS);
    if (!scan.readable) return from;
    const pins: Record<string, { key: string; hlc: HLCTimestamp }> = {};

    const byAuthor = new Map<string, { row: FileRow; satisfied: boolean }[]>();
    for (const row of scan.rows) {
      const run = byAuthor.get(row.hlc.nodeId) ?? [];
      run.push({ row, satisfied: !row.manifest });
      byAuthor.set(row.hlc.nodeId, run);
    }
    const share = Math.max(
      BYTE_WALK_CONCURRENCY,
      Math.floor(BYTE_WALK_MAX_CHECKS / Math.max(1, byAuthor.size)),
    );
    for (const run of byAuthor.values()) {
      run.sort((a, b) => compareHLC(a.row.hlc, b.row.hlc));
      const toCheck = run.filter((entry) => entry.row.manifest !== null).slice(0, share);
      let stopped = false;
      for (let start = 0; start < toCheck.length && !stopped; start += BYTE_WALK_CONCURRENCY) {
        const batch = toCheck.slice(start, start + BYTE_WALK_CONCURRENCY);
        const held = await Promise.all(
          batch.map(async (entry) => {
            const key = entry.row.manifest!.objectStorageKey;
            try {
              if (await options.objectStorage.has(key)) return true;
              return declinesBlob ? await declinesBlob(key) : false;
            } catch (err) {
              console.warn(
                `[sync] could not check ${key} for the bytes watermark: ${(err as Error).message}`,
              );
              return false;
            }
          }),
        );
        for (const [i, entry] of batch.entries()) {
          if (!held[i]) {
            stopped = true;
            pins[entry.row.hlc.nodeId] = {
              key: entry.row.manifest!.objectStorageKey,
              hlc: entry.row.hlc,
            };
            break;
          }
          entry.satisfied = true;
        }
      }
    }

    const next = advanceBytesWatermark(
      from,
      [...byAuthor.values()]
        .flat()
        .map((entry) => ({ hlc: entry.row.hlc, satisfied: entry.satisfied })),
      scan.ceilings,
    );
    try {
      onWalk?.({ from: stored, to: next, pins });
    } catch {
      // A report is diagnostics; the walk's answer stands.
    }
    if (!sameWatermarkMaps(next, stored)) {
      try {
        await byteCoverage.save(next);
      } catch (err) {
        // The report below is still true; only the next exchange's starting
        // point is lost, and that exchange walks again from the stored value.
        console.warn(
          `[sync] could not save this side's bytes watermark: ${(err as Error).message}`,
        );
      }
    }
    if (onFilesHeld) {
      const passed = scan.rows.filter((row) => {
        if (row.manifest === null || row.recordId === null) return false;
        const after = next[row.hlc.nodeId];
        const before = from[row.hlc.nodeId];
        return (
          after !== undefined &&
          compareHLC(row.hlc, after) <= 0 &&
          (before === undefined || compareHLC(row.hlc, before) > 0)
        );
      });
      if (passed.length > 0) {
        try {
          await onFilesHeld([...new Set(passed.map((row) => row.recordId!))]);
        } catch (err) {
          console.warn(
            `[sync] the files-held hook failed for ${passed.length} record(s): ${(err as Error).message}`,
          );
        }
      }
    }
    return next;
  }

  return {
    async exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
      // 1. Apply incoming app-syncable rows per nodeId in HLC order, stopping
      //    a node's application on its first failure (including a missing
      //    namespace). Holdings must stay a contiguous per-node prefix:
      //    applying a later same-node item after an earlier one failed would
      //    lift that node's coverage watermark over the failed row, and the
      //    requester would never re-ship it. App rows go first because their
      //    failures are the only silent ones (shared-record put() throws fail
      //    the whole exchange); nodes halted here also skip their shared
      //    records below.
      const haltedNodes = new Set<string>();
      const inboundAppRowsByNode = new Map<string, AppSyncableRowEntry[]>();
      for (const entry of request.appSyncableRows ?? []) {
        const arr = inboundAppRowsByNode.get(entry.timestamp.nodeId) ?? [];
        arr.push(entry);
        inboundAppRowsByNode.set(entry.timestamp.nodeId, arr);
      }
      for (const entries of inboundAppRowsByNode.values()) {
        entries.sort((a, b) => compareHLC(a.timestamp, b.timestamp));
        for (const entry of entries) {
          if (!appSyncableSource || !appSyncableSource.namespaces.get(entry.appId)) {
            console.warn(
              `[sync] exchange skipped appSyncableRow for unknown app "${entry.appId}"; halting node ${entry.timestamp.nodeId} this round`,
            );
            haltedNodes.add(entry.timestamp.nodeId);
            break;
          }
          clock.receive(entry.timestamp);
          try {
            await appSyncableSource.applier.apply(entry);
          } catch (err) {
            console.warn(
              `[sync] exchange apply appSyncableRow failed (app=${entry.appId} table=${entry.table}): ${(err as Error).message}; halting node ${entry.timestamp.nodeId} this round`,
            );
            haltedNodes.add(entry.timestamp.nodeId);
            break;
          }
        }
      }

      // 2. Apply incoming records — pure put(snapshot). HLC LWW: skip if local
      //    copy is at-or-ahead of incoming. Only the Drive channel
      //    (syncSharedRecords=true) applies shared records. Records from
      //    nodes halted in step 1 are skipped to preserve the contiguous
      //    prefix (they re-ship next round).
      //
      //    ## Per node, in HLC order.
      //
      //    A shared-record `put()` that throws aborts the whole exchange, so
      //    no response reports coverage over a partial author. Applying each
      //    author's records in HLC order keeps that true if a record ever
      //    halts its node without throwing: a halt is only safe over a
      //    contiguous prefix, because a later record applied ahead of the
      //    halted one would lift the node's coverage over it.
      //
      //    (Records are still applied entirely before labels rather than merged
      //    per author in HLC order, unlike the requester's inbound loop. A
      //    halted node's labels are all skipped below, the ones under the halt
      //    included, which only costs their re-ship.)
      const appliedRecords: DataRecord[] = [];
      const appliedLabels: RecordLabel[] = [];
      if (syncSharedRecords) {
        const inboundRecords = [...(request.records ?? [])].sort((a, b) => {
          if (a.updatedAt.nodeId !== b.updatedAt.nodeId) {
            return a.updatedAt.nodeId < b.updatedAt.nodeId ? -1 : 1;
          }
          return compareHLC(a.updatedAt, b.updatedAt);
        });
        for (const item of inboundRecords) {
          if (haltedNodes.has(item.updatedAt.nodeId)) continue;
          // The metadata passenger comes off before the row is written; see
          // `SyncRecordItem`.
          const { metadata: incomingMetadata, ...snapshot } = item;
          const current = await databaseAdapter.get(snapshot.id);
          const rowAlreadyApplied =
            current !== null && compareHLC(current.updatedAt, snapshot.updatedAt) >= 0;
          // What this side holds for the record once the LWW comparison and the
          // keep rule have had their say: the row written below, or the row this
          // side already had when the incoming one lost. The metadata cascade
          // reads *this* rather than the incoming snapshot, because the two can
          // disagree — a refused tombstone leaves the record live, and cascading
          // on the snapshot would take its metadata anyway.
          let held: DataRecord = current ?? snapshot;
          if (!rowAlreadyApplied) {
            clock.receive(snapshot.updatedAt);
            let row: DataRecord = snapshot;
            if (
              snapshot.deletedAt &&
              current !== null &&
              !current.deletedAt &&
              keepLiveOnTombstone &&
              (await keepLiveOnTombstone(current, snapshot, request))
            ) {
              // Refused: the live row goes back out under this side's clock.
              row = { ...current, updatedAt: clock.now(), version: current.version + 1 };
            } else if (!snapshot.deletedAt) {
              // Two stand-ins for one slot: the one this side already holds
              // won, and the incoming one is stored as this side's tombstone so
              // the reply carries the verdict back. See `stand-in-slots.ts`.
              const admitted = await admitIncomingStandIn(databaseAdapter, snapshot, clock);
              if (admitted.lostTo) {
                console.warn(
                  `[sync] stand-in ${snapshot.id} lost its slot to ${admitted.lostTo}; storing it as a tombstone`,
                );
              }
              row = admitted.row;
            }
            await databaseAdapter.put(row);
            appliedRecords.push(row);
            held = row;
          }
          // **Outside** the LWW guard: an equal or older record row can still
          // carry columns this side lacks, and the record's clock does not move
          // when metadata is written, so a stale-looking row says nothing about
          // its metadata. A tombstone cascades instead, matching what a local
          // delete already does — tombstoning the row rather than dropping it,
          // which is what lets a restore bring it back.
          if (held.deletedAt) {
            await deleteRecordMetadata(databaseAdapter, held, held.deletedAt);
          } else if (current?.deletedAt) {
            // A restore arriving: the mirror cascade, run whether or not a
            // metadata passenger came with the row. See the requester's copy.
            await restoreRecordMetadata(databaseAdapter, held);
          }
          if (!held.deletedAt && incomingMetadata) {
            // `detectOwedBack: false` — a responder never answers "I hold
            // columns you did not name" by moving the record's clock. Doing so
            // would re-author the row, and this side's coverage report is
            // computed from row authorship: re-authoring the last row it held
            // from some author erases that author from the report, and the
            // requester then re-ships that author's whole history every round.
            //
            // Nothing is lost by declining. The scan below runs after this
            // apply, so a row this side holds above the requester's watermark
            // ships back merged in this very response — and a row that is not
            // above it is one the requester has already received.
            await applyRecordMetadata(databaseAdapter, snapshot, incomingMetadata, {
              detectOwedBack: false,
            });
          }
        }
      } else if ((request.records?.length ?? 0) > 0) {
        // Per-app channel received shared records — a channel-split violation
        // on the requester side. Drop them (the channel-split guard) but warn
        // so the misbehaving peer is discoverable.
        console.warn(
          `[sync] in-process transport dropped ${request.records?.length ?? 0} shared record(s) on a per-app channel (syncSharedRecords=false)`,
        );
      }

      // 2b. Apply incoming labels — same HLC LWW, same halted-node rule, on
      //     the label row's own timestamp. Labels are shared data, so a
      //     per-app channel drops them exactly as it drops records.
      if (syncSharedRecords) {
        for (const incoming of request.labels ?? []) {
          if (haltedNodes.has(incoming.updatedAt.nodeId)) continue;
          const current = await databaseAdapter.getLabel(
            incoming.recordId,
            incoming.appId,
            incoming.key,
            incoming.value,
          );
          if (current && compareHLC(current.updatedAt, incoming.updatedAt) >= 0) {
            continue;
          }
          clock.receive(incoming.updatedAt);
          // Snapshot write: an inbound retraction must stay retracted.
          await databaseAdapter.putLabel(incoming);
          appliedLabels.push(incoming);
        }
      } else if ((request.labels?.length ?? 0) > 0) {
        console.warn(
          `[sync] in-process transport dropped ${request.labels?.length ?? 0} record label(s) on a per-app channel (syncSharedRecords=false)`,
        );
      }

      if (onApplied && (appliedRecords.length > 0 || appliedLabels.length > 0)) {
        try {
          await onApplied({ records: appliedRecords, labels: appliedLabels });
        } catch (err) {
          console.warn(`[sync] in-process transport onApplied failed: ${(err as Error).message}`);
        }
      }

      // 3. Scan what the caller hasn't seen — records, then labels, then
      //    app-syncable rows — as **delta scans**: the caller's per-nodeId
      //    watermarks go into the query, which seeks the
      //    `(node_id, updated_at)` index once per author rather than reading
      //    the table and discarding the rest. Steady state, with nothing owed,
      //    issues no range query at all.
      //
      //    The three streams share one `limit` budget so no stream can starve
      //    another, and `hasMore` reports that something was left behind — the
      //    caller's cue to come back immediately rather than wait for a tick.
      const limit = request.limit ?? DEFAULT_RESPONDER_MAX_ITEMS;
      // The caller's byte budget bounds what we hand back, so an inbound round
      // costs the caller no more than an outbound one. An older caller that
      // omits it gets our default rather than an unbounded pull.
      const maxBytes = request.maxBytes ?? DEFAULT_RESPONDER_MAX_BYTES;

      // Assembled exactly the way the requester assembles its own shipment, via
      // the same module. It used to be a sequence of per-stream budgets —
      // records trimmed to bytes, then labels against whatever item budget was
      // left, then app rows — and that shape cannot express the invariant. A
      // byte trim leaves the item budget untouched, so the label scan ran on and
      // shipped labels whose HLCs sat *above* the records the trim had just
      // withheld. The caller applied both, advanced its watermark to the label,
      // and never saw those records again.
      const truncations: StreamTruncation[] = [];
      const candidates: RoundItem<OutboundRow>[] = [];
      let unreadableStream = false;

      // Per-app channels (syncSharedRecords=false) never scan or ship shared
      // records or labels.
      if (syncSharedRecords) {
        const page = await databaseAdapter.querySince(request.watermarks, limit);
        truncations.push(page.truncated);
        for (const record of page.rows) {
          candidates.push({
            value: { kind: "record", record },
            hlc: record.updatedAt,
            // Rows travel ahead of their files, so a row costs the caller no
            // byte budget here: the caller's download pass budgets the files.
            bytes: 0,
          });
        }

        // Labels carry no blobs, so they spend no byte budget — only the item cap.
        const labelPage = await databaseAdapter.queryLabelsSince(request.watermarks, limit);
        truncations.push(labelPage.truncated);
        for (const label of labelPage.rows) {
          candidates.push({ value: { kind: "label", label }, hlc: label.updatedAt, bytes: 0 });
        }
      }

      // 4. App-syncable rows, same delta rule across the registered tables.
      //    Every table is scanned every round: a table skipped for want of
      //    budget is a stream that enumerated nothing, which pins every
      //    author's ceiling to "nothing safe" and empties the round.
      if (appSyncableSource) {
        const scanCapable = appSyncableSource.applier as ScanCapableApplier;
        if (typeof scanCapable.scanSince === "function") {
          for (const ns of appSyncableSource.namespaces.list()) {
            for (const tableInfo of ns.tables) {
              try {
                const page = await scanCapable.scanSince(
                  ns.appId,
                  tableInfo.name,
                  request.watermarks,
                  limit,
                );
                truncations.push(page.truncated);
                for (const entry of page.rows) {
                  candidates.push({
                    value: { kind: "appRow", entry },
                    hlc: entry.timestamp,
                    bytes: 0,
                  });
                }
              } catch (err) {
                console.warn(
                  `[sync] in-process transport scanSince failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
                );
                unreadableStream = true;
              }
            }
          }
        }
      }

      const cut = unreadableStream
        ? { taken: [] as RoundItem<OutboundRow>[], hasMore: true }
        : cutRound(candidates, computeCeilings(truncations), { maxBytes, maxItems: limit });
      const hasMore = cut.hasMore;

      let records: SyncRecordItem[] = [];
      const labels: RecordLabel[] = [];
      const appSyncableRows: AppSyncableRowEntry[] = [];
      for (const item of cut.taken) {
        if (item.value.kind === "record") records.push(item.value.record);
        else if (item.value.kind === "label") labels.push(item.value.label);
        else appSyncableRows.push(item.value.entry);
      }

      // Each shipping record's metadata row rides with it, read once for the
      // whole page rather than per record. A read failure is not allowed to
      // fail the exchange: the record rows are what must move, and metadata
      // that missed this round rides the next one.
      if (records.length > 0) {
        try {
          const metadataById = await loadMetadataForRecords(databaseAdapter, records);
          if (metadataById.size > 0) {
            records = records.map((record) => {
              const metadata = metadataById.get(record.id);
              return metadata ? { ...record, metadata } : record;
            });
          }
        } catch (err) {
          console.warn(
            `[sync] in-process transport metadata read failed: ${(err as Error).message}`,
          );
        }
      }

      // 5. Coverage watermarks over this channel's full post-apply state
      //    (see SyncExchangeResponse.responderWatermarks). Scoped to the
      //    channel's own data plane: shared records only on the Drive
      //    channel, only the registered namespaces' tables on per-app
      //    channels.
      //
      //    A failed per-scope query omits its nodes, and **says so** through
      //    `coverageComplete`. The omission on its own was correct about
      //    correctness and silent about volume: an absent author is a floor of
      //    `undefined` on the requester, whose next outbound scan therefore
      //    starts from the beginning of that author's history — and since the
      //    requester replaces rather than merges the map, nothing anywhere
      //    notices. `progressed` is true (re-shipping the library *is*
      //    progress), `sync()` reports `complete: true`, the supervisor resets
      //    its backoff, and the next tick does it again. The only evidence was a
      //    console warning on the responder, which in the deployment that
      //    matters is a Lambda.
      //
      //    Two different facts were being encoded in one absence:
      //      - "I hold nothing from node N."  True and important — it is what
      //        makes re-ship after peer-side loss work, and the requester's
      //        authoritative-replace rule exists to serve it.
      //      - "I could not read my own coverage for scope S."  Unknown. It must
      //        not lower anything.
      //    The response type gave no way to say the second, so it said the
      //    first. `coverageComplete: false` is that missing sentence.
      //
      //    Deliberately **not** failing the exchange instead. The coverage
      //    report being unreadable does not make the round useless: the inbound
      //    direction still works and this side still applied what it was sent.
      //    Refusing would convert a degraded report into a total sync outage for
      //    that app. Report the degradation; do not weaponize it.
      const responderWatermarks: Watermarks = {};
      const unreadableCoverage: string[] = [];
      if (syncSharedRecords) {
        // A union over BOTH tables on this channel. Missing the label half
        // would let the watermark overstate coverage — the requester would
        // stop re-shipping labels the responder never received.
        //
        // Caught, where it used to be bare. The identical fault threw out of the
        // exchange here and was swallowed four lines below, so one of the two
        // was wrong by inspection; now both report through the same field.
        try {
          for (const hlc of Object.values(await databaseAdapter.getNodeWatermarks())) {
            advanceWatermark(responderWatermarks, hlc);
          }
          for (const hlc of Object.values(await databaseAdapter.getLabelNodeWatermarks())) {
            advanceWatermark(responderWatermarks, hlc);
          }
        } catch (err) {
          console.warn(
            `[sync] in-process transport getNodeWatermarks failed for shared records: ${(err as Error).message}`,
          );
          unreadableCoverage.push(SHARED_DIGEST_SCOPE);
        }
      }
      if (appSyncableSource) {
        const scanCapable = appSyncableSource.applier as ScanCapableApplier;
        if (typeof scanCapable.getNodeWatermarks === "function") {
          for (const ns of appSyncableSource.namespaces.list()) {
            for (const tableInfo of ns.tables) {
              try {
                const tableWatermarks = await scanCapable.getNodeWatermarks(
                  ns.appId,
                  tableInfo.name,
                );
                for (const hlc of Object.values(tableWatermarks)) {
                  advanceWatermark(responderWatermarks, hlc);
                }
              } catch (err) {
                console.warn(
                  `[sync] in-process transport getNodeWatermarks failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
                );
                unreadableCoverage.push(`${ns.appId}.${tableInfo.name}`);
              }
            }
          }
        }
      }

      // 5b. The bytes watermark, over the same post-apply state. Never above
      //     the rows watermark just computed. Computed even when that map is
      //     incomplete: clamping to a lower bound only understates which files
      //     this side holds, which costs a requester a redundant upload and
      //     never a lost one.
      const responderByteWatermarks = await walkByteCoverage(responderWatermarks);

      // The integrity check, only when asked: a GROUP BY over the whole index
      // is cheap but not per-round cheap, and it answers a question that only
      // changes when something has gone wrong.
      //
      // Scoped to this channel's data plane, exactly like the scans and the
      // coverage watermarks above. A per-app channel digesting shared records
      // would hand the caller counts over rows this channel never carries.
      const prefixLength = request.digestPrefixLength ?? DEFAULT_BUCKET_PREFIX_LENGTH;
      let digest: DigestBucket[] | undefined;
      let digestScopes: string[] | undefined;
      if (request.requestDigest) {
        const buckets: DigestBucket[] = [];
        const scopes: string[] = [];
        let complete = true;
        if (syncSharedRecords) {
          scopes.push(SHARED_DIGEST_SCOPE);
          try {
            buckets.push(
              ...scopeDigestBuckets(
                await databaseAdapter.bucketDigest(prefixLength),
                SHARED_DIGEST_SCOPE,
              ),
            );
          } catch (err) {
            console.warn(
              `[sync] in-process transport bucketDigest failed for shared records: ${(err as Error).message}`,
            );
            complete = false;
          }
        }
        if (appSyncableSource) {
          const scanCapable = appSyncableSource.applier as ScanCapableApplier;
          if (typeof scanCapable.bucketDigest === "function") {
            for (const ns of appSyncableSource.namespaces.list()) {
              for (const tableInfo of ns.tables) {
                const scope = `${ns.appId}.${tableInfo.name}`;
                scopes.push(scope);
                try {
                  buckets.push(
                    ...scopeDigestBuckets(
                      await scanCapable.bucketDigest(ns.appId, tableInfo.name, prefixLength),
                      scope,
                    ),
                  );
                } catch (err) {
                  console.warn(
                    `[sync] in-process transport bucketDigest failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
                  );
                  complete = false;
                }
              }
            }
          }
        }
        if (complete) {
          digest = mergeDigestBuckets(buckets);
          digestScopes = scopes.sort();
        }
        // Otherwise send no digest at all. A table we could not count is not a
        // table we hold nothing in, and a short digest is worse than none: the
        // requester would read the uncounted rows as rows the responder lost
        // and arm a repair over all of them. Omitting it takes the branch that
        // already exists for a peer that cannot answer — `supported: false`,
        // which reads as "not checked" rather than "checked and broken".
      }

      return {
        records,
        labels,
        appSyncableRows,
        responderWatermarks,
        // Omitted when this side cannot say which files it holds, which tells
        // the requester to stop pushing. See `walkByteCoverage`.
        ...(responderByteWatermarks ? { responderByteWatermarks } : {}),
        hasMore,
        // Omitted when the report is whole, so the common response stays the
        // shape it was and an older requester is unaffected. A single boolean is
        // the honest granularity: the watermarks are a per-node union *across*
        // scopes, so a per-scope gap cannot be attributed to particular nodes —
        // if any scope failed, the whole map is a lower bound rather than the
        // truth. The scope names ride alongside for the requester to log,
        // because "which table" is the first thing anyone will ask.
        ...(unreadableCoverage.length > 0
          ? {
              coverageComplete: false,
              coverageDetail: `could not read coverage for: ${unreadableCoverage.join(", ")}`,
            }
          : {}),
        // Whose items we stopped applying. The watermark already tells the
        // requester to re-ship; this tells it the round did not land, which is
        // the difference between "backup complete" and "nothing got through".
        // Omitted when empty so the common response stays the shape it was.
        ...(haltedNodes.size > 0 ? { haltedAuthors: [...haltedNodes] } : {}),
        // Echo the width actually used *and* what was counted, so a requester
        // can refuse to compare rather than compare buckets that mean different
        // things — a different width, or a different set of tables summed into
        // them.
        ...(digest ? { digest, digestPrefixLength: prefixLength, digestScopes } : {}),
      };
    },
  };
}

/**
 * Most rows one walk reads above the stored bytes watermark. Bounds the scan;
 * the check cap below bounds the requests.
 */
const BYTE_WALK_MAX_ROWS = 1000;

/** Most storage checks one exchange's walk issues, across every author. */
const BYTE_WALK_MAX_CHECKS = 256;

/** Storage checks in flight at once during a walk. */
const BYTE_WALK_CONCURRENCY = 16;

/** A bytes-watermark store held in memory. See `byteCoverage`. */
export function createMemoryByteCoverageStore(initial: Watermarks = {}): ByteCoverageStore {
  let current: Watermarks = { ...initial };
  return {
    async load() {
      return { ...current };
    },
    async save(watermarks) {
      current = { ...watermarks };
    },
  };
}

function sameWatermarkMaps(a: Watermarks, b: Watermarks): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (!left || !right || compareHLC(left, right) !== 0) return false;
  }
  return true;
}
