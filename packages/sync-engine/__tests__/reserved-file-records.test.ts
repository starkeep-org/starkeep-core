import { describe, it, expect } from "vitest";
import {
  createHLCClock,
  serializeHLC,
  SyncStatus,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import type {
  AppSyncableApplier,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableRowEntry,
  FileRecordRow,
  FileRecordsApplier,
  ScanCapableApplier,
} from "../src/types.js";

const FILE_RECORDS_TABLE = "_starkeep_sync_records";

/**
 * In-memory app-syncable applier that backs ns.tables with a Map. Suitable
 * only for unit testing the file-records sync state machine — it ignores
 * tables other than `_starkeep_sync_records` to keep the harness focused.
 */
function makeInMemoryAppSource(filesEnabled: boolean): {
  store: Map<string, Map<string, Record<string, unknown>>>;
  namespaces: AppSyncableNamespaceStore;
  applier: AppSyncableApplier & ScanCapableApplier & FileRecordsApplier;
} {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  function tableFor(appId: string): Map<string, Record<string, unknown>> {
    let t = store.get(appId);
    if (!t) {
      t = new Map();
      store.set(appId, t);
    }
    return t;
  }

  const ns: AppSyncableNamespace = {
    appId: "demo-app",
    tables: [{ name: FILE_RECORDS_TABLE, pkColumns: ["id"] }],
    filesEnabled,
    tableNames: [FILE_RECORDS_TABLE],
  };
  const namespaces: AppSyncableNamespaceStore = {
    get(appId) {
      return appId === ns.appId ? ns : null;
    },
    list() {
      return [ns];
    },
  };

  const applier: AppSyncableApplier & ScanCapableApplier & FileRecordsApplier = {
    apply(entry: AppSyncableRowEntry) {
      if (entry.table !== FILE_RECORDS_TABLE) return;
      const t = tableFor(entry.appId);
      if (entry.op === "insert") {
        const row = entry.row ?? {};
        const id = row["id"] as string;
        const existing = t.get(id);
        const incomingTs = row["updated_at"] as string | undefined;
        if (
          existing &&
          incomingTs &&
          (existing["updated_at"] as string) >= incomingTs
        ) {
          return;
        }
        t.set(id, { ...row });
      } else if (entry.op === "update") {
        const where = entry.where ?? {};
        const id = where["id"] as string;
        const existing = t.get(id);
        if (!existing) return;
        const patch = entry.row ?? {};
        const incomingTs = patch["updated_at"] as string | undefined;
        if (incomingTs && (existing["updated_at"] as string) >= incomingTs) {
          return;
        }
        t.set(id, { ...existing, ...patch });
      } else {
        const where = entry.where ?? {};
        const id = where["id"] as string;
        const existing = t.get(id);
        if (!existing) return;
        const ts =
          (entry.row?.["updated_at"] as string) ?? serializeHLC(entry.timestamp);
        t.set(id, { ...existing, deleted_at: ts, updated_at: ts });
      }
    },
    async scanSince(appId, table, sinceHlcStr) {
      if (table !== FILE_RECORDS_TABLE) return [];
      const t = tableFor(appId);
      const out: AppSyncableRowEntry[] = [];
      for (const row of t.values()) {
        const updatedAt = row["updated_at"] as string;
        if (updatedAt > sinceHlcStr) {
          out.push({
            timestamp: { wallTime: 0, counter: 0, nodeId: "stub" },
            appId,
            table,
            op: row["deleted_at"] ? "delete" : "insert",
            row: { ...row },
          });
        }
      }
      return out;
    },
    async scanFileRecordsByStatus(appId, statuses) {
      const t = tableFor(appId);
      const wanted = new Set(statuses);
      const out: FileRecordRow[] = [];
      for (const row of t.values()) {
        if (row["deleted_at"]) continue;
        if (!wanted.has(row["sync_status"] as string)) continue;
        out.push(rowToFileRecord(row));
      }
      return out;
    },
    async setFileRecordStatus(appId, id, status) {
      const t = tableFor(appId);
      const existing = t.get(id);
      if (!existing) return;
      t.set(id, { ...existing, sync_status: status });
    },
  };

  return { store, namespaces, applier };
}

function rowToFileRecord(row: Record<string, unknown>): FileRecordRow {
  return {
    id: row["id"] as string,
    sync_status: row["sync_status"] as string,
    object_storage_key: row["object_storage_key"] as string,
    content_hash: row["content_hash"] as string,
    mime_type: row["mime_type"] as string,
    size_bytes: Number(row["size_bytes"]),
    original_filename: (row["original_filename"] as string | null) ?? null,
    origin_app_id: row["origin_app_id"] as string,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    deleted_at: (row["deleted_at"] as string | null) ?? null,
  };
}

describe("reserved `_starkeep_sync_records` file sync", () => {
  it("two-client flow: producer puts file → server applies → receiver downloads", async () => {
    let t = 1000;
    const tick = () => t++;
    const senderClock = createHLCClock({ nodeId: "sender", wallClockFunction: tick });
    const receiverClock = createHLCClock({ nodeId: "receiver", wallClockFunction: tick });
    const cloudClock = createHLCClock({ nodeId: "cloud", wallClockFunction: tick });

    const senderApp = makeInMemoryAppSource(true);
    const cloudApp = makeInMemoryAppSource(true);
    const receiverApp = makeInMemoryAppSource(true);

    const senderDb = new MockDatabaseAdapter();
    const receiverDb = new MockDatabaseAdapter();
    const cloudDb = new MockDatabaseAdapter();
    await senderDb.init();
    await receiverDb.init();
    await cloudDb.init();

    const senderLocal = new MockObjectStorageAdapter();
    const receiverLocal = new MockObjectStorageAdapter();
    const cloudObj = new MockObjectStorageAdapter();
    await senderLocal.init();
    await receiverLocal.init();
    await cloudObj.init();

    const senderTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      appSyncableSource: { namespaces: cloudApp.namespaces, applier: cloudApp.applier },
      objectStorage: cloudObj,
    });
    const receiverTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      appSyncableSource: { namespaces: cloudApp.namespaces, applier: cloudApp.applier },
      objectStorage: cloudObj,
    });

    const senderEngine = createSyncEngine({
      localDatabaseAdapter: senderDb,
      localObjectStorage: senderLocal,
      remoteObjectStorage: cloudObj,
      transport: senderTransport,
      clock: senderClock,
      appSyncableSource: {
        namespaces: senderApp.namespaces,
        applier: senderApp.applier,
      },
    });
    const receiverEngine = createSyncEngine({
      localDatabaseAdapter: receiverDb,
      localObjectStorage: receiverLocal,
      remoteObjectStorage: cloudObj,
      transport: receiverTransport,
      clock: receiverClock,
      appSyncableSource: {
        namespaces: receiverApp.namespaces,
        applier: receiverApp.applier,
      },
    });

    // Producer-side `putFile` outcome — emulate what factory.ts does: blob in
    // local storage + an _starkeep_sync_records row inserted via the applier.
    const key = "apps/demo-app/syncable/thumbs/cat.png";
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await senderLocal.put(key, bytes, { contentType: "image/png" });

    const ts = senderClock.now();
    const tsStr = serializeHLC(ts);
    senderApp.applier.apply({
      timestamp: ts,
      appId: "demo-app",
      table: FILE_RECORDS_TABLE,
      op: "insert",
      row: {
        id: key,
        sync_status: SyncStatus.PendingFileUpload,
        object_storage_key: key,
        content_hash: "sha256:dummy",
        mime_type: "image/png",
        size_bytes: bytes.byteLength,
        original_filename: null,
        origin_app_id: "demo-app",
        created_at: tsStr,
        updated_at: tsStr,
        deleted_at: null,
      },
    });

    // Push: applier metadata propagates to cloud, then transfer pass uploads
    // the blob and flips sender's row to synced.
    await senderEngine.push();

    expect(cloudApp.store.get("demo-app")?.get(key)).toBeDefined();
    expect(await cloudObj.has(key)).toBe(true);
    expect(senderApp.store.get("demo-app")?.get(key)?.["sync_status"]).toBe(
      SyncStatus.Synced,
    );

    // Receiver pulls: metadata arrives via appSyncableRows, transfer pass
    // downloads the blob and flips status to synced.
    await receiverEngine.pull();

    const receiverRow = receiverApp.store.get("demo-app")?.get(key);
    expect(receiverRow).toBeDefined();
    expect(await receiverLocal.has(key)).toBe(true);
    expect(receiverRow?.["sync_status"]).toBe(SyncStatus.Synced);
  });

  it("does not act on reserved table for apps with filesEnabled=false", async () => {
    const app = makeInMemoryAppSource(false);
    const senderClock = createHLCClock({ nodeId: "sender", wallClockFunction: () => 1 });

    const senderDb = new MockDatabaseAdapter();
    await senderDb.init();
    const senderLocal = new MockObjectStorageAdapter();
    await senderLocal.init();
    const cloudObj = new MockObjectStorageAdapter();
    await cloudObj.init();
    const cloudDb = new MockDatabaseAdapter();
    await cloudDb.init();

    const transport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: senderClock,
      objectStorage: cloudObj,
    });

    const engine = createSyncEngine({
      localDatabaseAdapter: senderDb,
      localObjectStorage: senderLocal,
      remoteObjectStorage: cloudObj,
      transport,
      clock: senderClock,
      appSyncableSource: { namespaces: app.namespaces, applier: app.applier },
    });

    // Seed a row that *would* be in scope if filesEnabled were true.
    app.applier.apply({
      timestamp: senderClock.now(),
      appId: "demo-app",
      table: FILE_RECORDS_TABLE,
      op: "insert",
      row: {
        id: "k",
        sync_status: SyncStatus.PendingFileUpload,
        object_storage_key: "apps/demo-app/syncable/x",
        content_hash: "h",
        mime_type: "m",
        size_bytes: 1,
        original_filename: null,
        origin_app_id: "demo-app",
        created_at: "t",
        updated_at: "t",
        deleted_at: null,
      },
    });

    const result = await engine.runFileTransferPass();
    expect(result.uploaded).toBe(0);
    expect(result.downloaded).toBe(0);
    // sync_status untouched because filesEnabled gate skips the scan.
    expect(app.store.get("demo-app")?.get("k")?.["sync_status"]).toBe(
      SyncStatus.PendingFileUpload,
    );
  });
});
