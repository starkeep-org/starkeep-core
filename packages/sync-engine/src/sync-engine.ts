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
    listAppSyncableFiles,
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
        } else {
          await localDatabaseAdapter.put({
            ...remoteChange.recordSnapshot,
            syncStatus: SyncStatus.Synced,
          });
        }
        appliedIds.push(remoteChange.recordId);

        // Pull corresponding files if the record references one.
        if (remoteChange.operation !== "delete") {
          const snapshot = remoteChange.recordSnapshot;
          if (snapshot.objectStorageKey) {
            const filesToPull = await fileSyncEngine.getFilesToPull(
              localObjectStorage,
              remoteObjectStorage,
              [
                {
                  key: snapshot.objectStorageKey,
                  mimeType: snapshot.mimeType ?? undefined,
                },
              ],
            );
            for (const manifest of filesToPull) {
              await fileSyncEngine.transferFile(
                manifest,
                remoteObjectStorage,
                localObjectStorage,
              );
            }
          }
        }
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

      // Pull app-specific syncable files that exist remotely but not locally.
      if (listAppSyncableFiles) {
        try {
          const extras = await listAppSyncableFiles();
          if (extras.length > 0) {
            const filesToPull = await fileSyncEngine.getFilesToPull(
              localObjectStorage,
              remoteObjectStorage,
              extras,
            );
            for (const manifest of filesToPull) {
              try {
                await fileSyncEngine.transferFile(
                  manifest,
                  remoteObjectStorage,
                  localObjectStorage,
                );
              } catch (err) {
                console.warn(
                  `[sync] app-syncable pull skipped: ${manifest.objectStorageKey} — ${(err as Error).message}`,
                );
              }
            }
          }
        } catch (err) {
          console.warn(`[sync] listAppSyncableFiles failed: ${(err as Error).message}`);
        }
      }

      await savePullCursor(response.latestTimestamp);

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

      // Push files for records that carry references.
      const fileEntries: Array<{ key: string; mimeType?: string }> = pushable
        .filter((change) => change.recordSnapshot.objectStorageKey !== null)
        .map((change) => ({
          key: change.recordSnapshot.objectStorageKey as string,
          mimeType: change.recordSnapshot.mimeType ?? undefined,
        }));

      // App-specific syncable files: enumerated outside the record stream.
      if (listAppSyncableFiles) {
        try {
          const extras = await listAppSyncableFiles();
          for (const e of extras) fileEntries.push(e);
        } catch (err) {
          console.warn(`[sync] listAppSyncableFiles failed: ${(err as Error).message}`);
        }
      }

      const failedKeys = new Set<string>();

      if (fileEntries.length > 0) {
        const filesToPush = await fileSyncEngine.getFilesToPush(
          localObjectStorage,
          remoteObjectStorage,
          fileEntries,
        );
        for (const manifest of filesToPush) {
          try {
            await fileSyncEngine.transferFile(
              manifest,
              localObjectStorage,
              remoteObjectStorage,
            );
          } catch (err) {
            console.warn(`[sync] file transfer skipped: ${manifest.objectStorageKey} — ${(err as Error).message}`);
            failedKeys.add(manifest.objectStorageKey);
          }
        }
      }

      // Exclude record entries whose file transfer failed.
      const pushableWithFiles = pushable.filter(
        (change) =>
          change.recordSnapshot.objectStorageKey === null ||
          !failedKeys.has(change.recordSnapshot.objectStorageKey as string),
      );

      const response = await transport.pushChanges({
        changes: pushableWithFiles,
        appSyncableRows: appSyncableRows.length > 0 ? appSyncableRows : undefined,
      });

      // Accepted: mark corresponding local records as Synced.
      const acceptedSet = new Set(response.accepted);
      for (const change of pushable) {
        if (acceptedSet.has(change.recordId)) {
          const localRecord = await localDatabaseAdapter.get(change.recordId);
          if (
            localRecord &&
            localRecord.version === change.recordSnapshot.version
          ) {
            await localDatabaseAdapter.put({
              ...localRecord,
              syncStatus: SyncStatus.Synced,
            });
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

      return response;
    },

    async fullSync(): Promise<{
      pulled: number;
      pushed: number;
      rejected: number;
    }> {
      const pullResult = await this.pull();
      const pushResult = await this.push();

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
