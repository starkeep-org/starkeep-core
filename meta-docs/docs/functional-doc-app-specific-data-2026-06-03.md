# Functional review — app-specific data — 2026-06-03

# Part 1 — Current state

## Overview

App-specific data is the data an installed app keeps **for itself**: its own row tables (a tag taxonomy, layout preferences, captions on a photo) and, optionally, its own files (an app-private blob the user never sees as a "Starkeep item"). It is the deliberate counterpart to shared data: where shared data is typed by the platform, addressable across apps, and outlives uninstall, app-specific data is named by the app, invisible to other apps, and torn down on uninstall *at the location where the uninstall happened*. The two live in structurally separate namespaces — different schemas, different SQLite table prefixes, different object-storage prefixes — so the isolation is enforced by *where the bytes live*, not by convention.

The rest of Part 1 walks the concepts in roughly the order an app meets them: what counts as app-specific data at all; how an app declares it; the namespace and isolation rules; the on-disk storage model in the cloud and locally; how the data is indexed for both reads and pull-based sync; the install/uninstall lifecycle at a single location; and the sync semantics that move app-specific data between locations of the same app.

## Defining app-specific data

The top-level split in the platform's data model is **shared data vs. app-specific data**, and the boundary is operational rather than heuristic: shared data is the user-owned content typed against the platform's hardcoded extension registry and surfaced through `shared.records` and the per-category metadata tables; app-specific data is everything an app keeps under its own appId — its own row tables and, optionally, its own private blobs. An app does not have to decide whether a given piece of state "is shared metadata"; the set of shared-side properties (the records columns, the per-category metadata columns) is fixed upfront by the platform, and anything outside that set is app-specific by construction.

Two shapes of app-specific data exist:

- **App-syncable row tables.** Schemaful per-app tables the app freely reads and writes. This is the main case.
- **App-syncable files** (optional). An app may opt in to a private object-storage prefix and write blobs there. The platform tracks these blobs in a framework-owned bookkeeping table (see "Storage model" below). This is the only case where app-specific *file* bytes exist; apps that don't opt in have row-only app-specific data.

## Declaration: the manifest opt-in

An app declares its app-specific data in `infraRequirements.appSpecificSyncable` in its manifest (`packages/admin-manifest/src/schema.ts`, `appSpecificSyncableSchema`). The block has two fields:

- `tables` — zero or more table definitions. Each table has a snake-case name and a list of typed columns (`text | integer | real | blob | boolean`, optional `notNull`, optional `primaryKey`). Manifest validation rejects two reserved column names — `updated_at` and `deleted_at` — because the runtime appends those itself on every app-syncable table.
- `files` — a boolean opt-in for the `apps/<appId>/syncable/` object-storage prefix. Apps with row-only app-specific data leave this false; only apps that actually need to persist private blobs flip it.

There is no other place an app can declare app-specific data. The manifest **is** the contract: the installer trusts the declared shape and provisions exactly it.

## Namespace and isolation

App-specific data lives in three distinct namespaces, one per storage substrate. All three are derived purely from the app's id, so the isolation is structural:

- **Cloud row tables** live in a PostgreSQL schema named `app_<appId>` (with dashes replaced by underscores, e.g. `app_photos`). Each declared table becomes `app_<appId>."<table>"`.
- **Local row tables** live as flat SQLite tables prefixed `<appId>_syncable_<table>` (dashes → underscores in `appId`). SQLite has no schemas, so the per-app prefix substitutes.
- **Object storage** for apps that opt in to `files: true` is prefixed `apps/<appId>/syncable/`. The key builder is `appSyncableObjectKey()` in `packages/protocol-primitives/src/storage/object-keys.ts`; it strips a redundant leading `apps/<appId>/syncable/` if the caller passed one, rejects subkeys that contain `..` or start with `/`, and rejects appIds with whitespace or `/`. There is no API for an app to write outside its own prefix.

Cross-app access is impossible by construction in each of these substrates:

- In the cloud, the per-app PostgreSQL role granted by install is only granted `SELECT/INSERT/UPDATE/DELETE` on its own `app_<appId>` schema. A second app's role has no GRANT touching it.
- Locally, the per-request `appSpecific` view (`packages/shared-space-api/src/app-syncable/factory.ts`) resolves the calling app from the subject and only constructs operations against that app's namespace; a different app id simply returns `null` from the factory.
- In object storage, the cloud-data-server's key-authorization check (`packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`, ~line 296) requires `apps/<callerAppId>/syncable/...` and rejects any other app's prefix with HTTP 403 ("Forbidden (cross-app syncable key)").

The `apps/<appId>/` parent prefix is reserved exclusively for `apps/<appId>/syncable/` — `system-design.md` calls out that the platform offers no managed non-syncable scratch namespace, so apps that need local-only scratch storage must keep it entirely out of the data plane.

## Storage model

App-syncable row tables follow a uniform shape regardless of substrate. Whatever the app declares in the manifest is the column set; the runtime *appends* two columns to every table:

- `updated_at TEXT NOT NULL` — a serialized Hybrid Logical Clock timestamp. This column is the row's durable change marker (see "Indexing" and "Sync").
- `deleted_at TEXT NULL` — non-null means tombstoned. Deletes are soft so tombstones can propagate via sync.

The cloud DDL is in `packages/admin-installer/src/dsql-ddl.ts` (`runAppInstallDdl`, around line 256–276); the local DDL is in `packages/admin-installer/src/local/registry.ts` (`createAppSyncableTables`, line 178). In both substrates, install also creates `idx_..._updated_at` over `updated_at`.

Apps that set `files: true` get one additional, framework-owned table in their namespace: `_starkeep_sync_records`. The shape is fixed in `packages/shared-space-api/src/app-syncable/reserved.ts` (`FILE_RECORDS_COLUMNS`): `id` (PK, the object-storage key), `object_storage_key`, `content_hash`, `mime_type`, `size_bytes`, `original_filename`, `origin_app_id`, `created_at`, plus the standard `updated_at` + `deleted_at` HLC columns. Apps may not declare a table with this name, and may not write to it directly — `RESERVED_TABLE_NAMES` is enforced by the per-request factory's `resolveTable()` and `validateTableName()` rejects bad identifiers. Conceptually it is the **per-app file index**: one row per blob the app has written, populated by the framework as a side effect of `putFile`/`deleteFile`. Apps treat it as read-only metadata (e.g. for filtering UIs that need to list their own files).

There is no equivalent of `shared.records` for app data: app-syncable rows are not visible to anything outside the owning app's namespace. The per-app PG role is the only identity granted DML on its own tables in the cloud; locally, all access is mediated by the SDK's app-specific view.

## Indexing

App-specific data has two distinct indexing roles, both keyed on `updated_at`:

- **Per-table HLC index for pull scans.** Every app-syncable table is created with an index over `updated_at`. The pull side (both for the sync engine's outbound scan and for the cloud responder's inbound serve) calls `scanSince(appId, table, sinceHlc, { cursor, limit })`, which reads `WHERE updated_at > $sinceHlc ORDER BY updated_at ASC` and paginates by the last row's `updated_at`. The pure HLC sort is sufficient because each row's HLC is unique per node (the originating node's id is embedded in the serialized timestamp), so `updated_at` doubles as a cursor — no tiebreaker column is needed. Implementations: `DsqlAppSyncableApplier.scanSince` and `SqliteAppSyncableApplier.scanSince`.
- **`_starkeep_sync_records` as a per-app file index.** For apps that opted into files, the reserved table indexes the blobs the app has written: it is the only durable handle the system keeps on those files. It rides the same `updated_at` HLC index as any other app-syncable table, so file changes are surfaced to sync through the same pull mechanism row changes are.

There is no other index over app-specific data — no full-text index, no per-app records aggregation, no cross-app rollups. The shared-data `query-orchestrator` package does not look at app-syncable tables, and there is no equivalent unified index on the app-specific side; apps query their own tables directly via `queryRows(table, where)` on the per-request factory, which executes a simple `SELECT * WHERE deleted_at IS NULL AND ...` against the app's storage substrate (`DsqlAppSyncableApplier.queryRows`, `SqliteAppSyncableApplier.queryRows`).

## Install/uninstall lifecycle at a single location

App-specific data comes into existence at install and is torn down at uninstall *at that location only* — other locations of the same app are unaffected. The mechanics of install/uninstall as a whole belong to the install/uninstall topics; this section covers only the app-specific-data slice.

At install, both the cloud (`runAppInstallDdl` in `dsql-ddl.ts`) and the local installer (`installLocal` in `packages/admin-installer/src/local/installer.ts`) do four things for app-specific data:

1. Create each declared app-syncable table with the appended `updated_at`/`deleted_at` columns and the HLC index.
2. If `files: true`, also create the reserved `_starkeep_sync_records` table in the same namespace.
3. Grant the per-app PG role full DML on its own tables (cloud only; local SQLite has no role system).
4. Upsert a row into a namespace registry — `shared.app_syncable_namespaces` in the cloud, the `app_syncable_namespaces` SQLite table locally — whose `tables_json` column carries the full table-name + PK-columns list, plus a `files_enabled` boolean. This registry is what the sync runtime reads to know *which apps and which tables exist* at this location; nothing else does (the per-app PG role is the source of truth for grants; the registry is purely a sync runtime concern).

At uninstall, both sides reverse the same four steps. The local installer (`uninstallLocal` in `local/installer.ts`) is explicit about ordering: revoke access grants, drop app-syncable tables (driven off the registry's table list, so it works even if the manifest is no longer available), invoke the caller-supplied `deleteFilesPrefix(prefix)` to clear `apps/<appId>/syncable/` from object storage, delete the namespace registry row, and delete the app registry row. In the cloud, the analogous steps are split across the install orchestrator and the DDL: the orchestrator's `delete_s3_files` step (`packages/admin-installer/src/orchestrator.ts`) runs first, under the app's own role, and clears the entire `apps/<appId>/` prefix (which, since that prefix is reserved exclusively for `apps/<appId>/syncable/`, is exactly the app-specific blob namespace); then `runAppUninstallDdl` drops the entire `app_<appId>` schema with `CASCADE` — removing every declared table and the reserved file-records table in one statement — and deletes the matching `shared.app_syncable_namespaces` row.

The key invariant — restated from `system-design.md` — is that **uninstall does not delete shared records or shared files anywhere, but it does delete app-specific data at this location**. The app-specific schema/prefix is gone here, but other devices where the app remains installed continue to hold their own copy and continue to sync among themselves.

## Sync (this topic's lens on the cross-cutting sync subtopic)

App-specific data syncs **only between locations of the same app**, never across apps. The general sync engine design (HLC watermarks, contiguous-prefix shipping, blob-before-metadata) is the `data-sync` topic's concern — covered there and in `starkeep-core/docs/sync-engine.md`. The facets specific to app-specific data are:

- **One per-app channel per app, plus the always-on Drive channel.** Under the channel-split layout (`apps/local-data-server/sync-supervisor.ts`), the always-on Drive channel ships shared records and no app-specific rows (`syncSharedRecords: true`, no `appSyncableSource`), and each installed app gets its own per-app channel that ships only its own app-specific rows (`syncSharedRecords: false`, with an `appSyncableSource` narrowed to that one app id). The cloud-data-server routes per-app sync requests under `/apps/<appId>/sync/exchange`. App-specific rows never ride the Drive channel and never appear on a different app's per-app channel.
- **LWW on `updated_at`, no OCC, no change-log outbox.** The applier (cloud and local) uses the HLC `updated_at` directly as the conflict resolver: an INSERT is `INSERT ... ON CONFLICT (pk) DO UPDATE ... WHERE EXCLUDED.updated_at > existing.updated_at`; an UPDATE adds `WHERE updated_at < $incoming`; a DELETE is `UPDATE SET deleted_at, updated_at WHERE updated_at < $incoming OR updated_at IS NULL`. Replaying the same entry is a no-op. There is no separate outbox: the `updated_at` column on each row **is** the change marker, and pull scans synthesize transient entries inline by reading rows in HLC order (the same `scanSince` paths described under "Indexing"). System-design.md spells this out as the inline-HLC pull model.
- **Install gating at the destination.** App-specific rows for an app that isn't installed at the destination are not delivered. The cloud responder rejects writes whose `appId` is not present in `shared.app_syncable_namespaces`; the local in-process transport silently skips rows whose `appId` resolves to no namespace; the sync-engine apply path throws when the applier reports the app is unknown and that error is logged. This is the structural reason app-specific data "syncs only between instances of the same app": even if a peer over-shipped, the destination has no namespace to write into.
- **Files via the reserved `_starkeep_sync_records` table.** For apps with `files: true`, blob transfers ride the same per-app channel as row changes. A row in `_starkeep_sync_records` is the metadata side of an app-specific blob; the sync engine recognizes the table name (`FILE_RECORDS_TABLE` is hard-mirrored in `sync-engine.ts` to avoid a package cycle) and derives a blob manifest from the row's `object_storage_key` / `content_hash` / `size_bytes` / `mime_type` columns. The shared blob-before-metadata + contiguous-prefix watermark rule covers app-specific blobs uniformly with shared blobs: a failed blob upload halts the rest of that nodeId in the round, and the watermark stays at the gap so the next round retries.
- **No cross-app `nodeId` accounting.** Per-app channels each have their own watermark store (`createPerAppSyncStateStore`). An app's per-app channel watermarks are isolated from the Drive channel's watermarks and from other apps'; the per-app channel only ever advances on rows it actually carries.

## Open questions

- The `_starkeep_sync_records.id` column is the object-storage key (`id: key`), which is also stored in `object_storage_key`. The two columns appear redundant; whether one is intended as the app-facing handle and the other as the storage handle (e.g. to allow renaming an object key while preserving an app's row id) is not stated.

# Part 2 — Review and evaluation

## Questionable purposes

None identified with high confidence.

## Behavior inconsistent with purpose

_(no remaining items)_

## Missing behaviors

_(no remaining items)_

## Behavioral bugs

None identified with high confidence.

## Potential gaps

None identified with high confidence.
