import {
  createHLCClock,
  createDataRecord,
  makePrivateType,
  SyncStatus,
  type StarkeepId,
  type DataRecord,
} from "@starkeep/core";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
async function sha256Hex(data: Uint8Array | Buffer): Promise<string> {
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const buf = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
import { createUnifiedIndex } from "@starkeep/index";
import { createAggregationEngine } from "@starkeep/aggregations";
import { createSyncEngine, type SyncEngine } from "@starkeep/sync-engine";
import { createAccessControlEngine, createEnforcedDatabaseAdapter } from "@starkeep/access-control";
import { createSharedSpaceApi } from "@starkeep/shared-space-api";
import type { StarkeepSdk, StarkeepSdkOptions, ConflictResolution } from "./types.js";

export async function createStarkeepSdk(
  options: StarkeepSdkOptions,
): Promise<StarkeepSdk> {
  const {
    databaseAdapter: rawDatabaseAdapter,
    objectStorageAdapter,
    ownerId,
    nodeId,
    syncTransport,
    remoteObjectStorageAdapter,
    syncChangeLog,
    syncStateStore,
    subject,
  } = options;

  await rawDatabaseAdapter.init();
  await objectStorageAdapter.init();

  // Seed the clock from persisted state and debounce write-back on tick,
  // so a restart resumes with an HLC causally after anything we emitted.
  const initialHlcState =
    (await syncStateStore?.getHlcClockState()) ?? undefined;
  let pendingClockState: { wallTime: number; counter: number } | null = null;
  let clockFlushTimer: NodeJS.Timeout | null = null;
  const clock =
    options.clock ??
    createHLCClock({
      nodeId,
      wallClockFunction: Date.now,
      initialState: initialHlcState,
      onTick: syncStateStore
        ? (state) => {
            pendingClockState = state;
            if (clockFlushTimer) return;
            clockFlushTimer = setTimeout(() => {
              clockFlushTimer = null;
              if (pendingClockState) {
                void syncStateStore.setHlcClockState(pendingClockState);
              }
            }, 5000);
          }
        : undefined,
    });

  // When a subject is provided, wrap the adapter so every operation is
  // gated by access control and the private-storage structural rule.
  const accessControlEngine = createAccessControlEngine({
    databaseAdapter: rawDatabaseAdapter,
    clock,
    ownerId,
  });
  await accessControlEngine.loadPolicies();

  const databaseAdapter = subject
    ? createEnforcedDatabaseAdapter({
        databaseAdapter: rawDatabaseAdapter,
        accessControlEngine,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
      })
    : rawDatabaseAdapter;

  const unifiedIndex = createUnifiedIndex({ databaseAdapter });
  const aggregationEngine = createAggregationEngine({ databaseAdapter });

  let syncEngine: SyncEngine | null = null;
  if (syncTransport && remoteObjectStorageAdapter) {
    await remoteObjectStorageAdapter.init();
    syncEngine = createSyncEngine({
      localDatabaseAdapter: databaseAdapter,
      localObjectStorage: objectStorageAdapter,
      remoteObjectStorage: remoteObjectStorageAdapter,
      transport: syncTransport,
      clock,
      changeLog: syncChangeLog,
      syncState: syncStateStore,
    });
  }

  const sharedSpaceApi = createSharedSpaceApi({
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId,
    changeNotifier: syncEngine?.changeNotifier,
  });

  async function resolveConflictImpl(
    recordId: StarkeepId,
    resolution: ConflictResolution,
  ): Promise<DataRecord | null> {
    if (!syncEngine) {
      throw new Error("Sync is not configured; no conflicts to resolve.");
    }
    const current = syncEngine.getConflicts().find((c) => c.recordId === recordId);
    if (!current) return null;

    if (resolution.keep === "server") {
      if (!current.server) {
        await databaseAdapter.delete(recordId);
        syncEngine.clearConflict(recordId);
        return null;
      }
      await databaseAdapter.put({
        ...current.server,
        syncStatus: SyncStatus.Synced,
      });
      syncEngine.clearConflict(recordId);
      return databaseAdapter.get(recordId);
    }

    if (resolution.keep === "local") {
      const baseVersion = current.server?.version ?? null;
      const rebased: DataRecord = {
        ...current.local,
        version: (baseVersion ?? 0) + 1,
        updatedAt: clock.now(),
        syncStatus: SyncStatus.PendingPush,
      };
      await databaseAdapter.put(rebased);
      syncEngine.clearConflict(recordId);
      await syncEngine.recordChange(
        current.server ? "update" : "create",
        rebased,
        { baseVersion },
      );
      return rebased;
    }

    // keep: "custom" — caller supplies record verbatim, we trust its version.
    await databaseAdapter.put({
      ...resolution.record,
      syncStatus: SyncStatus.PendingPush,
    });
    syncEngine.clearConflict(recordId);
    await syncEngine.recordChange("update", resolution.record, {
      baseVersion: current.server?.version ?? null,
    });
    return resolution.record;
  }

  return {
    data: {
      async put(input) {
        const record = createDataRecord(input, clock);
        await databaseAdapter.put(record);
        if (syncEngine) {
          await syncEngine.recordChange("create", record, { baseVersion: null });
        }
        return record;
      },

      async putWithFile(input, file, contentType) {
        const contentHash = await sha256Hex(file);
        const objectStorageKey = `${contentHash.slice(0, 2)}/${contentHash}`;

        await objectStorageAdapter.put(objectStorageKey, file, { contentType });

        const record = createDataRecord(
          {
            ...input,
            contentHash,
            objectStorageKey,
            mimeType: contentType ?? null,
            sizeBytes: file.length,
          },
          clock,
        );
        await databaseAdapter.put(record);
        if (syncEngine) {
          await syncEngine.recordChange("create", record, { baseVersion: null });
        }
        return record;
      },

      async putWithLocalFile(input, filePath, contentType) {
        const fileBytes = await readFile(filePath);
        const contentHash = await sha256Hex(fileBytes);
        const objectStorageKey = `${contentHash.slice(0, 2)}/${contentHash}`;

        if (objectStorageAdapter.putSymlink) {
          await objectStorageAdapter.putSymlink(objectStorageKey, filePath, { contentType });
        } else {
          await objectStorageAdapter.put(objectStorageKey, fileBytes, { contentType });
        }

        const record = createDataRecord(
          {
            ...input,
            contentHash,
            objectStorageKey,
            mimeType: contentType ?? null,
            sizeBytes: fileBytes.length,
            originalFilename: input.originalFilename ?? basename(filePath),
          },
          clock,
        );
        await databaseAdapter.put(record);
        if (syncEngine) {
          await syncEngine.recordChange("create", record, { baseVersion: null });
        }
        return record;
      },

      async get(recordId) {
        const record = await databaseAdapter.get(recordId);
        if (!record) return null;
        if (record.deletedAt) return null;
        return record;
      },

      async update(recordId, patch) {
        const existing = await databaseAdapter.get(recordId);
        if (!existing) {
          throw new Error(`No data record found with id ${recordId}`);
        }
        const baseVersion = existing.version;
        const updated: DataRecord = {
          ...existing,
          ...patch,
          id: existing.id,
          kind: "data",
          createdAt: existing.createdAt,
          version: baseVersion + 1,
          updatedAt: clock.now(),
          syncStatus: SyncStatus.PendingPush,
        };
        await databaseAdapter.put(updated);
        if (syncEngine) {
          await syncEngine.recordChange("update", updated, { baseVersion });
        }
        return updated;
      },

      async delete(recordId) {
        const existing = await databaseAdapter.get(recordId);
        if (!existing) return;
        const tombstone: DataRecord = {
          ...existing,
          version: existing.version + 1,
          updatedAt: clock.now(),
          deletedAt: clock.now(),
          syncStatus: SyncStatus.PendingPush,
        };
        await databaseAdapter.put(tombstone);
        if (syncEngine) {
          await syncEngine.recordChange("delete", tombstone, {
            baseVersion: existing.version,
          });
        }
      },

      async query(params) {
        const result = await databaseAdapter.query(params);
        return result.records;
      },

      resolveConflict: resolveConflictImpl,
    },

    index: {
      async search(query) {
        return unifiedIndex.search(query);
      },
    },

    aggregations: {
      async compute(aggregationOptions) {
        return aggregationEngine.compute(aggregationOptions);
      },
    },

    sync: syncEngine
      ? {
          async push() {
            const result = await syncEngine!.push();
            return {
              pushed: result.accepted.length,
              rejected: result.rejected.length,
            };
          },

          async pull() {
            const result = await syncEngine!.pull();
            return { pulled: result.changes.length };
          },

          async fullSync() {
            return syncEngine!.fullSync();
          },

          getConflicts() {
            return syncEngine!.getConflicts();
          },

          onUpdate(listener) {
            return syncEngine!.changeNotifier.subscribe(listener);
          },
        }
      : null,

    accessControl: {
      async createPolicy(input) {
        if (subject) {
          throw new Error(
            "createPolicy is not available on an app-scoped SDK. Policies are managed by the admin layer.",
          );
        }
        return accessControlEngine.createPolicy(input);
      },

      async revokePolicy(policyId) {
        if (subject) {
          throw new Error(
            "revokePolicy is not available on an app-scoped SDK. Policies are managed by the admin layer.",
          );
        }
        return accessControlEngine.revokePolicy(policyId);
      },

      async listPolicies(listOptions) {
        return accessControlEngine.listPolicies(listOptions);
      },

      async checkAccess(request) {
        return accessControlEngine.checkAccess(request);
      },
    },

    privateStore:
      subject?.subjectType === "app"
        ? (() => {
            return {
              async put(subtype: string, content: Record<string, unknown> = {}) {
                const privateType = makePrivateType(subject.subjectId, subtype);
                const record = createDataRecord({ type: privateType, ownerId, content }, clock);
                await databaseAdapter.put(record);
                return record;
              },

              async get(recordId: StarkeepId) {
                return databaseAdapter.get(recordId);
              },

              async delete(recordId: StarkeepId) {
                await databaseAdapter.delete(recordId);
              },
            };
          })()
        : null,

    api: {
      get router() {
        return sharedSpaceApi.router;
      },
      async handleRequest(request) {
        return sharedSpaceApi.handleRequest(request);
      },
      handleWebSocketConnect(connection) {
        return sharedSpaceApi.handleWebSocketConnect(connection);
      },
    },

    async close() {
      if (clockFlushTimer) {
        clearTimeout(clockFlushTimer);
        clockFlushTimer = null;
      }
      if (pendingClockState && syncStateStore) {
        await syncStateStore.setHlcClockState(pendingClockState);
      }
      await databaseAdapter.close();
      await objectStorageAdapter.close();
      if (remoteObjectStorageAdapter) {
        await remoteObjectStorageAdapter.close();
      }
    },
  };
}
