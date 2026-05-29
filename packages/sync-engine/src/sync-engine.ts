import {
  compareHLC,
  serializeHLC,
  ZERO_HLC,
  type AnyRecord,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/core";
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
import {
  advanceWatermark,
  selectUnseen,
  selectUnseenAppSyncable,
} from "./watermarks.js";

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
    pageLimit = 1000,
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
      // App-layer per-nodeId filter over a chunked scan — sufficient at
      // current poll volumes; per-nodeId SQL indexes are a follow-up if
      // scans get hot. Same caveat applies to the responder-side scan in
      // in-process-transport.ts.
      const localScan = await localDatabaseAdapter.query({ limit: pageLimit });
      const recordCandidates = selectUnseen(localScan.records, peerWatermarks);

      const appRowCandidates: AppSyncableRowEntry[] = [];
      if (appSyncableSource) {
        const zeroStr = serializeHLC(ZERO_HLC);
        for (const ns of appSyncableSource.namespaces.list()) {
          for (const tableInfo of ns.tables) {
            try {
              const rows = await appSyncableSource.applier.scanSince(
                ns.appId,
                tableInfo.name,
                zeroStr,
              );
              for (const r of selectUnseenAppSyncable(rows, peerWatermarks)) {
                appRowCandidates.push(r);
              }
            } catch (err) {
              console.warn(
                `[sync] exchange scanSince failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
              );
            }
          }
        }
      }

      const outboundByNode = groupOutboundByNodeId(
        recordCandidates,
        appRowCandidates,
      );

      const outboundRecords: AnyRecord[] = [];
      const outboundAppRows: AppSyncableRowEntry[] = [];
      const peerSafeAdvance = new Map<string, HLCTimestamp>();

      for (const [nodeId, items] of outboundByNode) {
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
            peerSafeAdvance.set(nodeId, item.record.updatedAt);
          } else {
            outboundAppRows.push(item.entry);
            peerSafeAdvance.set(nodeId, item.entry.timestamp);
          }
        }
      }

      const response = await transport.exchange({
        watermarks: ownWatermarks,
        records: outboundRecords.length > 0 ? outboundRecords : undefined,
        appSyncableRows: outboundAppRows.length > 0 ? outboundAppRows : undefined,
        limit: pageLimit,
      });

      // ---------------------------------------------------------------------
      // Inbound: apply records (and pull their blobs) per nodeId in HLC order,
      // interleaving SR snapshots and AR/AW rows. Own watermark advances only
      // past items that fully landed locally; peerWatermarks also advances
      // past *every* item we received — the peer demonstrated it has them by
      // shipping them — which prevents us re-shipping items that originated
      // on the peer's side.
      // ---------------------------------------------------------------------
      const inboundByNode = groupInboundByNodeId(
        response.records,
        response.appSyncableRows,
      );
      const appliedIds: StarkeepId[] = [];
      const ownSafeAdvance = new Map<string, HLCTimestamp>();

      for (const [nodeId, items] of inboundByNode) {
        let contiguous = true;
        for (const item of items) {
          const itemHlc = inboundItemHlc(item);

          // The peer has this item (it sent it to us) — peerWatermarks
          // can advance past it regardless of our local apply outcome.
          const existing = peerSafeAdvance.get(nodeId);
          if (!existing || compareHLC(itemHlc, existing) > 0) {
            peerSafeAdvance.set(nodeId, itemHlc);
          }

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
            const blobOk = await transferBlobSafe(
              manifest,
              remoteObjectStorage,
              localObjectStorage,
              fileSyncEngine,
              "download",
              snapshot.id,
            );
            if (!blobOk) {
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
            const blobOk = await transferBlobSafe(
              manifest,
              remoteObjectStorage,
              localObjectStorage,
              fileSyncEngine,
              "download",
              `${entry.appId}.${entry.table}`,
            );
            if (!blobOk) {
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

        const nextPeerWatermarks: Watermarks = { ...peerWatermarks };
        for (const hlc of peerSafeAdvance.values()) {
          advanceWatermark(nextPeerWatermarks, hlc);
        }
        await syncState.setPeerWatermarks(nextPeerWatermarks);
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
      };
    },

    changeNotifier,
  };
}

type OutboundItem =
  | { kind: "record"; record: AnyRecord }
  | { kind: "appRow"; entry: AppSyncableRowEntry };

type InboundItem =
  | { kind: "record"; record: AnyRecord }
  | { kind: "appRow"; entry: AppSyncableRowEntry };

function outboundItemHlc(item: OutboundItem): HLCTimestamp {
  return item.kind === "record" ? item.record.updatedAt : item.entry.timestamp;
}

function inboundItemHlc(item: InboundItem): HLCTimestamp {
  return item.kind === "record" ? item.record.updatedAt : item.entry.timestamp;
}

function outboundItemId(item: OutboundItem): string {
  return item.kind === "record"
    ? item.record.id
    : `${item.entry.appId}.${item.entry.table}`;
}

/**
 * Merge SR records and AR/AW rows into per-nodeId buckets sorted in HLC order.
 * The contiguous-prefix watermark rule walks these buckets and stops on the
 * first failure, regardless of which stream that failure came from.
 */
function groupOutboundByNodeId(
  records: AnyRecord[],
  appRows: AppSyncableRowEntry[],
): Map<string, OutboundItem[]> {
  const out = new Map<string, OutboundItem[]>();
  for (const r of records) {
    pushToBucket(out, r.updatedAt.nodeId, { kind: "record", record: r });
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
  appRows: readonly AppSyncableRowEntry[],
): Map<string, InboundItem[]> {
  const out = new Map<string, InboundItem[]>();
  for (const r of records) {
    pushToBucket(out, r.updatedAt.nodeId, { kind: "record", record: r });
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
  return item.kind === "record"
    ? manifestForRecord(item.record)
    : manifestForAppRow(item.entry);
}

function manifestForRecord(record: AnyRecord): FileSyncManifest | null {
  if (!record.objectStorageKey || record.deletedAt) return null;
  return {
    fileHash: record.contentHash || record.objectStorageKey,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    mimeType: record.mimeType,
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
