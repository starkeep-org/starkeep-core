import {
  compareHLC,
  maxHLC,
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

      // Fetch local unsynced changes in bulk so dirty-conflict detection
      // is O(1) per remote change.
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

      // Skip records we already know are in conflict — they need manual
      // resolution before we push anything new for them.
      const pushable = localChanges.filter(
        (change) => !conflicts.has(change.recordId),
      );

      if (pushable.length === 0) {
        return {
          accepted: [],
          rejected: [],
          latestTimestamp: since,
        };
      }

      // Push files for records that carry references. Use pushable (skip
      // records already in conflict) and propagate mimeType so the remote
      // stores it alongside the blob.
      const fileEntries = pushable
        .filter((change) => change.recordSnapshot.objectStorageKey !== null)
        .map((change) => ({
          key: change.recordSnapshot.objectStorageKey as string,
          mimeType: change.recordSnapshot.mimeType ?? undefined,
        }));

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

      // Exclude records whose file transfer failed — they'll be retried on the next push.
      const pushableWithFiles = pushable.filter(
        (change) =>
          change.recordSnapshot.objectStorageKey === null ||
          !failedKeys.has(change.recordSnapshot.objectStorageKey),
      );

      const response = await transport.pushChanges({ changes: pushableWithFiles });

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

      // Advance push cursor to max timestamp of the pushed batch —
      // both accepted AND rejected, so rejected stays parked in the
      // conflict map rather than being retried automatically.
      const maxTimestamp = pushable.reduce(
        (acc, entry) => maxHLC(acc, entry.timestamp),
        since,
      );
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
