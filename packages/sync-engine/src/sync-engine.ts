import { compareHLC, type StarkeepId, type AnyRecord, type DataRecord } from "@starkeep/core";
import type {
  SyncEngine,
  SyncEngineOptions,
  SyncPullResponse,
  SyncPushResponse,
  ChangeLogEntry,
  ConflictResolution,
} from "./types.js";
import { createChangeLog } from "./change-log.js";
import { createChangeNotifier } from "./change-notifier.js";
import { createFileSyncEngine } from "./file-sync-engine.js";
import { resolveConflict } from "./conflict-resolver.js";

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const {
    localDatabaseAdapter,
    remoteDatabaseAdapter,
    localObjectStorage,
    remoteObjectStorage,
    clock,
  } = options;

  const changeLog = createChangeLog();
  const changeNotifier = createChangeNotifier();
  const fileSyncEngine = createFileSyncEngine();

  let lastSyncTimestamp = { wallTime: 0, counter: 0, nodeId: "" };

  async function applyRemoteChanges(
    remoteChanges: ChangeLogEntry[],
  ): Promise<{
    applied: number;
    conflicts: ConflictResolution[];
  }> {
    let applied = 0;
    const conflicts: ConflictResolution[] = [];

    for (const remoteChange of remoteChanges) {
      const localRecord = await localDatabaseAdapter.get(
        remoteChange.recordId,
      );

      if (!localRecord) {
        if (remoteChange.operation !== "delete") {
          await localDatabaseAdapter.put(remoteChange.recordSnapshot);
          applied++;
        }
        continue;
      }

      const localChangesSince = await changeLog.getChangesSince(
        lastSyncTimestamp,
      );
      const localConflict = localChangesSince.find(
        (entry) => entry.recordId === remoteChange.recordId,
      );

      if (localConflict) {
        const resolution = resolveConflict(localConflict, remoteChange);
        conflicts.push(resolution);

        if (resolution.winner === "remote") {
          if (remoteChange.operation === "delete") {
            await localDatabaseAdapter.delete(remoteChange.recordId);
          } else {
            await localDatabaseAdapter.put(resolution.resolvedRecord);
          }
          applied++;
        }
      } else {
        if (remoteChange.operation === "delete") {
          await localDatabaseAdapter.delete(remoteChange.recordId);
        } else {
          await localDatabaseAdapter.put(remoteChange.recordSnapshot);
        }
        applied++;
      }
    }

    return { applied, conflicts };
  }

  return {
    async recordChange(
      operation: "create" | "update" | "delete",
      record: AnyRecord,
    ): Promise<void> {
      await changeLog.append({
        recordId: record.id,
        operation,
        timestamp: clock.now(),
        recordSnapshot: record,
      });
    },

    async pull(): Promise<SyncPullResponse> {
      const remoteResult = await remoteDatabaseAdapter.query({
        limit: 1000,
      });

      const remoteChanges: ChangeLogEntry[] = [];
      for (const record of remoteResult.records) {
        if (compareHLC(record.updatedAt, lastSyncTimestamp) > 0) {
          remoteChanges.push({
            changeId: record.id,
            recordId: record.id,
            operation: record.deletedAt ? "delete" : "update",
            timestamp: record.updatedAt,
            recordSnapshot: record,
          });
        }
      }

      const { applied, conflicts } =
        await applyRemoteChanges(remoteChanges);

      if (remoteChanges.length > 0) {
        changeNotifier.emit({
          eventType:
            conflicts.length > 0
              ? "conflict-detected"
              : "local-data-synced",
          recordIds: remoteChanges.map((change) => change.recordId),
          timestamp: clock.now(),
        });
      }

      const latestTimestamp =
        (await changeLog.getLatestTimestamp()) ?? lastSyncTimestamp;

      return {
        changes: remoteChanges,
        latestTimestamp,
        hasMore: remoteResult.hasMore,
      };
    },

    async push(): Promise<SyncPushResponse> {
      const localChanges = await changeLog.getChangesSince(
        lastSyncTimestamp,
      );

      const accepted: StarkeepId[] = [];
      const conflicts: ConflictResolution[] = [];

      for (const localChange of localChanges) {
        const remoteRecord = await remoteDatabaseAdapter.get(
          localChange.recordId,
        );

        if (
          remoteRecord &&
          compareHLC(remoteRecord.updatedAt, lastSyncTimestamp) > 0
        ) {
          const remoteChangeEntry: ChangeLogEntry = {
            changeId: remoteRecord.id,
            recordId: remoteRecord.id,
            operation: remoteRecord.deletedAt ? "delete" : "update",
            timestamp: remoteRecord.updatedAt,
            recordSnapshot: remoteRecord,
          };

          const resolution = resolveConflict(localChange, remoteChangeEntry);
          conflicts.push(resolution);

          if (resolution.winner === "local") {
            if (localChange.operation === "delete") {
              await remoteDatabaseAdapter.delete(localChange.recordId);
            } else {
              await remoteDatabaseAdapter.put(
                localChange.recordSnapshot,
              );
            }
            accepted.push(localChange.recordId);
          }
        } else {
          if (localChange.operation === "delete") {
            await remoteDatabaseAdapter.delete(localChange.recordId);
          } else {
            await remoteDatabaseAdapter.put(localChange.recordSnapshot);
          }
          accepted.push(localChange.recordId);
        }
      }

      // Sync files for pushed records
      const fileKeys = localChanges
        .map((change) => {
          const snapshot = change.recordSnapshot;
          if (snapshot.kind === "data") {
            return (snapshot as DataRecord).objectStorageKey;
          }
          return null;
        })
        .filter((key): key is string => key !== null);

      if (fileKeys.length > 0) {
        const filesToPush = await fileSyncEngine.getFilesToPush(
          localObjectStorage,
          remoteObjectStorage,
          fileKeys,
        );
        for (const manifest of filesToPush) {
          await fileSyncEngine.transferFile(
            manifest,
            localObjectStorage,
            remoteObjectStorage,
          );
        }
      }

      lastSyncTimestamp = clock.now();

      return {
        accepted,
        conflicts,
        latestTimestamp: lastSyncTimestamp,
      };
    },

    async fullSync(): Promise<{
      pulled: number;
      pushed: number;
      conflicts: number;
    }> {
      const pullResult = await this.pull();
      const pushResult = await this.push();

      return {
        pulled: pullResult.changes.length,
        pushed: pushResult.accepted.length,
        conflicts: pushResult.conflicts.length,
      };
    },

    changeLog,
    changeNotifier,
  };
}
