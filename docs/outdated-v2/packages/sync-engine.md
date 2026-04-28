# @starkeep/sync-engine

Bidirectional sync between local storage (SQLite + filesystem) and cloud storage
(Aurora DSQL + S3). Uses Hybrid Logical Clocks for conflict resolution and content
hashes for efficient file transfer.

Access through the SDK as `sdk.sync` (only available when remote adapters are configured).

## Running sync

```typescript
// Full bidirectional sync
const result = await sdk.sync.fullSync()
console.log(`pulled: ${result.pulled}, pushed: ${result.pushed}, conflicts: ${result.conflicts}`)

// Directional sync
await sdk.sync.pull()   // fetch remote changes only
await sdk.sync.push()   // send local changes only
```

## Listening for updates

Subscribe to sync events to update the UI when remote changes arrive:

```typescript
const unsubscribe = sdk.sync.onUpdate((event) => {
  switch (event.eventType) {
    case "remote-update-available":
      // New data pulled from cloud — refresh the UI
      console.log("Updated records:", event.recordIds)
      break
    case "local-data-synced":
      // Local changes confirmed pushed to cloud
      break
    case "conflict-detected":
      // A conflict was detected and resolved
      break
  }
})

// Later:
unsubscribe()
```

## How conflict resolution works

When the same record is modified both locally and remotely before a sync:

1. Both versions are compared by their HLC timestamps
2. The version with the later timestamp wins (last-writer-wins)
3. The losing version is recorded as a `ConflictResolution` for auditing
4. A `conflict-detected` event is emitted

Because HLC timestamps incorporate a node ID, every pair of timestamps has a deterministic
total order — there are no true ties.

## How file sync works

Files are synced by content hash (SHA-256):

1. Compare local and remote file manifests
2. Transfer only files whose hash doesn't exist at the destination
3. Because storage is content-addressed, re-creating a file locally doesn't re-upload it
   if the same content already exists in the cloud

## Change log

Every local mutation is appended to a change log:

```typescript
sdk.sync.changeLog.getEntries(since?)          // entries since a timestamp
sdk.sync.changeLog.getEntriesForRecord(id)     // all changes for a record
```

Change log entries include the operation (`create`, `update`, `delete`), a snapshot of
the record at the time of the change, and the HLC timestamp.
