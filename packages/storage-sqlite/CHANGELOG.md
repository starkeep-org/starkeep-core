# @starkeep/storage-sqlite

## 0.6.0

### Minor Changes

- 18b7a5f: The code that creates an app's syncable tables from its manifest moves here from admin-installer, so a phone can run it. `createAppSyncableTables`, `createReservedFileRecordsTable`, `appSyncableNamespaceTables` and `registerAppSyncableNamespace` are exported, with the `AppSyncableDeclaration` and `SyncableTableDeclaration` types.

### Patch Changes

- Updated dependencies [18b7a5f]
  - @starkeep/protocol-primitives@0.7.0
  - @starkeep/shared-space-api@0.6.2
  - @starkeep/storage-adapter@0.7.1

## 0.5.3

### Patch Changes

- @starkeep/shared-space-api@0.6.1

## 0.5.2

### Patch Changes

- Updated dependencies [fcd80e9]
  - @starkeep/protocol-primitives@0.6.0
  - @starkeep/storage-adapter@0.7.0
  - @starkeep/shared-space-api@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [e362220]
  - @starkeep/storage-adapter@0.6.0
  - @starkeep/shared-space-api@0.5.1

## 0.5.0

### Minor Changes

- Publish the engine changes made since the 0.4 package set (2026-08-02) and the 0.3 set (2026-07-29), which went unpublished: sync in bounded rounds with a delta scan, and the residency fixes; content-addressed shared records keyed on parent, filename and hash; metadata that syncs with its record; the shared query grammar; stand-ins and the reduced storage settings; record deletion, the deleted feed and blob reclamation; rows that travel ahead of their files; and per-user object keys, user-scoped cloud statements and device sign-in. Most of these change the wire format or the stored layout, so every node must run this set together.

### Patch Changes

- Updated dependencies
  - @starkeep/protocol-primitives@0.5.0
  - @starkeep/storage-adapter@0.5.0
  - @starkeep/shared-space-api@0.5.0
