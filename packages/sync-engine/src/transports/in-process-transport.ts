import {
  compareHLC,
  serializeHLC,
  ZERO_HLC,
  type HLCClock,
} from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type {
  SyncTransport,
  SyncExchangeRequest,
  SyncExchangeResponse,
  AppSyncableRowEntry,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  ScanCapableApplier,
} from "../types.js";
import {
  selectUnseen,
  selectUnseenAppSyncable,
} from "../watermarks.js";

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
export function createInProcessSyncTransport(
  options: InProcessTransportOptions,
): SyncTransport {
  const { databaseAdapter, clock, appSyncableSource } = options;

  return {
    async exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
      // 1. Apply incoming records — pure put(snapshot). HLC LWW: skip if local
      //    copy is at-or-ahead of incoming.
      for (const snapshot of request.records ?? []) {
        const current = await databaseAdapter.get(snapshot.id);
        if (current && compareHLC(current.updatedAt, snapshot.updatedAt) >= 0) {
          continue;
        }
        clock.receive(snapshot.updatedAt);
        await databaseAdapter.put(snapshot);
      }

      // 2. Apply incoming app-syncable rows.
      for (const entry of request.appSyncableRows ?? []) {
        if (!appSyncableSource) continue;
        const ns = appSyncableSource.namespaces.get(entry.appId);
        if (!ns) continue;
        clock.receive(entry.timestamp);
        try {
          await appSyncableSource.applier.apply(entry);
        } catch (err) {
          console.warn(
            `[sync] exchange apply appSyncableRow failed (app=${entry.appId} table=${entry.table}): ${(err as Error).message}`,
          );
        }
      }

      // 3. Scan local records the caller hasn't seen yet. App-layer filter
      //    over a chunked scan — sufficient at current poll volumes;
      //    per-nodeId SQL indexes are a follow-up if scans get hot.
      const limit = request.limit ?? 1000;
      const scanResult = await databaseAdapter.query({ limit: limit * 2 });
      const candidates = selectUnseen(scanResult.records, request.watermarks);
      const records = candidates.slice(0, limit);

      // 4. App-syncable rows: same per-nodeId filtering across known tables.
      const appSyncableRows: AppSyncableRowEntry[] = [];
      if (appSyncableSource && records.length < limit) {
        const scanCapable = appSyncableSource.applier as ScanCapableApplier;
        if (typeof scanCapable.scanSince === "function") {
          const zeroStr = serializeHLC(ZERO_HLC);
          for (const ns of appSyncableSource.namespaces.list()) {
            for (const tableInfo of ns.tables) {
              let rows: AppSyncableRowEntry[];
              try {
                rows = await scanCapable.scanSince(ns.appId, tableInfo.name, zeroStr);
              } catch {
                rows = [];
              }
              const unseen = selectUnseenAppSyncable(rows, request.watermarks);
              for (const r of unseen) {
                appSyncableRows.push(r);
                if (records.length + appSyncableRows.length >= limit) break;
              }
              if (records.length + appSyncableRows.length >= limit) break;
            }
            if (records.length + appSyncableRows.length >= limit) break;
          }
        }
      }

      const hasMore = candidates.length > limit || scanResult.hasMore;

      return { records, appSyncableRows, hasMore };
    },
  };
}
