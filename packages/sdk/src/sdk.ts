import {
  createHLCClock,
  createDataRecord,
  dataRecordObjectKey,
  typeCategory,
  validateLabelWrite,
  dedupeLabelWrites,
  isValidLabelKey,
  LABEL_VALUES_PER_KEY_MAX,
  type DataRecord,
  type HLCClock,
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
import type { SyncStateStore } from "@starkeep/sync-engine";
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

/**
 * The node's one HLC clock, seeded from persisted state and debounce-persisted
 * on tick, so a restart resumes causally after anything already emitted.
 *
 * ## Exactly one of these per node id, and it is not a style preference
 *
 * An HLC's guarantee — that one author's timestamps are a total order with no
 * duplicates — holds only while a single clock instance issues them. Two
 * instances sharing a node id break it in both directions at once: called in
 * the same millisecond each returns counter 0, so two different rows carry the
 * *identical* timestamp, and once they drift the later write can carry the
 * *lower* one.
 *
 * The sync watermark is what turns that into data loss. A peer advances one
 * HLC per author meaning "everything at or below this is applied" and then asks
 * for strictly more, so a duplicated timestamp is a row the protocol has no way
 * to name a second time. The local-data-server had exactly this: its own
 * unpersisted clock stamped label writes while the SDK's stamped the records
 * they belonged to, and a handset was found holding two rendition records whose
 * labels had been dropped this way — 23% of that node's rendition labels
 * carried an HLC at or below their own record's.
 *
 * So callers that need a clock alongside an SDK must build it with this and
 * hand the same instance to {@link createStarkeepSdk} as `options.clock`,
 * rather than constructing a second one with the same node id. A caller that
 * does so owns {@link NodeClock.close}, because the SDK only closes a clock it
 * built itself.
 */
export interface NodeClock {
  readonly clock: HLCClock;
  /** Cancel the debounce and persist whatever it was still holding. */
  close(): Promise<void>;
}

export async function createNodeClock(options: {
  readonly nodeId: string;
  readonly syncStateStore?: SyncStateStore | undefined;
}): Promise<NodeClock> {
  const { nodeId, syncStateStore } = options;
  const initialState = (await syncStateStore?.getHlcClockState()) ?? undefined;
  let pending: { wallTime: number; counter: number } | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  const clock = createHLCClock({
    nodeId,
    wallClockFunction: Date.now,
    initialState,
    onTick: syncStateStore
      ? (state) => {
          pending = state;
          if (flushTimer) return;
          flushTimer = setTimeout(() => {
            flushTimer = null;
            const flushing = pending;
            // Cleared before the write, so `close()` can tell "never persisted"
            // from "already on disk" and does not rewrite state the timer has
            // handled. A failure below restores it rather than dropping it.
            pending = null;
            if (flushing) {
              syncStateStore.setHlcClockState(flushing).catch((err: unknown) => {
                // Not fatal — the clock keeps issuing timestamps and the next
                // tick schedules another attempt. Silence is the problem: a
                // clock that has quietly stopped persisting looks exactly like
                // one that is up to date, right up until a restart resumes
                // behind what this node already emitted.
                if (pending === null) pending = flushing;
                console.warn(
                  `[sdk] could not persist HLC clock state: ${(err as Error).message}`,
                );
              });
            }
          }, 5000);
        }
      : undefined,
  });
  return {
    clock,
    async close() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending && syncStateStore) {
        const flushing = pending;
        pending = null;
        await syncStateStore.setHlcClockState(flushing);
      }
    },
  };
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

  // Only built when the caller did not supply one. A caller that did owns the
  // flush on shutdown, which is why this stays null in that case rather than
  // closing a clock this SDK does not own.
  const ownClock = options.clock ? null : await createNodeClock({ nodeId, syncStateStore });
  const clock = options.clock ?? ownClock!.clock;

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

  /**
   * `record id → records.type` for the live records among `recordIds`, which
   * every label row needs denormalized onto it. Missing ids are missing records.
   *
   * This read — not the upsert — is very likely the dominant cost of a bulk
   * labelling job, and it is what the "one statement per batch" framing hides.
   */
  async function loadRecordTypes(
    recordIds: StarkeepId[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(recordIds)];
    const types = new Map<string, string>();
    for (let i = 0; i < ids.length; i += LABEL_WRITE_CHUNK) {
      const slice = ids.slice(i, i + LABEL_WRITE_CHUNK);
      const found = await databaseAdapter.query({
        filters: [
          { field: "id", operator: "in", value: slice },
          { field: "deletedAt", operator: "isNull" },
        ],
        limit: slice.length,
      });
      for (const r of found.records) types.set(r.id, r.type);
    }
    return types;
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

        // Move the record's clock, because metadata now rides the record over
        // sync and the outbound scan is a delta scan over exactly this column.
        // Without this a metadata write is invisible to sync forever: an app
        // that registers a record and derives its dimensions a moment later
        // ships the record in whatever round falls between the two, and no
        // later round ever offers it again.
        //
        // `version` deliberately stays put. It counts revisions of the record,
        // and a derived fact arriving is not a new revision of anything.
        //
        // Ordered after the metadata write so a failure retries the half that
        // matters: a lost metadata write is repaired by the next write, while a
        // lost bump leaves nothing that knows the record is owed.
        //
        // **The sync apply path must not come through here.** It writes
        // metadata through the adapter directly, and bumping there would make
        // every applied row a fresh change to ship back — two nodes trading one
        // record forever.
        const existing = await databaseAdapter.get(row.recordId);
        if (!existing) return;
        const touched: DataRecord = { ...existing, updatedAt: clock.now() };
        await databaseAdapter.put(touched);
        logChange(touched);
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
          const problem = validateLabelWrite({ key: e.key, value: e.value ?? "" });
          if (problem) throw new Error(problem);
        }

        // Every label needs its record's type, denormalized onto the row.
        const recordTypes = await loadRecordTypes(entries.map((e) => e.recordId));

        // Deduped by (recordId, key, value) — `value` included, because it is
        // in the primary key and two values of one key are two rows. A chunk is
        // one multi-row upsert, and Postgres/DSQL rejects one that touches the
        // same row twice while SQLite quietly keeps the last — so an undeduped
        // repeat is a batch that works locally and 500s in the cloud.
        const rows = dedupeLabelWrites(entries).map((e) => {
          const recordType = recordTypes.get(e.recordId);
          if (recordType === undefined) {
            // No FK backs record_id, so without this the write would create
            // an orphan silently.
            throw new Error(`Cannot label record ${e.recordId}: it does not exist`);
          }
          return { recordId: e.recordId, key: e.key, value: e.value ?? "", recordType };
        });

        // DSQL caps a transaction at 3,000 modified rows, so the chunk is a
        // count of *rows* — one record can now contribute many, and chunking on
        // records would blow the cap on a batch that looked small. Chunks are
        // not atomic with each other; the upsert being idempotent is what makes
        // a partial failure safe to retry from the beginning.
        const hlc = clock.now();
        for (let i = 0; i < rows.length; i += LABEL_WRITE_CHUNK) {
          await databaseAdapter.upsertLabels(
            rows.slice(i, i + LABEL_WRITE_CHUNK).map((r) => ({ ...r, appId, hlc })),
          );
        }
        logLabelChange(rows.map((r) => r.recordId));
      },

      async replaceLabelValues(appId, entries) {
        if (entries.length === 0) return;

        for (const e of entries) {
          // An empty `values` is legal — it is how a key is cleared — so the
          // key still has to be validated on its own when there is nothing to
          // validate it alongside.
          if (!isValidLabelKey(e.key)) throw new Error(`invalid label key "${e.key}"`);
          for (const value of e.values) {
            const problem = validateLabelWrite({ key: e.key, value });
            if (problem) throw new Error(problem);
          }
          const distinct = new Set(e.values).size;
          if (distinct > LABEL_VALUES_PER_KEY_MAX) {
            throw new Error(
              `${distinct} values for key "${e.key}" on record "${e.recordId}", ` +
                `over the ${LABEL_VALUES_PER_KEY_MAX}-value limit`,
            );
          }
        }

        const recordTypes = await loadRecordTypes(entries.map((e) => e.recordId));

        // One replacement per (record, key) — each is atomic in the adapter,
        // and they are not atomic with each other, same as a chunked setLabels.
        // Deduped on distinct values: a repeat is the same row, and the upsert
        // half cannot touch one row twice on DSQL.
        const hlc = clock.now();
        const replacements = entries.map((e) => {
          const recordType = recordTypes.get(e.recordId);
          if (recordType === undefined) {
            throw new Error(`Cannot label record ${e.recordId}: it does not exist`);
          }
          return {
            recordId: e.recordId,
            appId,
            key: e.key,
            values: [...new Set(e.values)],
            recordType,
            hlc,
          };
        });
        await databaseAdapter.replaceLabelValues(replacements);
        logLabelChange(replacements.map((r) => r.recordId));
      },

      async retractLabels(appId, entries) {
        if (entries.length === 0) return;
        for (const e of entries) {
          if (!isValidLabelKey(e.key)) throw new Error(`invalid label key "${e.key}"`);
        }
        // Deliberately no record-existence check: retracting a label on a
        // deleted record is a no-op, not an error.
        //
        // `value` is passed through as-is, undefined included — that is the
        // "retract every value of this key" form, and defaulting it to `""`
        // here would silently narrow it to the bare flag alone.
        const hlc = clock.now();
        for (let i = 0; i < entries.length; i += LABEL_WRITE_CHUNK) {
          await databaseAdapter.retractLabels(
            entries.slice(i, i + LABEL_WRITE_CHUNK).map((e) => ({
              recordId: e.recordId,
              key: e.key,
              value: e.value,
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
      await ownClock?.close();
      await databaseAdapter.close();
      await objectStorageAdapter.close();
    },
  };
}
