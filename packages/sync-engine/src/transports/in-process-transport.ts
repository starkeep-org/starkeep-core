import {
  compareHLC,
  serializeHLC,
  ZERO_HLC,
  type AnyRecord,
  type HLCClock,
} from "@starkeep/protocol-primitives";
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
  const { databaseAdapter, clock, appSyncableSource, syncSharedRecords = true } = options;

  return {
    async exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse> {
      // 1. Apply incoming records — pure put(snapshot). HLC LWW: skip if local
      //    copy is at-or-ahead of incoming. Only the Drive channel
      //    (syncSharedRecords=true) applies shared records.
      if (syncSharedRecords) {
        for (const snapshot of request.records ?? []) {
          const current = await databaseAdapter.get(snapshot.id);
          if (current && compareHLC(current.updatedAt, snapshot.updatedAt) >= 0) {
            continue;
          }
          clock.receive(snapshot.updatedAt);
          await databaseAdapter.put(snapshot);
        }
      } else if ((request.records?.length ?? 0) > 0) {
        // Per-app channel received shared records — a channel-split violation
        // on the requester side. Drop them (the channel-split guard) but warn
        // so the misbehaving peer is discoverable.
        console.warn(
          `[sync] in-process transport dropped ${request.records?.length ?? 0} shared record(s) on a per-app channel (syncSharedRecords=false)`,
        );
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

      // 3. Scan local records the caller hasn't seen yet, paginated by
      //    cursor so records past any fixed scan window are still reachable.
      //    Collect up to `limit + 1` matches so we can set `hasMore`
      //    correctly without an additional probe. Same performance follow-up
      //    as the outbound scan in sync-engine.ts: production should push
      //    the per-nodeId watermark filter into the query.
      const limit = request.limit ?? 1000;
      const SCAN_PAGE = 500;
      const collected: AnyRecord[] = [];
      let cursor: string | undefined = undefined;
      // Per-app channels (syncSharedRecords=false) never scan or ship shared
      // records.
      let scanHasMore = syncSharedRecords;
      let overflowed = false;
      while (!overflowed && scanHasMore) {
        const page = await databaseAdapter.query({
          limit: SCAN_PAGE,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (page.records.length === 0) break;
        for (const r of page.records) {
          const peerHlc = request.watermarks[r.updatedAt.nodeId];
          if (!peerHlc || compareHLC(r.updatedAt, peerHlc) > 0) {
            if (collected.length >= limit) {
              overflowed = true;
              break;
            }
            collected.push(r);
          }
        }
        if (overflowed) break;
        scanHasMore = page.hasMore;
        cursor = page.nextCursor ?? undefined;
      }
      const records = collected;

      // 4. App-syncable rows: same per-nodeId filtering across known tables,
      //    cursor-paginated for the same reason as the SR scan above —
      //    records past any fixed scan window stay reachable.
      const appSyncableRows: AppSyncableRowEntry[] = [];
      if (appSyncableSource && records.length < limit) {
        const scanCapable = appSyncableSource.applier as ScanCapableApplier;
        if (typeof scanCapable.scanSince === "function") {
          const zeroStr = serializeHLC(ZERO_HLC);
          outer: for (const ns of appSyncableSource.namespaces.list()) {
            for (const tableInfo of ns.tables) {
              let appCursor: string | undefined = undefined;
              let appHasMore = true;
              while (
                records.length + appSyncableRows.length < limit &&
                appHasMore
              ) {
                let page: { rows: AppSyncableRowEntry[]; nextCursor: string | null; hasMore: boolean };
                try {
                  page = await scanCapable.scanSince(
                    ns.appId,
                    tableInfo.name,
                    zeroStr,
                    {
                      limit: SCAN_PAGE,
                      ...(appCursor !== undefined ? { cursor: appCursor } : {}),
                    },
                  );
                } catch (err) {
                  console.warn(
                    `[sync] in-process transport scanSince failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
                  );
                  break;
                }
                if (page.rows.length === 0) break;
                for (const r of page.rows) {
                  const peerHlc = request.watermarks[r.timestamp.nodeId];
                  if (!peerHlc || compareHLC(r.timestamp, peerHlc) > 0) {
                    appSyncableRows.push(r);
                    if (records.length + appSyncableRows.length >= limit) break;
                  }
                }
                appHasMore = page.hasMore;
                appCursor = page.nextCursor ?? undefined;
              }
              if (records.length + appSyncableRows.length >= limit) break outer;
            }
          }
        }
      }

      // hasMore reflects: (a) the SR scan overflowed past `limit`, or
      // (b) the combined SR + app-syncable payload hit `limit` and there
      // are still untraversed app rows. (a) is captured by `overflowed`;
      // (b) is approximated by the app-syncable collection loop breaking
      // out early — i.e. records.length + appSyncableRows.length >= limit.
      const hasMore =
        overflowed ||
        records.length + appSyncableRows.length >= limit;

      return { records, appSyncableRows, hasMore };
    },
  };
}
