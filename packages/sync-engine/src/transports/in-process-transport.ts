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
  RecordChangeLogEntry,
  AppSyncableRowLogEntry,
  RejectedChange,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
} from "../types.js";
import { decidePushAccept } from "../conflict-resolver.js";

export interface InProcessTransportOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly clock: HLCClock;
  /**
   * When provided, the transport also handles `appSyncableRow` entries:
   * - pushChanges: dispatches app-row entries to the applier (LWW UPSERT)
   * - pullChanges: synthesizes app-row entries by scanning all app-syncable
   *   tables for rows whose `updated_at` HLC is after the cursor
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
 * requested cursor and returns them as change-log entries.
 * Push: for each incoming change, applies the OCC rule via decidePushAccept.
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
        for (const ns of namespaces) {
          for (const tableInfo of ns.tables) {
            const appRows = await queryAppSyncableRows(
              appSyncableSource,
              ns.appId,
              tableInfo.name,
              sinceStr,
            );
            for (const appRow of appRows) {
              changes.push(appRow);
              latest = maxHLC(latest, appRow.timestamp);
              if (changes.length >= request.limit) break;
            }
            if (changes.length >= request.limit) break;
          }
          if (changes.length >= request.limit) break;
        }
      }

      return {
        changes,
        latestTimestamp: latest,
        hasMore: changes.length >= request.limit && result.hasMore,
      };
    },

    async pushChanges(request: SyncPushRequest): Promise<SyncPushResponse> {
      const accepted: string[] = [];
      const rejected: RejectedChange[] = [];
      let latest: HLCTimestamp = { wallTime: 0, counter: 0, nodeId: "" };

      for (const change of request.changes) {
        if (change.kind === "appSyncableRow") {
          if (appSyncableSource) {
            // Permission gate: reject if app is not installed on this side.
            const ns = appSyncableSource.namespaces.get(change.appId);
            if (!ns) {
              console.warn(
                `[sync] push: appSyncableRow rejected — app "${change.appId}" not installed on this instance`,
              );
              continue;
            }
            await appSyncableSource.applier.apply(change);
            accepted.push(change.changeId);
            latest = maxHLC(latest, change.timestamp);
          } else {
            console.warn(
              `[sync] push: appSyncableRow entry for app "${change.appId}" ignored — no appSyncableSource configured`,
            );
          }
          continue;
        }

        // kind === "record"
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

      // Advance clock to account for the updates we just applied.
      for (const change of request.changes) {
        clock.receive(change.timestamp);
      }

      return {
        accepted: accepted as SyncPushResponse["accepted"],
        rejected,
        latestTimestamp: latest,
      };
    },
  };
}

function recordToChangeLogEntry(record: AnyRecord): RecordChangeLogEntry {
  return {
    kind: "record",
    changeId: record.id,
    recordId: record.id,
    operation: record.deletedAt ? "delete" : "update",
    timestamp: record.updatedAt,
    recordSnapshot: record,
    baseVersion: record.version > 1 ? record.version - 1 : null,
  };
}

/**
 * Query rows in `app_<appId>.<table>` (cloud) or `<appId>_syncable_<table>`
 * (local) that have `updated_at > sinceStr`. Returns synthesized
 * AppSyncableRowLogEntry values so the pull caller can apply them.
 *
 * This function is a best-effort scan: if the table doesn't exist on this
 * side, it returns an empty array. The `appSyncableSource` must be capable of
 * executing raw SQL against the app-specific tables (via `applier`'s engine).
 *
 * Note: We rely on the applier having a `queryRows` capability via a companion
 * store. For now, this is wired through the applier's own `scan` method when
 * available, or skipped if not.
 */
async function queryAppSyncableRows(
  source: NonNullable<InProcessTransportOptions["appSyncableSource"]>,
  appId: string,
  table: string,
  sinceHlcStr: string,
): Promise<AppSyncableRowLogEntry[]> {
  if (typeof (source.applier as ScanCapableApplier).scanSince !== "function") {
    return [];
  }
  return (source.applier as ScanCapableApplier).scanSince(appId, table, sinceHlcStr);
}

/** Optional capability that appliers can implement to support pull synthesis. */
export interface ScanCapableApplier extends AppSyncableApplier {
  scanSince(
    appId: string,
    table: string,
    sinceHlcStr: string,
  ): Promise<AppSyncableRowLogEntry[]>;
}
