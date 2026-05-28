import {
  createHLCClock,
  createDataRecord,
  dataRecordObjectKey,
  type DataRecord,
  type MetadataRow,
  type TypeRegistration,
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
import { createChangeNotifier } from "@starkeep/sync-engine";
import { createAccessControlEngine, createEnforcedDatabaseAdapter } from "@starkeep/access-control";
import { createSharedSpaceApi } from "@starkeep/shared-space-api";
import type {
  StarkeepSdk,
  StarkeepSdkOptions,
  DataPutInput,
} from "./types.js";

export async function createStarkeepSdk(
  options: StarkeepSdkOptions,
): Promise<StarkeepSdk> {
  const {
    databaseAdapter: rawDatabaseAdapter,
    objectStorageAdapter,
    accessPolicyStore,
    sharingTokenStore,
    typeRegistrationStore,
    ownerId,
    nodeId,
    syncStateStore,
    subject,
  } = options;

  await rawDatabaseAdapter.init();
  await objectStorageAdapter.init();

  // Seed the clock from persisted state and debounce write-back on tick,
  // so a restart resumes with an HLC causally after anything we emitted.
  // The clock state is global (one clock per node) — the supervisor's
  // per-app cursors live alongside it in the same store but are owned
  // elsewhere.
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

  // The SDK owns one shared change notifier. Writes emit
  // `local-change-recorded`; the supervisor's per-app sync engines forward
  // their own pull/conflict events onto this same notifier so consumers
  // (sharedSpaceApi, SSE clients) see one unified stream.
  const changeNotifier = createChangeNotifier();

  // When a subject is provided, wrap the adapter so every operation is
  // gated by access control and the private-storage structural rule.
  const accessControlEngine = createAccessControlEngine({
    policyStore: accessPolicyStore,
    tokenStore: sharingTokenStore,
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

  /**
   * Emit a `local-change-recorded` event for a write. The supervisor wakes its
   * exchange loop in response; the records-table row itself is the durable
   * source of truth for what to ship (no separate change log).
   */
  function logChange(record: DataRecord): void {
    changeNotifier.emit({
      eventType: "local-change-recorded",
      recordIds: [record.id],
      timestamp: clock.now(),
    });
  }

  const sharedSpaceApi = createSharedSpaceApi({
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId,
    changeNotifier,
    getAppSpecific: options.getAppSpecific,
  });

  async function writeRecordAndMetadata(
    input: DataPutInput,
    fileBytes: Uint8Array,
    contentType: string,
    originalFilename: string | null,
  ): Promise<DataRecord> {
    const contentHash = await sha256Hex(fileBytes);
    const objectStorageKey = dataRecordObjectKey(input.type, contentHash);

    const record = createDataRecord(
      {
        ...input,
        contentHash,
        objectStorageKey,
        mimeType: contentType,
        sizeBytes: fileBytes.length,
        originalFilename,
      },
      clock,
    );
    await databaseAdapter.put(record);
    if (input.metadata) {
      await databaseAdapter.putMetadata(input.type, {
        ...input.metadata,
        recordId: record.id,
      });
    }
    logChange(record);
    return record;
  }

  return {
    data: {
      async putWithFile(input, file, contentType) {
        const contentHash = await sha256Hex(file);
        const objectStorageKey = dataRecordObjectKey(input.type, contentHash);

        await objectStorageAdapter.put(objectStorageKey, file, { contentType });
        return writeRecordAndMetadata(
          { ...input, contentHash, objectStorageKey } as DataPutInput,
          file,
          contentType,
          input.originalFilename ?? null,
        );
      },

      async putWithLocalFile(input, filePath, contentType) {
        const fileBytes = await readFile(filePath);
        const contentHash = await sha256Hex(fileBytes);
        const objectStorageKey = dataRecordObjectKey(input.type, contentHash);

        if (objectStorageAdapter.putSymlink) {
          await objectStorageAdapter.putSymlink(objectStorageKey, filePath, { contentType });
        } else {
          await objectStorageAdapter.put(objectStorageKey, fileBytes, { contentType });
        }

        return writeRecordAndMetadata(
          input,
          fileBytes,
          contentType,
          input.originalFilename ?? basename(filePath),
        );
      },

      async putWithExistingBlob(input, blob) {
        // Bytes are already in object storage (uploaded out-of-band, e.g. via
        // a presigned PUT). Skip the upload + re-hash; trust the caller's
        // contentHash and sizeBytes. The records-table row is otherwise
        // identical to what putWithFile would produce.
        const record = createDataRecord(
          {
            ...input,
            contentHash: blob.contentHash,
            objectStorageKey: blob.objectStorageKey,
            mimeType: blob.mimeType,
            sizeBytes: blob.sizeBytes,
            originalFilename: input.originalFilename ?? null,
          } as DataPutInput as never,
          clock,
        );
        await databaseAdapter.put(record);
        if (input.metadata) {
          await databaseAdapter.putMetadata(input.type, {
            ...input.metadata,
            recordId: record.id,
          });
        }
        logChange(record);
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
        const updated: DataRecord = {
          ...existing,
          originalFilename: patch.originalFilename ?? existing.originalFilename,
          parentId: patch.parentId ?? existing.parentId,
          version: existing.version + 1,
          updatedAt: clock.now(),
        };
        await databaseAdapter.put(updated);
        logChange(updated);
        return updated;
      },

      async delete(recordId) {
        const existing = await databaseAdapter.get(recordId);
        if (!existing) return;
        const ts = clock.now();
        await databaseAdapter.delete(recordId, ts);
        await databaseAdapter.deleteMetadata(existing.type, recordId);
        const tombstone: DataRecord = {
          ...existing,
          updatedAt: ts,
          deletedAt: ts,
          version: existing.version + 1,
        };
        logChange(tombstone);
      },

      async query(params) {
        const result = await databaseAdapter.query(params);
        return result.records;
      },

      async putMetadata(typeId: string, row: MetadataRow) {
        await databaseAdapter.putMetadata(typeId, row);
      },

      async getMetadata(typeId, recordId) {
        return databaseAdapter.getMetadata(typeId, recordId);
      },

      async getMetadataByIds(typeId, recordIds) {
        return databaseAdapter.getMetadataByIds(typeId, recordIds);
      },
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

    typeRegistrations: {
      async register(registration) {
        const full: TypeRegistration = {
          ...registration,
          registeredAt: clock.now(),
        };
        await typeRegistrationStore.put(full);
        return full;
      },

      async get(typeId) {
        return typeRegistrationStore.get(typeId);
      },

      async list() {
        return typeRegistrationStore.list();
      },
    },

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

    changeNotifier,
    clock,

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
    },
  };
}
