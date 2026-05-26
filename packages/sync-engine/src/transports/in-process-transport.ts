import {
  compareHLC,
  maxHLC,
  serializeHLC,
  SyncStatus,
  type AnyRecord,
  type HLCClock,
  type HLCTimestamp,
} from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
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
  /**
   * Object storage backing the records this transport serves. When provided,
   * pull lazily flips PendingFileDownload records whose blob has landed to
   * Synced, and push writes incoming records as PendingFileDownload (or Synced
   * if the blob is already present).
   */
  readonly objectStorage?: ObjectStorageAdapter;
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
  const { databaseAdapter, clock, appSyncableSource, objectStorage } = options;

  return {
    async pullChanges(request: SyncPullRequest): Promise<SyncPullResponse> {
      const result = await databaseAdapter.query({
        limit: Math.max(request.limit, 1000),
      });

      const changes: ChangeLogEntry[] = [];
      const appSyncableRows: AppSyncableRowEntry[] = [];
      let latest: HLCTimestamp = request.sinceTimestamp;

      for (const candidate of result.records) {
        if (compareHLC(candidate.updatedAt, request.sinceTimestamp) <= 0) continue;
        let record = candidate;
        // Server-side state machine is only enforced when the transport owns
        // the object storage. Without it (some test setups), the transport
        // can't observe blob presence, so it preserves the snapshot as-is.
        if (objectStorage) {
          if (
            record.syncStatus === SyncStatus.PendingFileDownload &&
            record.objectStorageKey
          ) {
            if (await objectStorage.has(record.objectStorageKey)) {
              record = { ...record, syncStatus: SyncStatus.Synced };
              await databaseAdapter.put(record);
            }
          }
          // Only expose records whose blob is durably here.
          if (record.syncStatus !== SyncStatus.Synced) continue;
        }
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

        if (decision.kind === "accept" || decision.kind === "accept-noop") {
          if (decision.kind === "accept") {
            if (change.operation === "delete") {
              await databaseAdapter.delete(change.recordId);
            } else if (objectStorage) {
              // Server-side state machine: write as PendingFileDownload until
              // the blob lands. If the blob is already on the server (re-push
              // after a successful upload), short-circuit to Synced.
              const snapshot = change.recordSnapshot;
              const needsBlob = !!snapshot.objectStorageKey;
              let nextStatus = needsBlob
                ? SyncStatus.PendingFileDownload
                : SyncStatus.Synced;
              if (
                needsBlob &&
                (await objectStorage.has(snapshot.objectStorageKey))
              ) {
                nextStatus = SyncStatus.Synced;
              }
              await databaseAdapter.put({ ...snapshot, syncStatus: nextStatus });
            } else {
              // Transport doesn't own object storage; store the snapshot as
              // delivered. Callers manage blob/status correspondence externally.
              await databaseAdapter.put(change.recordSnapshot);
            }
          } else if (
            objectStorage &&
            current &&
            change.operation !== "delete"
          ) {
            // accept-noop: server already holds this exact revision but its
            // sync_status may have drifted from blob reality (e.g. an older
            // server build wrote the client's pending_push verbatim, or a
            // partial upload left the row in PendingFileDownload after the
            // blob finally landed). Reconcile against object storage so the
            // row becomes pullable. Without this, a misrecorded status is
            // permanent — the matching-revision short-circuit means no future
            // push will revisit it.
            const needsBlob = !!current.objectStorageKey;
            let nextStatus = needsBlob
              ? SyncStatus.PendingFileDownload
              : SyncStatus.Synced;
            if (
              needsBlob &&
              (await objectStorage.has(current.objectStorageKey))
            ) {
              nextStatus = SyncStatus.Synced;
            }
            if (current.syncStatus !== nextStatus) {
              await databaseAdapter.put({ ...current, syncStatus: nextStatus });
            }
          }
          // accept-noop: server already has this exact (id, version) — don't
          // re-apply, but acknowledge so the client advances its state machine.
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
