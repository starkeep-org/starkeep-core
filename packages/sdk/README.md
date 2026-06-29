# @starkeep/sdk

Host-side facade that wires the Starkeep data plane together: record + file
operations, per-category metadata, search, the shared-space API surface, and the
HLC clock / change notifier that the local-data-server shares with its sync
supervisor. It runs the **local** side against a SQLite database adapter and a
filesystem/S3 object-storage adapter; the cloud-data-server is a separate
artifact and does not use this package.

## Usage

```ts
import { createStarkeepSdk } from "@starkeep/sdk";

const sdk = await createStarkeepSdk({
  databaseAdapter: localDatabaseAdapter,   // e.g. SqliteDatabaseAdapter
  objectStorageAdapter: localObjectStorage, // e.g. FsObjectStorageAdapter
  nodeId: "device-abc",                     // unique per replica; seeds the HLC clock
  // Optional:
  // syncStateStore,   // persists/seeds the HLC clock state across restarts
  // changeNotifier,   // inject to share one notifier with sibling components
  // getAppSpecific,   // factory for per-app app-specific operations
  // clock,            // inject a custom HLC clock
});

// Write a shared record from in-memory bytes. `type` is a canonical
// `<category>/<format>` Starkeep type id (e.g. "image/jpeg"); the SDK computes
// the content hash, the content-addressed object key, size, and mime type.
const record = await sdk.data.putWithFile(
  { type: "image/jpeg", originAppId: "photos" },
  fileBytes,
  "image/jpeg",
);

// Or register a blob already uploaded out-of-band (e.g. via a presigned PUT):
await sdk.data.putWithExistingBlob(
  { type: "image/jpeg", originAppId: "photos" },
  { contentHash, objectStorageKey, sizeBytes, mimeType: "image/jpeg" },
);

const fetched = await sdk.data.get(record.id);
await sdk.data.delete(record.id);

// Per-category metadata (deterministically derivable from the file bytes).
// Keyed by category — "image" here. The `other` category has no metadata table.
await sdk.data.putMetadata("image", { recordId: record.id, width: 800, height: 600 });
const meta = await sdk.data.getMetadata("image", record.id);

// Search across records.
const result = await sdk.index.search({ types: ["image/jpeg"], limit: 20 });
console.log(result.items);

// Shared-space API surface (used by the local-data-server's HTTP routes).
const response = await sdk.api.handleRequest({
  path: "/data/records",
  method: "GET",
  subject: { subjectType: "app", subjectId: "photos" },
});

// React to writes (the supervisor forwards sync events onto the same channel).
const unsubscribe = sdk.changeNotifier.subscribe((event) => {
  console.log(event.eventType, event.recordIds);
});

await sdk.close();
```

> Access enforcement is **not** performed by this package. The local-data-server
> gates each request by the calling app's grants before it reaches the SDK; the
> cloud-data-server enforces independently. The SDK operates on whatever adapter
> it is handed.

## API

### Factory

| Function | Description |
|---|---|
| `createStarkeepSdk(options)` | Async. Initializes the adapters and returns a `StarkeepSdk`. |

### `StarkeepSdk`

| Member | Description |
|---|---|
| `data` | `DataOperations` — `putWithFile`, `putWithLocalFile`, `putWithExistingBlob`, `get`, `update`, `delete`, `query`, and per-category `putMetadata` / `getMetadata` / `getMetadataByIds` |
| `index` | `IndexOperations` — `search(query)` over records, returning `{ items }` |
| `api` | `ApiOperations` — `router`, `handleRequest`, `handleWebSocketConnect` for the shared-space API |
| `changeNotifier` | `ChangeNotifier` — emits `local-change-recorded` on every write; the sync supervisor forwards its events onto the same channel |
| `clock` | `HLCClock` — the clock backing this SDK, exposed so the supervisor can share it |
| `close()` | Flush pending clock state and close the adapters |

### `StarkeepSdkOptions`

| Option | Required | Description |
|---|---|---|
| `databaseAdapter` | Yes | Local database adapter |
| `objectStorageAdapter` | Yes | Local object-storage adapter |
| `nodeId` | Yes | Unique replica id; seeds the HLC clock |
| `clock` | No | Inject a custom `HLCClock` instead of constructing one |
| `syncStateStore` | No | Used only to seed and persist HLC clock state across restarts |
| `changeNotifier` | No | Inject a shared notifier; one is created when omitted |
| `getAppSpecific` | No | Factory for the app-scoped app-specific operations exposed on the API context |

### Re-exported types

For convenience the SDK re-exports from `@starkeep/protocol-primitives`:
`StarkeepId`, `DataRecord`, `HLCTimestamp`, `CreateDataRecordInput`.

## Testing

```bash
pnpm --filter @starkeep/sdk test
```
