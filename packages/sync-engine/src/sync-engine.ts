import {
  compareHLC,
  maxHLC,
  serializeHLC,
  SyncStatus,
  type StarkeepId,
  type AnyRecord,
  type HLCTimestamp,
} from "@starkeep/core";
import type {
  SyncEngine,
  SyncEngineOptions,
  SyncPullResponse,
  SyncPushResponse,
  ChangeLogEntry,
  SyncConflict,
  RecordChangeOptions,
} from "./types.js";
import { createChangeLog } from "./change-log.js";
import { createChangeNotifier } from "./change-notifier.js";
import { createFileSyncEngine } from "./file-sync-engine.js";
import { decidePullApply } from "./conflict-resolver.js";
import {
  countNonTerminal,
  logNonTerminalCounts,
  logTransition,
} from "./observability.js";

const ZERO_HLC: HLCTimestamp = { wallTime: 0, counter: 0, nodeId: "" };

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const {
    localDatabaseAdapter,
    localObjectStorage,
    remoteObjectStorage,
    transport,
    clock,
    changeLog = createChangeLog(),
    syncState,
    appSyncableSource,
  } = options;

  const changeNotifier = createChangeNotifier();
  const fileSyncEngine = createFileSyncEngine();

  // In-memory conflict cache. Each entry means the local record has unsynced
  // edits that collide with the server's version. The app must resolve
  // before sync continues on this record.
  const conflicts = new Map<StarkeepId, SyncConflict>();

  // Cursors are lazy-loaded from syncState on first use.
  let pullCursor: HLCTimestamp | null = null;
  let pushCursor: HLCTimestamp | null = null;
  let cursorsLoaded = false;

  async function loadCursors(): Promise<void> {
    if (cursorsLoaded) return;
    if (syncState) {
      pullCursor = await syncState.getPullCursor();
      pushCursor = await syncState.getPushCursor();
    }
    cursorsLoaded = true;
  }

  async function savePullCursor(ts: HLCTimestamp): Promise<void> {
    pullCursor = ts;
    if (syncState) await syncState.setPullCursor(ts);
  }

  async function savePushCursor(ts: HLCTimestamp): Promise<void> {
    pushCursor = ts;
    if (syncState) await syncState.setPushCursor(ts);
  }

  function markConflict(
    recordId: StarkeepId,
    local: AnyRecord,
    server: AnyRecord | null,
    source: "pull" | "push",
  ): void {
    conflicts.set(recordId, {
      recordId,
      local,
      server,
      source,
      detectedAt: clock.now(),
    });
  }

  async function markRecordConflictStatus(
    record: AnyRecord,
  ): Promise<void> {
    const updated = { ...record, syncStatus: SyncStatus.Conflict };
    await localDatabaseAdapter.put(updated);
    logTransition("client", record.id, record.syncStatus, SyncStatus.Conflict, "conflict-detected");
  }

  return {
    async recordChange(
      operation: "create" | "update" | "delete",
      record: AnyRecord,
      changeOptions: RecordChangeOptions = {},
    ): Promise<void> {
      const baseVersion =
        operation === "create"
          ? null
          : changeOptions.baseVersion ?? record.version - 1;

      const ts = clock.now();
      await changeLog.append({
        recordId: record.id,
        operation,
        timestamp: ts,
        recordSnapshot: record,
        baseVersion,
      });
      changeNotifier.emit({
        eventType: "local-change-recorded",
        recordIds: [record.id],
        timestamp: ts,
      });
    },

    async pull(): Promise<SyncPullResponse> {
      await loadCursors();
      const since = pullCursor ?? ZERO_HLC;

      const response = await transport.pullChanges({
        sinceTimestamp: since,
        limit: 1000,
      });

      const conflictIds: StarkeepId[] = [];
      const appliedIds: StarkeepId[] = [];

      // Fetch local unsynced record changes in bulk so dirty-conflict detection
      // is O(1) per remote record change.
      const localUnsyncedBoundary = pushCursor ?? ZERO_HLC;
      const localUnsynced = await changeLog.getChangesSince(
        localUnsyncedBoundary,
      );
      const localUnsyncedByRecord = new Map<StarkeepId, ChangeLogEntry>();
      for (const entry of localUnsynced) {
        localUnsyncedByRecord.set(entry.recordId, entry);
      }

      for (const remoteChange of response.changes) {
        // Keep our HLC causally ahead of anything we observe.
        clock.receive(remoteChange.timestamp);

        const localRecord = await localDatabaseAdapter.get(
          remoteChange.recordId,
        );

        const decision = decidePullApply(
          localRecord,
          remoteChange,
          localUnsyncedByRecord.get(remoteChange.recordId),
        );

        if (decision.kind === "local-dirty-conflict") {
          if (localRecord) {
            markConflict(
              remoteChange.recordId,
              localRecord,
              remoteChange.recordSnapshot,
              "pull",
            );
            await markRecordConflictStatus(localRecord);
            conflictIds.push(remoteChange.recordId);
          }
          continue;
        }

        if (decision.kind === "skip-already-current") {
          continue;
        }

        // apply-clean
        if (remoteChange.operation === "delete") {
          await localDatabaseAdapter.delete(remoteChange.recordId);
          logTransition(
            "client",
            remoteChange.recordId,
            localRecord?.syncStatus ?? null,
            SyncStatus.Synced,
            "pull-apply-delete",
          );
        } else {
          // Receiver: if the record carries a blob, mark PendingFileDownload —
          // the file retry pass will fetch the blob and flip to Synced. Records
          // without a blob go straight to Synced.
          const snapshot = remoteChange.recordSnapshot;
          const needsBlob = !!snapshot.objectStorageKey;
          const nextStatus = needsBlob
            ? SyncStatus.PendingFileDownload
            : SyncStatus.Synced;
          await localDatabaseAdapter.put({ ...snapshot, syncStatus: nextStatus });
          logTransition(
            "client",
            remoteChange.recordId,
            localRecord?.syncStatus ?? null,
            nextStatus,
            "pull-apply",
          );
        }
        appliedIds.push(remoteChange.recordId);
      }

      // Apply incoming app-syncable rows (LWW, no OCC).
      if (response.appSyncableRows.length > 0) {
        if (appSyncableSource) {
          for (const entry of response.appSyncableRows) {
            clock.receive(entry.timestamp);
            try {
              await appSyncableSource.applier.apply(entry);
            } catch (err) {
              console.warn(
                `[sync] appSyncableRow apply failed (app=${entry.appId} table=${entry.table}): ${(err as Error).message}`,
              );
            }
          }
        } else {
          console.warn("[sync] appSyncableRows received but no appSyncableSource configured — skipping");
        }
      }

      await savePullCursor(response.latestTimestamp);

      // Sweep PendingFileDownload / PendingFileUpload — including records just
      // applied this pull and any that have been waiting from prior ticks.
      try {
        await this.runFileTransferPass();
      } catch (err) {
        console.warn(`[sync] file-transfer pass failed: ${(err as Error).message}`);
      }

      if (appliedIds.length > 0) {
        changeNotifier.emit({
          eventType: "local-data-synced",
          recordIds: appliedIds,
          timestamp: clock.now(),
        });
      }
      if (conflictIds.length > 0) {
        changeNotifier.emit({
          eventType: "conflict-detected",
          recordIds: conflictIds,
          timestamp: clock.now(),
        });
      }

      return response;
    },

    async push(): Promise<SyncPushResponse> {
      await loadCursors();
      const since = pushCursor ?? ZERO_HLC;

      const localChanges = await changeLog.getChangesSince(since);

      // Skip records already known to be in conflict — they need manual
      // resolution before we push anything new for them.
      const pushable = localChanges.filter(
        (change) => !conflicts.has(change.recordId),
      );

      // Scan app-syncable tables for rows updated since the push cursor.
      const appSyncableRows: import("./types.js").AppSyncableRowEntry[] = [];
      if (appSyncableSource) {
        const sinceStr = serializeHLC(since);
        for (const ns of appSyncableSource.namespaces.list()) {
          for (const tableInfo of ns.tables) {
            try {
              const rows = await appSyncableSource.applier.scanSince(
                ns.appId,
                tableInfo.name,
                sinceStr,
              );
              for (const row of rows) appSyncableRows.push(row);
            } catch (err) {
              console.warn(
                `[sync] push: scanSince failed for ${ns.appId}.${tableInfo.name}: ${(err as Error).message}`,
              );
            }
          }
        }
      }

      if (pushable.length === 0 && appSyncableRows.length === 0) {
        return {
          accepted: [],
          rejected: [],
          latestTimestamp: since,
        };
      }

      // Metadata first. The blob upload happens in the file-transfer pass
      // after the server has durably acknowledged the metadata — that's the
      // PendingPush → PendingFileUpload → Synced state machine.
      const response = await transport.pushChanges({
        changes: pushable,
        appSyncableRows: appSyncableRows.length > 0 ? appSyncableRows : undefined,
      });

      // Accepted: move records carrying a blob into PendingFileUpload so the
      // file-transfer pass picks them up. Records without a blob skip straight
      // to Synced.
      const acceptedSet = new Set(response.accepted);
      for (const change of pushable) {
        if (acceptedSet.has(change.recordId)) {
          const localRecord = await localDatabaseAdapter.get(change.recordId);
          if (
            localRecord &&
            localRecord.version === change.recordSnapshot.version
          ) {
            const needsBlob = !!localRecord.objectStorageKey;
            const nextStatus = needsBlob
              ? SyncStatus.PendingFileUpload
              : SyncStatus.Synced;
            await localDatabaseAdapter.put({ ...localRecord, syncStatus: nextStatus });
            logTransition(
              "client",
              change.recordId,
              localRecord.syncStatus,
              nextStatus,
              "push-accepted",
            );
          }
        }
      }

      // Rejected: mark as Conflict, stash server version.
      const conflictIds: StarkeepId[] = [];
      for (const rejection of response.rejected) {
        const localRecord = await localDatabaseAdapter.get(rejection.recordId);
        if (!localRecord) continue;
        markConflict(
          rejection.recordId,
          localRecord,
          rejection.serverRecord,
          "push",
        );
        await markRecordConflictStatus(localRecord);
        conflictIds.push(rejection.recordId);
      }

      if (conflictIds.length > 0) {
        changeNotifier.emit({
          eventType: "conflict-detected",
          recordIds: conflictIds,
          timestamp: clock.now(),
        });
      }

      // Advance push cursor to max timestamp across both records and app rows.
      const recordsMax = pushable.reduce(
        (acc, entry) => maxHLC(acc, entry.timestamp),
        since,
      );
      const appRowsMax = appSyncableRows.reduce(
        (acc, entry) => maxHLC(acc, entry.timestamp),
        since,
      );
      const maxTimestamp = maxHLC(recordsMax, appRowsMax);
      if (compareHLC(maxTimestamp, since) > 0) {
        await savePushCursor(maxTimestamp);
      }

      // Sweep blobs the sender owes (PendingFileUpload), plus any pending
      // downloads still owed from prior pulls.
      try {
        await this.runFileTransferPass();
      } catch (err) {
        console.warn(`[sync] file-transfer pass failed: ${(err as Error).message}`);
      }

      return response;
    },

    async runFileTransferPass(): Promise<{
      uploaded: number;
      downloaded: number;
      failed: number;
    }> {
      let uploaded = 0;
      let downloaded = 0;
      let failed = 0;

      // Records the sender owes to the server: upload blob, then mark Synced.
      const uploadResult = await localDatabaseAdapter.query({
        filters: [
          { field: "syncStatus", operator: "eq", value: SyncStatus.PendingFileUpload },
        ],
        limit: 1000,
      });
      for (const record of uploadResult.records) {
        if (!record.objectStorageKey) {
          // No blob to upload — should not normally happen in this state.
          await localDatabaseAdapter.put({ ...record, syncStatus: SyncStatus.Synced });
          logTransition("client", record.id, record.syncStatus, SyncStatus.Synced, "upload-skipped-no-key");
          continue;
        }
        if (fileSyncEngine.isTransferInFlight(record.objectStorageKey)) {
          continue;
        }
        try {
          const ok = await fileSyncEngine.transferFile(
            {
              fileHash: record.objectStorageKey,
              objectStorageKey: record.objectStorageKey,
              sizeBytes: record.sizeBytes,
              mimeType: record.mimeType ?? undefined,
            },
            localObjectStorage,
            remoteObjectStorage,
          );
          if (ok) {
            await localDatabaseAdapter.put({ ...record, syncStatus: SyncStatus.Synced });
            logTransition("client", record.id, record.syncStatus, SyncStatus.Synced, "upload-complete");
            uploaded += 1;
          }
        } catch (err) {
          console.warn(
            `[sync] upload failed for ${record.objectStorageKey}: ${(err as Error).message}`,
          );
          failed += 1;
        }
      }

      // Records the receiver still needs the blob for: download then mark Synced.
      const downloadResult = await localDatabaseAdapter.query({
        filters: [
          { field: "syncStatus", operator: "eq", value: SyncStatus.PendingFileDownload },
        ],
        limit: 1000,
      });
      for (const record of downloadResult.records) {
        if (!record.objectStorageKey) {
          await localDatabaseAdapter.put({ ...record, syncStatus: SyncStatus.Synced });
          logTransition("client", record.id, record.syncStatus, SyncStatus.Synced, "download-skipped-no-key");
          continue;
        }
        if (fileSyncEngine.isTransferInFlight(record.objectStorageKey)) {
          continue;
        }
        try {
          // Short-circuit if the file is already present locally.
          if (await localObjectStorage.has(record.objectStorageKey)) {
            await localDatabaseAdapter.put({ ...record, syncStatus: SyncStatus.Synced });
            logTransition("client", record.id, record.syncStatus, SyncStatus.Synced, "download-already-local");
            downloaded += 1;
            continue;
          }
          const ok = await fileSyncEngine.transferFile(
            {
              fileHash: record.objectStorageKey,
              objectStorageKey: record.objectStorageKey,
              sizeBytes: record.sizeBytes,
              mimeType: record.mimeType ?? undefined,
            },
            remoteObjectStorage,
            localObjectStorage,
          );
          if (ok) {
            await localDatabaseAdapter.put({ ...record, syncStatus: SyncStatus.Synced });
            logTransition("client", record.id, record.syncStatus, SyncStatus.Synced, "download-complete");
            downloaded += 1;
          }
        } catch (err) {
          console.warn(
            `[sync] download failed for ${record.objectStorageKey}: ${(err as Error).message}`,
          );
          failed += 1;
        }
      }

      // Reserved-table file records for filesEnabled apps. Same state machine
      // as shared_records, scoped by the per-app `_starkeep_sync_records`
      // table the framework manages. Decision driver is blob location, not
      // the stored sync_status (which can be stale from the producer's view).
      if (appSyncableSource) {
        for (const ns of appSyncableSource.namespaces.list()) {
          if (!ns.filesEnabled) continue;
          let rows;
          try {
            rows = await appSyncableSource.applier.scanFileRecordsByStatus(
              ns.appId,
              [SyncStatus.PendingFileUpload, SyncStatus.PendingFileDownload],
            );
          } catch (err) {
            console.warn(
              `[sync] scan reserved file-records failed (app=${ns.appId}): ${(err as Error).message}`,
            );
            continue;
          }
          for (const row of rows) {
            if (!row.object_storage_key) continue;
            if (fileSyncEngine.isTransferInFlight(row.object_storage_key)) continue;
            const manifest = {
              fileHash: row.content_hash || row.object_storage_key,
              objectStorageKey: row.object_storage_key,
              sizeBytes: row.size_bytes,
              mimeType: row.mime_type || undefined,
            };
            const haveLocal = await localObjectStorage.has(row.object_storage_key);
            try {
              if (haveLocal) {
                // Producer side or already-downloaded receiver: ensure remote
                // has the blob, then mark synced. transferFile short-circuits
                // when the destination already holds the key.
                const ok = await fileSyncEngine.transferFile(
                  manifest,
                  localObjectStorage,
                  remoteObjectStorage,
                );
                if (ok) {
                  await appSyncableSource.applier.setFileRecordStatus(
                    ns.appId,
                    row.id,
                    SyncStatus.Synced,
                  );
                  logTransition(
                    "client",
                    `${ns.appId}/${row.id}`,
                    row.sync_status as SyncStatus,
                    SyncStatus.Synced,
                    "app-file-upload-or-noop",
                  );
                  uploaded += 1;
                }
              } else {
                // Receiver: blob isn't local yet. Try to fetch from remote.
                const ok = await fileSyncEngine.transferFile(
                  manifest,
                  remoteObjectStorage,
                  localObjectStorage,
                );
                if (ok) {
                  await appSyncableSource.applier.setFileRecordStatus(
                    ns.appId,
                    row.id,
                    SyncStatus.Synced,
                  );
                  logTransition(
                    "client",
                    `${ns.appId}/${row.id}`,
                    row.sync_status as SyncStatus,
                    SyncStatus.Synced,
                    "app-file-download-complete",
                  );
                  downloaded += 1;
                }
                // If !ok the sender hasn't uploaded yet; stay pending and try
                // again on the next pass.
              }
            } catch (err) {
              console.warn(
                `[sync] app-file transfer failed (app=${ns.appId} key=${row.object_storage_key}): ${(err as Error).message}`,
              );
              failed += 1;
            }
          }
        }
      }

      try {
        const counts = await countNonTerminal(localDatabaseAdapter);
        logNonTerminalCounts("client", counts);
      } catch (err) {
        console.warn(`[sync-state] non-terminal count failed: ${(err as Error).message}`);
      }

      return { uploaded, downloaded, failed };
    },

    async fullSync(): Promise<{
      pulled: number;
      pushed: number;
      rejected: number;
    }> {
      const pullResult = await this.pull();
      const pushResult = await this.push();
      await this.runFileTransferPass();

      return {
        pulled: pullResult.changes.length,
        pushed: pushResult.accepted.length,
        rejected: pushResult.rejected.length,
      };
    },

    getConflicts(): SyncConflict[] {
      return Array.from(conflicts.values());
    },

    clearConflict(recordId: StarkeepId): void {
      conflicts.delete(recordId);
    },

    changeLog,
    changeNotifier,
  };
}
