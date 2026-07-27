import {
  createHLCClock,
  createDataRecord,
  dataRecordObjectKey,
  typeCategory,
  validateLabelWrite,
  dedupeLabelWrites,
  isValidLabelKey,
  type DataRecord,
  type MetadataRow,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
async function sha256Hex(data: Uint8Array | Buffer): Promise<string> {
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const buf = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
import { createUnifiedIndex } from "@starkeep/query-orchestrator";
import { createChangeNotifier } from "@starkeep/sync-engine";
import { createSharedSpaceApi } from "@starkeep/shared-space-api";
import type {
  StarkeepSdk,
  StarkeepSdkOptions,
  DataPutInput,
} from "./types.js";

/**
 * DSQL caps a write transaction at 3,000 modified rows, and secondary-index
 * entries do *not* count against it (measured), so the two indexes on
 * record_labels don't shrink this. Used for the record-type lookup too, where
 * it bounds the IN-list rather than a transaction.
 */
const LABEL_WRITE_CHUNK = 3000;

// Resolve a record's Starkeep type id (or a bare category id) to its metadata
// category. `other` has no metadata table, so callers skip persistence for it.
function metadataCategory(typeOrCategory: string): string {
  return typeCategory(typeOrCategory);
}

export async function createStarkeepSdk(
  options: StarkeepSdkOptions,
): Promise<StarkeepSdk> {
  const {
    databaseAdapter,
    objectStorageAdapter,
    nodeId,
    syncStateStore,
  } = options;

  await databaseAdapter.init();
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

  // One shared change notifier. Writes emit `local-change-recorded`; the
  // supervisor's per-app sync engines forward their own pull/conflict events
  // onto this same notifier so consumers (sharedSpaceApi, SSE clients) see
  // one unified stream. Callers may inject a notifier (e.g. the local-data-
  // server hoists it to share with the app-specific factory, which emits
  // its own local-change events tagged with the writing app's id).
  const changeNotifier = options.changeNotifier ?? createChangeNotifier();

  const unifiedIndex = createUnifiedIndex({ databaseAdapter });

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

  /**
   * Labels are shared data, so this is emitted with no `originAppId` — the
   * always-on Drive channel owns them, not the writing app's channel.
   *
   * Note it carries the *labelled* record ids. Nothing about the record row
   * changed; this only nudges the engine to look, and a label write must
   * never touch `records.updated_at` (that would re-ship the whole record).
   */
  function logLabelChange(recordIds: StarkeepId[]): void {
    if (recordIds.length === 0) return;
    changeNotifier.emit({
      eventType: "local-change-recorded",
      recordIds: [...new Set(recordIds)],
      timestamp: clock.now(),
    });
  }

  const sharedSpaceApi = createSharedSpaceApi({
    databaseAdapter,
    objectStorageAdapter,
    clock,
    changeNotifier,
    getAppSpecific: options.getAppSpecific,
  });

  async function writeRecordAndMetadata(
    input: DataPutInput,
    fileBytes: Uint8Array,
    contentType: string | null,
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
    if (input.metadata && metadataCategory(input.type) !== "other") {
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

        await objectStorageAdapter.put(objectStorageKey, file, { contentType: contentType ?? undefined });
        return writeRecordAndMetadata(
          { ...input, contentHash, objectStorageKey } as DataPutInput,
          file,
          contentType ?? null,
          input.originalFilename ?? null,
        );
      },

      async putWithLocalFile(input, filePath, contentType) {
        const fileBytes = await readFile(filePath);
        const contentHash = await sha256Hex(fileBytes);
        const objectStorageKey = dataRecordObjectKey(input.type, contentHash);

        if (objectStorageAdapter.putSymlink) {
          await objectStorageAdapter.putSymlink(objectStorageKey, filePath, { contentType: contentType ?? undefined });
        } else {
          await objectStorageAdapter.put(objectStorageKey, fileBytes, { contentType: contentType ?? undefined });
        }

        return writeRecordAndMetadata(
          input,
          fileBytes,
          contentType ?? null,
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
        // Cascade to labels by hand — no FK backs record_id on either
        // backend. Crosses app namespaces deliberately: the record is going
        // away, so every app's assertions about it go with it. Tombstones
        // rather than hard-deletes, so the cascade itself syncs; a record
        // with 8 labels is 9 rows, nowhere near any transaction limit.
        await databaseAdapter.tombstoneLabelsForRecord(recordId, ts);
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

      // `typeId` may be a record's extension or a category id; the adapter
      // derives the per-category metadata table. The `other` category has no
      // metadata table, so these are no-ops for it.
      async putMetadata(typeId: string, row: MetadataRow) {
        if (metadataCategory(typeId) === "other") return;
        await databaseAdapter.putMetadata(typeId, row);
      },

      async getMetadata(typeId, recordId) {
        if (metadataCategory(typeId) === "other") return null;
        return databaseAdapter.getMetadata(typeId, recordId);
      },

      async getMetadataByIds(typeId, recordIds) {
        if (metadataCategory(typeId) === "other") return new Map();
        return databaseAdapter.getMetadataByIds(typeId, recordIds);
      },

      async setLabels(appId, entries) {
        if (entries.length === 0) return;

        // Shape first, across the whole batch, so a bad key fails before any
        // chunk is written rather than partway through a bulk job.
        for (const e of entries) {
          const problem = validateLabelWrite({ key: e.key, value: e.value ?? null });
          if (problem) throw new Error(problem);
        }

        // Every label needs its record's type, denormalized onto the row.
        // This read — not the upsert — is very likely the dominant cost of a
        // bulk labelling job, and it is what the "one statement per batch"
        // framing hides.
        const ids = [...new Set(entries.map((e) => e.recordId))];
        const recordTypes = new Map<string, string>();
        for (let i = 0; i < ids.length; i += LABEL_WRITE_CHUNK) {
          const slice = ids.slice(i, i + LABEL_WRITE_CHUNK);
          const found = await databaseAdapter.query({
            filters: [
              { field: "id", operator: "in", value: slice },
              { field: "deletedAt", operator: "isNull" },
            ],
            limit: slice.length,
          });
          for (const r of found.records) recordTypes.set(r.id, r.type);
        }

        // Deduped by (recordId, key), last wins. A chunk is one multi-row
        // upsert, and Postgres/DSQL rejects one that touches the same row
        // twice while SQLite quietly keeps the last — so an undeduped repeat
        // is a batch that works locally and 500s in the cloud.
        const rows = dedupeLabelWrites(entries).map((e) => {
          const recordType = recordTypes.get(e.recordId);
          if (recordType === undefined) {
            // No FK backs record_id, so without this the write would create
            // an orphan silently.
            throw new Error(`Cannot label record ${e.recordId}: it does not exist`);
          }
          return { recordId: e.recordId, key: e.key, value: e.value ?? null, recordType };
        });

        // DSQL caps a transaction at 3,000 modified rows. Chunks are not
        // atomic with each other; the upsert being idempotent is what makes a
        // partial failure safe to retry from the beginning.
        const hlc = clock.now();
        for (let i = 0; i < rows.length; i += LABEL_WRITE_CHUNK) {
          await databaseAdapter.upsertLabels(
            rows.slice(i, i + LABEL_WRITE_CHUNK).map((r) => ({ ...r, appId, hlc })),
          );
        }
        logLabelChange(rows.map((r) => r.recordId));
      },

      async retractLabels(appId, entries) {
        if (entries.length === 0) return;
        for (const e of entries) {
          if (!isValidLabelKey(e.key)) throw new Error(`invalid label key "${e.key}"`);
        }
        // Deliberately no record-existence check: retracting a label on a
        // deleted record is a no-op, not an error.
        const hlc = clock.now();
        for (let i = 0; i < entries.length; i += LABEL_WRITE_CHUNK) {
          await databaseAdapter.retractLabels(
            entries.slice(i, i + LABEL_WRITE_CHUNK).map((e) => ({
              recordId: e.recordId,
              key: e.key,
              appId,
              hlc,
            })),
          );
        }
        logLabelChange(entries.map((e) => e.recordId));
      },

      async getLabelsByIds(recordIds) {
        if (recordIds.length === 0) return new Map();
        return databaseAdapter.getLabelsByRecordIds(recordIds);
      },

      async findByLabel(sel, page) {
        const found = await databaseAdapter.findByLabel({
          appId: sel.appId,
          key: sel.key,
          value: sel.value,
          limit: page?.limit,
          cursor: page?.cursor,
        });
        if (found.labels.length === 0) {
          return { records: [], nextCursor: found.nextCursor };
        }
        const ids = found.labels.map((l) => l.recordId);
        const fetched = await databaseAdapter.query({
          filters: [
            { field: "id", operator: "in", value: ids },
            { field: "deletedAt", operator: "isNull" },
          ],
          limit: ids.length,
        });
        // Restore the reverse index's order: `query` returns id-ascending,
        // which is not the (value, record_id) order the cursor is keyed on.
        const byId = new Map(fetched.records.map((r) => [r.id as string, r]));
        return {
          records: ids
            .map((id) => byId.get(id))
            .filter((r): r is DataRecord => r !== undefined),
          nextCursor: found.nextCursor,
        };
      },
    },

    index: {
      async search(query) {
        return unifiedIndex.search(query);
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
