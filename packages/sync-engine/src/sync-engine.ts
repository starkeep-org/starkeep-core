import {
  compareHLC,
  serializeHLC,
  ZERO_HLC,
  type AnyRecord,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/core";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
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
      // Outbound: ship records (and their blobs) the peer hasn't seen.
      // ---------------------------------------------------------------------
      //
      // App-layer per-nodeId filter over a chunked scan — sufficient at
      // current poll volumes; per-nodeId SQL indexes are a follow-up if
      // scans get hot. Same caveat applies to the responder-side scan in
      // in-process-transport.ts.
      const localScan = await localDatabaseAdapter.query({ limit: 2000 });
      const outboundCandidates = selectUnseen(localScan.records, peerWatermarks);

      // Strict per-nodeId contiguous-prefix shipping: as soon as a blob
      // upload fails for a record, stop shipping later-HLC records for that
      // same nodeId in this round. Otherwise we'd create a gap in the peer
      // (peer has r0 + r2 but not r1) — and any third client pulling from
      // the peer would advance its own watermark past r2, never receiving
      // r1 when it finally lands. Retry happens automatically next round.
      const candidatesByNode = groupByNodeId(outboundCandidates);
      const outboundRecords: AnyRecord[] = [];
      const peerSafeAdvance = new Map<string, HLCTimestamp>();

      for (const [nodeId, records] of candidatesByNode) {
        for (const r of records) {
          const blobOk = await pushBlobIfNeeded(
            r,
            localObjectStorage,
            remoteObjectStorage,
            fileSyncEngine,
          );
          if (!blobOk) break;
          outboundRecords.push(r);
          peerSafeAdvance.set(nodeId, r.updatedAt);
        }
      }

      // Outbound app-syncable rows. Same per-nodeId contiguous rule. These
      // rows don't carry their own blobs at the protocol level — file blobs
      // for reserved file-records ride the regular records path above.
      const outboundAppRows: AppSyncableRowEntry[] = [];
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
                outboundAppRows.push(r);
                // App-syncable rows have no per-row failure case at this
                // layer, so they always contribute to peerSafeAdvance.
                const existing = peerSafeAdvance.get(r.timestamp.nodeId);
                if (!existing || compareHLC(r.timestamp, existing) > 0) {
                  peerSafeAdvance.set(r.timestamp.nodeId, r.timestamp);
                }
              }
            } catch (err) {
              console.warn(
                `[sync] exchange scanSince failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
              );
            }
          }
        }
      }

      const response = await transport.exchange({
        watermarks: ownWatermarks,
        records: outboundRecords.length > 0 ? outboundRecords : undefined,
        appSyncableRows: outboundAppRows.length > 0 ? outboundAppRows : undefined,
        limit: 1000,
      });

      // ---------------------------------------------------------------------
      // Inbound: apply records (and pull their blobs) per nodeId in HLC order.
      // Own watermark advances only past records that fully landed locally;
      // peerWatermarks also advances past *every* record we received — the
      // peer demonstrated it has them by shipping them — which prevents us
      // re-shipping records that originated on the peer's side.
      // ---------------------------------------------------------------------
      const inboundByNode = groupByNodeId(response.records);
      const appliedIds: StarkeepId[] = [];
      const ownSafeAdvance = new Map<string, HLCTimestamp>();

      for (const [nodeId, records] of inboundByNode) {
        let contiguous = true;
        for (const snapshot of records) {
          // The peer has this snapshot (it sent it to us) — peerWatermarks
          // can advance past it regardless of our local blob fetch outcome.
          const existing = peerSafeAdvance.get(nodeId);
          if (!existing || compareHLC(snapshot.updatedAt, existing) > 0) {
            peerSafeAdvance.set(nodeId, snapshot.updatedAt);
          }

          const current = await localDatabaseAdapter.get(snapshot.id);
          if (current && compareHLC(current.updatedAt, snapshot.updatedAt) >= 0) {
            // Already at-or-ahead locally — counts as "landed" for watermark
            // purposes, so still contiguous.
            if (contiguous) ownSafeAdvance.set(nodeId, snapshot.updatedAt);
            continue;
          }
          clock.receive(snapshot.updatedAt);
          await localDatabaseAdapter.put(snapshot);

          const blobOk = await pullBlobIfNeeded(
            snapshot,
            remoteObjectStorage,
            localObjectStorage,
            fileSyncEngine,
          );
          if (!blobOk) {
            // Metadata applied, but blob fetch failed. Don't advance own
            // watermark past this record — next round the responder still
            // ships it (because our advertised watermarks haven't moved past
            // it) and we'll retry the blob.
            contiguous = false;
            continue;
          }

          appliedIds.push(snapshot.id);
          if (contiguous) ownSafeAdvance.set(nodeId, snapshot.updatedAt);
        }
      }

      // Apply incoming app-syncable rows. No per-row blob handling at this
      // layer; the applier is LWW. Advance own watermark for each.
      if (response.appSyncableRows.length > 0 && appSyncableSource) {
        for (const entry of response.appSyncableRows) {
          clock.receive(entry.timestamp);
          try {
            await appSyncableSource.applier.apply(entry);
            const existing = ownSafeAdvance.get(entry.timestamp.nodeId);
            if (!existing || compareHLC(entry.timestamp, existing) > 0) {
              ownSafeAdvance.set(entry.timestamp.nodeId, entry.timestamp);
            }
          } catch (err) {
            console.warn(
              `[sync] appSyncableRow apply failed (app=${entry.appId} table=${entry.table}): ${(err as Error).message}`,
            );
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

/**
 * Group records by their `updatedAt.nodeId` and sort each bucket in HLC order.
 * Per-nodeId ordering is what makes the contiguous-prefix watermark rule work.
 */
function groupByNodeId(records: AnyRecord[]): Map<string, AnyRecord[]> {
  const out = new Map<string, AnyRecord[]>();
  for (const r of records) {
    const arr = out.get(r.updatedAt.nodeId) ?? [];
    arr.push(r);
    out.set(r.updatedAt.nodeId, arr);
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => compareHLC(a.updatedAt, b.updatedAt));
  }
  return out;
}

/**
 * If the record carries a blob, ensure it's at the destination. Returns true
 * if there's nothing to push (no blob, or tombstone) or the transfer
 * succeeded; false if the source is missing the blob entirely (no metadata
 * push allowed in that case — we'd be advertising metadata for a blob the
 * peer can never fetch).
 *
 * `transferFile` short-circuits to true if destination already has the key,
 * so calling this repeatedly across exchange ticks costs at most one HEAD
 * per record per tick — and only for records that are in the outbound delta.
 */
async function pushBlobIfNeeded(
  record: AnyRecord,
  source: ObjectStorageAdapter,
  destination: ObjectStorageAdapter,
  fileSyncEngine: FileSyncEngine,
): Promise<boolean> {
  if (!record.objectStorageKey || record.deletedAt) return true;
  const manifest: FileSyncManifest = {
    fileHash: record.contentHash || record.objectStorageKey,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    mimeType: record.mimeType,
  };
  try {
    return await fileSyncEngine.transferFile(manifest, source, destination);
  } catch (err) {
    console.warn(
      `[sync] blob upload failed for ${record.id} (${record.objectStorageKey}): ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * If the incoming record carries a blob, pull it from `source` (remote) to
 * `destination` (local). Same short-circuit semantics as the push path.
 */
async function pullBlobIfNeeded(
  record: AnyRecord,
  source: ObjectStorageAdapter,
  destination: ObjectStorageAdapter,
  fileSyncEngine: FileSyncEngine,
): Promise<boolean> {
  if (!record.objectStorageKey || record.deletedAt) return true;
  const manifest: FileSyncManifest = {
    fileHash: record.contentHash || record.objectStorageKey,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    mimeType: record.mimeType,
  };
  try {
    return await fileSyncEngine.transferFile(manifest, source, destination);
  } catch (err) {
    console.warn(
      `[sync] blob download failed for ${record.id} (${record.objectStorageKey}): ${(err as Error).message}`,
    );
    return false;
  }
}
