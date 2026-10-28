---
"@starkeep/storage-sqlite": minor
---

The code that creates an app's syncable tables from its manifest moves here from admin-installer, so a phone can run it. `createAppSyncableTables`, `createReservedFileRecordsTable`, `appSyncableNamespaceTables` and `registerAppSyncableNamespace` are exported, with the `AppSyncableDeclaration` and `SyncableTableDeclaration` types.
