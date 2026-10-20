# @starkeep/sync-engine

Cross-cutting sync engine for Starkeep: a single `exchange()` round performs a per-`nodeId` HLC version-vector exchange between a local node and a peer (the cloud data server in production; an in-process peer in tests), transferring shared records and app-specific rows together with their blobs.

The package is data-kind-aware: shared data (always file-backed, no owning app) and app-specific data (owned by exactly one app, optionally file-backed) flow as two first-class streams on each side. Conflict resolution is pure HLC last-write-wins.

Rows travel ahead of their files. Each receiver keeps two watermarks per author: a rows watermark and a bytes watermark, which says every file it wants up to that point is in its storage. A responder reports both, so a requester uploads the files the responder says it lacks, and downloads the files it lacks itself. A failed transfer holds only the affected author's bytes watermark, so rows keep flowing and the next round retries the file.

See `starkeep-core/meta-docs/docs/functional-doc-data-sync-2026-06-08.md` for the full functional description.

## Installation

```bash
pnpm add @starkeep/sync-engine
```

## Usage

```ts
import {
  createSyncEngine,
  createInProcessSyncTransport,
  createSqliteSyncStateStore,
} from "@starkeep/sync-engine";

const transport = createInProcessSyncTransport({
  databaseAdapter: peerDatabase,
  objectStorage: peerStorage,
  clock: peerClock,
  // Channel split: true (default) handles shared records; false handles a
  // single app's app-specific rows via `appSyncableSource`.
  syncSharedRecords: true,
});

const syncEngine = createSyncEngine({
  localDatabaseAdapter: localDatabase,
  localObjectStorage: localStorage,
  transport,
  clock: localClock,
  syncState: createSqliteSyncStateStore(sqliteDb),
  // Optional: omit for the always-on Drive channel; set for a per-app channel.
  // appSyncableSource: { namespaces, applier },
  // syncSharedRecords: true,
});

// Run one exchange round. The supervisor calls this on its schedule; if
// result.hasMore is true the supervisor schedules another round immediately.
const result = await syncEngine.exchange();
console.log(result.shipped, "shipped,", result.applied, "applied, hasMore:", result.hasMore);

// Subscribe to change notifications.
const unsubscribe = syncEngine.changeNotifier.subscribe((event) => {
  // event.type: "remote-update-available" | "local-data-synced" | "local-change-recorded"
  console.log(event.type, event.recordIds);
});
```

## API surface

### Factory functions

| Function                                | Description                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSyncEngine(options)`             | Creates a `SyncEngine` exposing `exchange()` and `changeNotifier`.                                                                                                        |
| `createInProcessSyncTransport(options)` | Responder-side `SyncTransport` that calls a peer `DatabaseAdapter` directly. Used in tests and for in-process peers.                                                      |
| `createHttpSyncTransport(options)`      | Client-side `SyncTransport` that POSTs to `${baseUrl}/sync/exchange`.                                                                                                     |
| `createHttpSyncHandler(options)`        | Request handler for the responder side; handles `POST /sync/exchange` and `/files/:key` (`HEAD`/`GET`/`PUT`/`DELETE`).                                                    |
| `createChangeNotifier()`                | Standalone synchronous in-memory pub/sub over `ChangeEvent`s.                                                                                                             |
| `createFileSyncEngine()`                | Wraps an `ObjectStorageAdapter` with `transferFile` (in-flight dedupe + destination short-circuit).                                                                       |
| `createSqliteSyncStateStore(db)`        | Built-in `SyncStateStore` over `node:sqlite`; persists rows and bytes watermarks, the peer's of both, repair floors, and HLC clock state.                                 |
| `createMemoryByteCoverageStore()`       | In-memory `ByteCoverageStore`, the in-process responder's default home for its own bytes watermark. A responder that builds a transport per request passes a durable one. |

### `SyncEngine`

| Member           | Description                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exchange()`     | Run one version-vector exchange round. Returns `ExchangeResult` with row counts, file counts in each direction, and `hasMore` / `outboundHasMore` / `bytesHasMore`.                                             |
| `changeNotifier` | The engine's `ChangeNotifier`. Emits `local-data-synced` once a round's rows are applied, then again, at most once a second, as files land; callers emit `remote-update-available` and `local-change-recorded`. |

### Watermark helpers

| Function                        | Description                                                   |
| ------------------------------- | ------------------------------------------------------------- |
| `advanceWatermark(w, hlc)`      | Max-per-`nodeId` advance.                                     |
| `mergeWatermarks(a, b)`         | Per-`nodeId` max merge.                                       |
| `watermarkFor(w, nodeId)`       | Lookup with default.                                          |
| `selectUnseen(items, w, hlcOf)` | Filter to items whose HLC exceeds the per-`nodeId` watermark. |

### Residency

| Function                                               | Description                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `residencyOf(row, localStorage, decide?, wasEvicted?)` | Canonical derivation. Returns the state **and** the policy reason behind it. |
| `RecordResidency` (type)                               | `Absent` / `Staged` / `Elided` / `Evicted` / `Resident` / `Tombstoned`.      |
| `RecordResidencyState` (type)                          | `{ state, reason }` — the reason distinguishes "arriving" from "queued".     |

### Key types

| Type                                                                    | Description                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SyncEngineOptions`                                                     | Local DB adapter, local object storage, transport, clock, optional `syncState`, `appSyncableSource`, `syncSharedRecords` (default `true`), `maxBytes` (default 25 MB), `maxItems` (default 1000), `transferConcurrency` (default 4). |
| `SyncTransport`                                                         | `{ exchange(request) }`.                                                                                                                                                                                                             |
| `SyncExchangeRequest` / `SyncExchangeResponse`                          | Wire shape: `watermarks`, `records?` (shared), `appSyncableRows?` (app-specific), `limit?` / `hasMore`, and the responder's `responderWatermarks` and `responderByteWatermarks`.                                                     |
| `ExchangeResult`                                                        | Row counts (`applied`, `shipped`), file counts (`landed`, `uploaded`, and bytes of each), `elided`, `blocked`, `progressed`, and the three `…HasMore` signals.                                                                       |
| `ByteCoverageStore`                                                     | Where a responder keeps its own bytes watermark between exchanges.                                                                                                                                                                   |
| `Watermarks`                                                            | Per-`nodeId` HLC map.                                                                                                                                                                                                                |
| `AppSyncableNamespace` / `AppSyncableNamespaceStore`                    | App table descriptors.                                                                                                                                                                                                               |
| `AppSyncableApplier` / `ScanCapableApplier`                             | Apply incoming rows; scan local rows by HLC.                                                                                                                                                                                         |
| `AppSyncableRowEntry`                                                   | `{ appId, table, op, row, timestamp }`.                                                                                                                                                                                              |
| `FileRecordRow`                                                         | Row shape for the reserved file-backed app table `_starkeep_sync_records`.                                                                                                                                                           |
| `FileSyncEngine` / `FileSyncManifest` / `FileEntry`                     | Blob transfer surface.                                                                                                                                                                                                               |
| `ChangeEvent` / `ChangeEventType` / `ChangeListener` / `ChangeNotifier` | Pub/sub types. Event types: `"remote-update-available"`, `"local-data-synced"`, `"local-change-recorded"`.                                                                                                                           |
| `SyncStateStore`                                                        | Watermark (rows and bytes, own and peer) + repair floors + HLC clock persistence interface.                                                                                                                                          |

### Errors

| Error       | Description                                                  |
| ----------- | ------------------------------------------------------------ |
| `SyncError` | General sync operation failure (e.g. non-2xx HTTP response). |

## Testing

```bash
pnpm --filter @starkeep/sync-engine test
```
