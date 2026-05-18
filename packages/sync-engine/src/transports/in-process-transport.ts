import {
  compareHLC,
  maxHLC,
  serializeHLC,
  type AnyRecord,
  type HLCClock,
  type HLCTimestamp,
} from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type {
  SyncTransport,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  ChangeLogEntry,
  AppSyncableRowEntry,
  RejectedChange,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  ScanCapableApplier,
} from "../types.js";
import { decidePushAccept } from "../conflict-resolver.js";

export interface InProcessTransportOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly clock: HLCClock;
  /**
   * When provided, the transport synthesizes app-syncable row entries on pull
   * (by scanning updated_at per table) and applies them on push (LWW UPSERT).
   */
  readonly appSyncableSource?: {
    readonly namespaces: AppSyncableNamespaceStore;
    readonly applier: AppSyncableApplier;
  };
}

/**
 * `SyncTransport` that talks directly to an in-process database adapter.
 * Used for tests and for running a "cloud" side in the same Node process.
 *
 * Pull: queries the adapter for records whose `updatedAt` is after the
 * requested cursor and returns them as change-log entries. App-syncable rows
 * are returned in a separate `appSyncableRows` field.
 * Push: for each incoming change, applies the OCC rule via decidePushAccept.
 * App-syncable rows in `appSyncableRows` are applied with LWW.
 */
export function createInProcessSyncTransport(
  options: InProcessTransportOptions,
): SyncTransport {
  const { databaseAdapter, clock, appSyncableSource } = options;

  return {
    async pullChanges(request: SyncPullRequest): Promise<SyncPullResponse> {
      const result = await databaseAdapter.query({
        limit: Math.max(request.limit, 1000),
      });

      const changes: ChangeLogEntry[] = [];
      const appSyncableRows: AppSyncableRowEntry[] = [];
      let latest: HLCTimestamp = request.sinceTimestamp;

      for (const record of result.records) {
        if (compareHLC(record.updatedAt, request.sinceTimestamp) <= 0) continue;
        changes.push(recordToChangeLogEntry(record));
        latest = maxHLC(latest, record.updatedAt);
        if (changes.length >= request.limit) break;
      }

      // Synthesize appSyncableRow entries from per-table scans.
      if (appSyncableSource && changes.length < request.limit) {
        const namespaces = appSyncableSource.namespaces.list();
        const sinceStr = serializeHLC(request.sinceTimestamp);
        const scanCapable = appSyncableSource.applier as ScanCapableApplier;
        if (typeof scanCapable.scanSince === "function") {
          for (const ns of namespaces) {
            for (const tableInfo of ns.tables) {
              const rows = await scanCapable.scanSince(ns.appId, tableInfo.name, sinceStr);
              for (const row of rows) {
                appSyncableRows.push(row);
                latest = maxHLC(latest, row.timestamp);
                if (changes.length + appSyncableRows.length >= request.limit) break;
              }
              if (changes.length + appSyncableRows.length >= request.limit) break;
            }
            if (changes.length + appSyncableRows.length >= request.limit) break;
          }
        }
      }

      return {
        changes,
        appSyncableRows,
        latestTimestamp: latest,
        hasMore: changes.length >= request.limit && result.hasMore,
      };
    },

    async pushChanges(request: SyncPushRequest): Promise<SyncPushResponse> {
      const accepted: string[] = [];
      const rejected: RejectedChange[] = [];
      let latest: HLCTimestamp = { wallTime: 0, counter: 0, nodeId: "" };

      // Record changes: apply OCC.
      for (const change of request.changes) {
        const current = await databaseAdapter.get(change.recordId);
        const decision = decidePushAccept(current, change);

        if (decision.kind === "accept") {
          if (change.operation === "delete") {
            await databaseAdapter.delete(change.recordId);
          } else {
            await databaseAdapter.put(change.recordSnapshot);
          }
          accepted.push(change.recordId);
          latest = maxHLC(latest, change.timestamp);
        } else {
          rejected.push({
            recordId: change.recordId,
            clientChange: change,
            serverRecord: current,
            reason:
              decision.kind === "reject-not-found"
                ? "not-found"
                : decision.kind === "reject-deleted"
                  ? "deleted"
                  : "version-mismatch",
          });
        }
      }

      // App-syncable rows: apply LWW with permission gate.
      for (const entry of request.appSyncableRows ?? []) {
        if (!appSyncableSource) {
          console.warn(
            `[sync] push: appSyncableRow entry for app "${entry.appId}" ignored — no appSyncableSource configured`,
          );
          continue;
        }
        const ns = appSyncableSource.namespaces.get(entry.appId);
        if (!ns) {
          console.warn(
            `[sync] push: appSyncableRow rejected — app "${entry.appId}" not installed on this instance`,
          );
          continue;
        }
        await appSyncableSource.applier.apply(entry);
        latest = maxHLC(latest, entry.timestamp);
      }

      // Advance clock to account for the updates we just applied.
      for (const change of request.changes) {
        clock.receive(change.timestamp);
      }
      for (const entry of request.appSyncableRows ?? []) {
        clock.receive(entry.timestamp);
      }

      return {
        accepted: accepted as SyncPushResponse["accepted"],
        rejected,
        latestTimestamp: latest,
      };
    },
  };
}

function recordToChangeLogEntry(record: AnyRecord): ChangeLogEntry {
  return {
    changeId: record.id,
    recordId: record.id,
    operation: record.deletedAt ? "delete" : "update",
    timestamp: record.updatedAt,
    recordSnapshot: record,
    baseVersion: record.version > 1 ? record.version - 1 : null,
  };
}
