import {
  compareHLC,
  serializeHLC,
  ZERO_HLC,
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
import type {
  AppSyncableRowEntry,
  ExchangeResult,
  FileSyncEngine,
  FileSyncManifest,
  SyncEngine,
  SyncEngineOptions,
  Watermarks,
} from "./types.js";
import { createChangeNotifier } from "./change-notifier.js";
import { createFileSyncEngine } from "./file-sync-engine.js";
import { advanceWatermark } from "./watermarks.js";
import type { BlobCandidate, ResidencyVerdict } from "./residency-policy.js";

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
    pageLimit = 1000,
    scanPageSize = 500,
    residency,
  } = options;

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

  return {
    async exchange(): Promise<ExchangeResult> {
      const ownWatermarks = await loadOwnWatermarks();
      const peerWatermarks = await loadPeerWatermarks();

      // ---------------------------------------------------------------------
      // Outbound: gather SR records and AR/AW rows the peer hasn't seen, then
      // walk per nodeId in HLC order with a contiguous-prefix rule. Blobs
      // (SR or AR) are pushed before their owning item is allowed to ship.
      // ---------------------------------------------------------------------
      //
      // Both the SR scan and the AR/AW scanSince path below are cursor-
      // paginated so records past any fixed window are reachable: we iterate
      // the DB in its default order and apply the per-nodeId watermark
      // filter inline, advancing the cursor across all rows (even the ones
      // we skip). This means future rounds don't get stuck re-scanning a
      // head-of-table window that's already been shipped.
      //
      // Performance follow-up: production storage adapters should push the
      // watermark filter into the query — e.g. a per-nodeId index plus
      // `WHERE updated_at > peerWatermark[nodeId]` — so steady-state syncs
      // don't read every row to find nothing. The current loop is O(N) per
      // round when the watermark is at the latest record. Acceptable for
      // current poll volumes; revisit if scans get hot. Same caveat applies
      // to the responder-side scan in in-process-transport.ts.
      const recordCandidates: AnyRecord[] = [];
      // Only the Drive channel ships shared records. Per-app channels
      // set syncSharedRecords=false and leave this scan empty — they carry only
      // app-specific rows.
      if (syncSharedRecords) {
        let scanCursor: string | undefined = undefined;
        let scanHasMore = true;
        while (recordCandidates.length < pageLimit && scanHasMore) {
          const page = await localDatabaseAdapter.query({
            limit: scanPageSize,
            ...(scanCursor !== undefined ? { cursor: scanCursor } : {}),
          });
          if (page.records.length === 0) break;
          for (const r of page.records) {
            const peerHlc = peerWatermarks[r.updatedAt.nodeId];
            if (!peerHlc || compareHLC(r.updatedAt, peerHlc) > 0) {
              recordCandidates.push(r);
              if (recordCandidates.length >= pageLimit) break;
            }
          }
          scanHasMore = page.hasMore;
          scanCursor = page.nextCursor ?? undefined;
        }
      }

      // Label scan. Same channel, same cursor pattern, same per-nodeId
      // watermark filter as the records scan above — labels are shared data,
      // so only the Drive channel carries them.
      const labelCandidates: RecordLabel[] = [];
      if (syncSharedRecords) {
        let labelCursor: string | undefined = undefined;
        let labelHasMore = true;
        while (labelCandidates.length < pageLimit && labelHasMore) {
          const page = await localDatabaseAdapter.queryLabels({
            limit: scanPageSize,
            ...(labelCursor !== undefined ? { cursor: labelCursor } : {}),
          });
          if (page.labels.length === 0) break;
          for (const l of page.labels) {
            const peerHlc = peerWatermarks[l.updatedAt.nodeId];
            if (!peerHlc || compareHLC(l.updatedAt, peerHlc) > 0) {
              labelCandidates.push(l);
              if (labelCandidates.length >= pageLimit) break;
            }
          }
          labelHasMore = page.hasMore;
          labelCursor = page.nextCursor ?? undefined;
        }
      }

      // AR/AW scan: same cursor pattern as the SR loop above. scanSince
      // paginates by `updated_at` (serialized HLC), so each page advances
      // the cursor across both filtered and selected rows. Combined cap of
      // `pageLimit` is enforced across all (namespace, table) pairs.
      const appRowCandidates: AppSyncableRowEntry[] = [];
      if (appSyncableSource) {
        const zeroStr = serializeHLC(ZERO_HLC);
        outer: for (const ns of appSyncableSource.namespaces.list()) {
          for (const tableInfo of ns.tables) {
            let appScanCursor: string | undefined = undefined;
            let appScanHasMore = true;
            while (
              recordCandidates.length + appRowCandidates.length < pageLimit &&
              appScanHasMore
            ) {
              let page: { rows: AppSyncableRowEntry[]; nextCursor: string | null; hasMore: boolean };
              try {
                page = await appSyncableSource.applier.scanSince(
                  ns.appId,
                  tableInfo.name,
                  zeroStr,
                  {
                    limit: scanPageSize,
                    ...(appScanCursor !== undefined ? { cursor: appScanCursor } : {}),
                  },
                );
              } catch (err) {
                console.warn(
                  `[sync] exchange scanSince failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
                );
                break;
              }
              if (page.rows.length === 0) break;
              for (const r of page.rows) {
                const peerHlc = peerWatermarks[r.timestamp.nodeId];
                if (!peerHlc || compareHLC(r.timestamp, peerHlc) > 0) {
                  appRowCandidates.push(r);
                  if (
                    recordCandidates.length + appRowCandidates.length >=
                    pageLimit
                  ) {
                    break;
                  }
                }
              }
              appScanHasMore = page.hasMore;
              appScanCursor = page.nextCursor ?? undefined;
            }
            if (
              recordCandidates.length + appRowCandidates.length >=
              pageLimit
            ) {
              break outer;
            }
          }
        }
      }

      // SR side is already capped at pageLimit by the cursor loop above.
      // If we also collected AR/AW rows, the combined set may exceed
      // pageLimit, so take the globally-earliest-HLC pageLimit items.
      // Items deferred here ship next round because the peer's watermarks
      // won't have advanced past them.
      const cappedRecords: AnyRecord[] = [];
      const cappedLabels: RecordLabel[] = [];
      const cappedAppRows: AppSyncableRowEntry[] = [];
      if (
        recordCandidates.length + labelCandidates.length + appRowCandidates.length <=
        pageLimit
      ) {
        cappedRecords.push(...recordCandidates);
        cappedLabels.push(...labelCandidates);
        cappedAppRows.push(...appRowCandidates);
      } else {
        // Take the globally-earliest-HLC pageLimit items across all three
        // streams. Labels must be in this sort, not appended after it:
        // deferring a label whose HLC precedes a shipped record would break
        // the contiguous-prefix rule the coverage watermark depends on.
        type Tagged =
          | { kind: "r"; rec: AnyRecord; hlc: HLCTimestamp }
          | { kind: "l"; label: RecordLabel; hlc: HLCTimestamp }
          | { kind: "a"; row: AppSyncableRowEntry; hlc: HLCTimestamp };
        const tagged: Tagged[] = [
          ...recordCandidates.map(
            (r): Tagged => ({ kind: "r", rec: r, hlc: r.updatedAt }),
          ),
          ...labelCandidates.map(
            (l): Tagged => ({ kind: "l", label: l, hlc: l.updatedAt }),
          ),
          ...appRowCandidates.map(
            (e): Tagged => ({ kind: "a", row: e, hlc: e.timestamp }),
          ),
        ];
        tagged.sort((a, b) => compareHLC(a.hlc, b.hlc));
        for (const t of tagged.slice(0, pageLimit)) {
          if (t.kind === "r") cappedRecords.push(t.rec);
          else if (t.kind === "l") cappedLabels.push(t.label);
          else cappedAppRows.push(t.row);
        }
      }

      const outboundByNode = groupOutboundByNodeId(
        cappedRecords,
        cappedLabels,
        cappedAppRows,
      );

      const outboundRecords: AnyRecord[] = [];
      const outboundLabels: RecordLabel[] = [];
      const outboundAppRows: AppSyncableRowEntry[] = [];

      for (const items of outboundByNode.values()) {
        for (const item of items) {
          const manifest = outboundManifest(item);
          if (manifest) {
            const ok = await transferBlobSafe(
              manifest,
              localObjectStorage,
              remoteObjectStorage,
              fileSyncEngine,
              "upload",
              outboundItemId(item),
            );
            if (!ok) break;
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
        watermarks: ownWatermarks,
        records: outboundRecords.length > 0 ? outboundRecords : undefined,
        labels: outboundLabels.length > 0 ? outboundLabels : undefined,
        appSyncableRows: outboundAppRows.length > 0 ? outboundAppRows : undefined,
        limit: pageLimit,
      });

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
              continue;
            }

            if (contiguous) ownSafeAdvance.set(nodeId, entry.timestamp);
          }
        }
      }

      // ---------------------------------------------------------------------
      // Persist updated watermarks.
      // ---------------------------------------------------------------------
      if (syncState) {
        const nextOwnWatermarks: Watermarks = { ...ownWatermarks };
        for (const hlc of ownSafeAdvance.values()) {
          advanceWatermark(nextOwnWatermarks, hlc);
        }
        await syncState.setWatermarks(nextOwnWatermarks);

        // Authoritative replace (never merge): the responder's coverage
        // report is the truth about what it holds. Replacing lets the map
        // move *down* after peer-side loss, which is what triggers re-ship.
        await syncState.setPeerWatermarks(response.responderWatermarks);
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
        shipped: outboundRecords.length + outboundAppRows.length,
        hasMore: response.hasMore,
        elided: elidedCount,
      };
    },

    changeNotifier,
  };
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
