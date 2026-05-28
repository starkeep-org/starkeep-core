# Transfer-state-machine follow-ups

Deferred work from the PendingFileUpload / PendingFileDownload sync rework
(plan: `~/.claude/plans/we-discovered-that-file-graceful-octopus.md`).

## Server-side upload confirmation (Q1 gap)

Today the cloud server has no direct signal when a presigned-PUT upload
completes. Blob arrival is discovered only on the next pull, via the lazy
`storage.has(key)` check in
`packages/sync-engine/src/transports/in-process-transport.ts::pullChanges`.

If no pull happens after an upload, the server's record stays in
`PendingFileDownload` indefinitely, and downstream clients can't see it. The
sender sees `Synced` locally as soon as its own PUT returns 2xx, so the
sender and server state machines temporarily disagree.

Close the loop with one of:

- Explicit confirm endpoint: client calls
  `POST /apps/{appId}/files/{key}/confirm` from `HttpObjectStorageAdapter.put`
  after the S3 PUT returns 2xx. Server verifies blob presence and flips
  matching `PendingFileDownload` records to `Synced`.
- S3 event notifications → Lambda that updates matching records.

Either way, the lazy flip on pull remains as a safety net.

## Drop the optional `objectStorage` on InProcessTransportOptions (Q4 cleanup)

### Guiding principle

Don't make things conditionally optional just to accommodate tests. If a
production code path takes a dependency, tests should supply it (a mock is
fine) or omit assertions they can't fairly make in the test environment.
Optional-in-tests-only branches cause production and test paths to diverge
and hide bugs.

### Changes to make

`InProcessTransportOptions.objectStorage` is currently optional. Cloud-data-server
always passes it; the in-process test setups
(`sync-engine.test.ts::createTestSetup`, `two-client-occ.test.ts::makeWorld`)
don't. As a result the transport has a conditional that splits production
behaviour from test behaviour — exactly the divergence the guiding principle
above forbids.

Plan:

- Make `objectStorage` required on `InProcessTransportOptions` and remove the
  `if (objectStorage)` branches in `pullChanges` / `pushChanges`.
- Update the two test helpers to pass their existing `remoteObjectStorage` /
  `cloudObj` as `objectStorage`.
- Migrate the tests that relied on the unfiltered path. Where the test can
  legitimately stage a blob in the mock, do so. Where the assertion isn't
  fairly testable in the in-process setup, drop it rather than reinstate the
  conditional.

## Deferred: app-specific file sync via reserved bookkeeping table

Originally task #8 in the implementation. Substantial second pass; landed the
core fix without it so the change wouldn't balloon.

Goal: apps that declare `filesEnabled: true` in their `AppSyncableNamespace`
get a framework-owned reserved bookkeeping table in the app's namespace.
Proposed name: **`_starkeep_file_records`**.

Scope:

- Same column shape as `shared_records` (id, sync_status, version,
  object_storage_key, content_hash, mime_type, size_bytes, original_filename,
  origin_app_id, created_at, updated_at, deleted_at).
- The sync engine — not the app — writes this table during transfer flows.
  Apps treat it as read-only metadata. App code may reference it to filter
  UIs (e.g. don't render files whose `sync_status` is `pendingFileDownload`).
- The generic transfer scanner in `sync-engine.ts::runFileTransferPass`
  iterates this table the same way it iterates `shared_records`, applying
  identical state transitions.
- Object-storage keys for these records use the existing
  `apps/<appId>/syncable/<subKey>` namespace (object-keys.ts:18-41).

Files involved:

- `packages/sdk/src/sdk.ts` — `filesEnabled: true` apps register the reserved
  table.
- `packages/shared-space-api/src/app-syncable/factory.ts` — namespace
  declaration / wiring.
- `packages/storage-sqlite/src/schema/bootstrap.ts` (and the postgres
  counterpart on the cloud side) — table creation when an app with
  `filesEnabled` is registered.
- `packages/sync-engine/src/sync-engine.ts::runFileTransferPass` — extend to
  scan reserved tables across all registered app-syncable namespaces, not
  just `shared_records`.
- Replace the existing `listAppSyncableFiles` inline pull/push code paths in
  `sync-engine.ts` with the unified scanner once the reserved table is
  populated.

Acceptance:

- An app with `filesEnabled: true` syncs a file end-to-end through
  `_starkeep_file_records` using the same state machine as shared data.
- The legacy inline `listAppSyncableFiles` paths are removed.

## Remaining inline-upload sites in the photos app

Fixed the main `POST /api/photos` path to use presigned PUT + key-ref form
of `POST /data/records`. The cloud-data-server still accepts the inline
`fileBase64` form (backwards-compat) but it should not be used for any
caller-supplied photo, since API Gateway will 413 anything above ~7 MB.

Remaining inline-upload sites that will hit the same cap once payloads
grow:

- `starkeep-apps/photos/infra/src/resize-handler.ts:126` — Lambda resize
  handler posts thumbnails back via `fileBase64`.
- `starkeep-apps/photos/app/api/resize/route.ts:103` — Next resize route.
- `starkeep-apps/photos/app/api/photos/crop/route.ts:65` — crop endpoint.
- `starkeep-apps/photos/app/api/photos/style-graphic/route.ts` — style
  graphic upload (server side).
- `starkeep-apps/photos/src/photos-ui/hooks/use-style-graphic.ts` — style
  graphic upload (client side, browser).
- `starkeep-apps/photos/src/lib/data-server-client.ts:88` — alternative
  upload helper using `btoa` from the browser. Confirm whether this is
  reachable from a user flow; if so, migrate to the same presigned path.

All of these should migrate to: hash → presign PUT → S3 PUT → POST
`/data/records` with `{ contentHash, sizeBytes }` (key-ref form).

Once every caller has moved off the inline form, **delete the `fileBase64`
body shape from both servers**:

- `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`
  — remove the `fileBase64` branch in `POST /data/records`.
- `apps/local-data-server/server.ts` — remove the `fileBase64` branch in
  `POST /data/records`.

The `filePath` shape on local-data-server stays — it's a legitimate
same-machine optimization (caller hands over a disk path and the server
reads it directly, no HTTP byte transfer).

We aren't in production yet, so no migration / backward-compat is required:
delete the old shape outright once nothing reaches for it.

## Observability for stuck PendingFileDownload

Per the original plan, structured log lines on state transitions plus
counters for records sitting in non-terminal states (on both client and
server) so the stuck case is visible.

## Pre-existing test failures (unrelated to this change)

Confirmed by stashing all my edits and re-running tests.

- `@starkeep/admin-core` — tests fail to import `../src/quick-create` and
  `../src/self-hosted-deploy-policy` (files missing from `src/`).
- `@starkeep/admin-manifest`, `@starkeep/admin-shared`,
  `@starkeep/admin-providers` — no test files; vitest exits with code 1.
- `@starkeep/storage-aurora-dsql` — query-builder tests expect `SELECT * FROM
  records` but the implementation emits `SELECT * FROM shared.records` (20
  failures, all the same root cause).

None of these are touched by the transfer-state-machine work; they should be
addressed independently.
