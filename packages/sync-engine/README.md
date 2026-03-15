# @starkeep/sync-engine

Bidirectional sync between local and remote storage with change logging, HLC-based conflict resolution, file transfer, and real-time change notifications.

## Installation

```bash
pnpm add @starkeep/sync-engine
```

## Usage

```ts
import { createSyncEngine } from "@starkeep/sync-engine";

const syncEngine = createSyncEngine({
  localDatabaseAdapter: localDatabase,
  remoteDatabaseAdapter: remoteDatabase,
  localObjectStorage: localStorage,
  remoteObjectStorage: remoteStorage,
  clock: hybridLogicalClock,
});

// Record a local change
await syncEngine.recordChange("create", dataRecord);

// Pull remote changes
const pullResponse = await syncEngine.pull();
console.log(pullResponse.changes.length, "changes pulled");

// Push local changes
const pushResponse = await syncEngine.push();
console.log(pushResponse.accepted.length, "changes pushed");
console.log(pushResponse.conflicts.length, "conflicts resolved");

// Full bidirectional sync
const syncResult = await syncEngine.fullSync();
console.log(syncResult.pulled, syncResult.pushed, syncResult.conflicts);

// Subscribe to change notifications
const unsubscribe = syncEngine.changeNotifier.subscribe((changeEvent) => {
  console.log(changeEvent.eventType, changeEvent.recordIds);
});
```

### Using individual components

```ts
import {
  createChangeLog,
  createChangeNotifier,
  createFileSyncEngine,
  resolveConflict,
} from "@starkeep/sync-engine";

// Standalone change log
const changeLog = createChangeLog(databaseAdapter);
await changeLog.append({ recordId, operation: "update", timestamp, recordSnapshot });
const recentChanges = await changeLog.getChangesSince(lastSyncTimestamp);

// Conflict resolution
const resolution = resolveConflict(localChange, remoteChange);
console.log(resolution.winner); // "local" or "remote"

// Change notifications
const changeNotifier = createChangeNotifier();
const unsubscribe = changeNotifier.subscribe((event) => { /* ... */ });
changeNotifier.emit({ eventType: "remote-update-available", recordIds, timestamp });

// File sync engine
const fileSyncEngine = createFileSyncEngine();
const filesToPush = await fileSyncEngine.getFilesToPush(localStorage, remoteStorage, keys);
```

## API

### Factory Functions

| Function | Description |
|---|---|
| `createSyncEngine(options)` | Creates a full `SyncEngine` with change logging, push/pull, and conflict resolution |
| `createChangeLog(databaseAdapter)` | Creates a standalone `ChangeLog` for tracking record mutations |
| `createChangeNotifier()` | Creates a `ChangeNotifier` pub/sub for real-time sync events |
| `createFileSyncEngine()` | Creates a `FileSyncEngine` for diffing and transferring files between storage adapters |
| `resolveConflict(localChange, remoteChange)` | Resolves a conflict between two changes using last-write-wins with HLC |

### `SyncEngine`

| Method | Description |
|---|---|
| `recordChange(operation, record)` | Log a local create/update/delete operation |
| `pull()` | Pull remote changes into local storage |
| `push()` | Push local changes to remote storage |
| `fullSync()` | Run a complete bidirectional sync cycle |
| `changeLog` | Access the underlying `ChangeLog` |
| `changeNotifier` | Access the underlying `ChangeNotifier` |

### Key Types

| Type | Description |
|---|---|
| `SyncEngineOptions` | Configuration: local/remote database adapters, local/remote object storage, HLC clock |
| `ChangeLogEntry` | A logged change with ID, record ID, operation, timestamp, and record snapshot |
| `SyncPullResponse` | Pull result with changes, latest timestamp, and `hasMore` flag |
| `SyncPushResponse` | Push result with accepted IDs, conflicts, and latest timestamp |
| `ConflictResolution` | Resolved conflict with local/remote changes, winner, and resolved record |
| `ChangeEvent` | Notification event: `"remote-update-available"`, `"local-data-synced"`, or `"conflict-detected"` |
| `ChangeListener` | Callback function for `ChangeNotifier.subscribe()` |

### Errors

| Error | Description |
|---|---|
| `SyncError` | General sync operation failure |
| `SyncConflictError` | Unresolvable conflict during sync |

## Testing

```bash
pnpm --filter @starkeep/sync-engine test
```
