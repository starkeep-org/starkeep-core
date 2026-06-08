# Functional doc — data-sync (sync engine) — 2026-06-08

Scope: the `@starkeep/sync-engine` package (`packages/sync-engine`). This is the cross-cutting sync engine reused by both local and cloud servers. The doc treats anything outside the package — what calls `exchange()`, how DB adapters are wired, who the apps are, how watchers schedule ticks — as black-box context. Those facets live with their own topics (`local-server-cloud-sync`, `cloud-server-sync`, `app-data-sync`, `shared-data-sync`, `cloud-apps-sync`).

# Part 1 — Current state

## Overview

The data-sync package is a single-purpose library that performs one **version-vector exchange round** between a local Starkeep node and a peer (the cloud data server in production; another in-process node in tests). Each round is symmetric in shape but asymmetric in role: the calling side is the *requester*; the peer is the *responder*. The requester ships data items the peer hasn't seen, receives data items it hasn't seen, transfers any associated blobs alongside the metadata, and persists two updated watermark vectors.

Three things are fundamental to understanding everything else:

1. **What kinds of data are synced** — shared data (always file-backed, no owning app) and app-specific data (owned by exactly one app, optionally file-backed). The two kinds are first-class citizens of the protocol, not implementation variants. See "Kinds of data" immediately below.
2. **How "what to ship" is decided.** Each side stores a per-`nodeId` HLC vector — the watermark. Outbound: scan local rows whose `updated_at.nodeId`'s HLC exceeds the peer's last-known watermark for that node. Inbound: apply received rows whose HLC exceeds the local watermark. Conflict resolution is pure HLC last-write-wins; no rejection list, no OCC.
3. **How partial failures don't corrupt the state.** A blob transfer can fail without invalidating the metadata that announced it. The engine separates "metadata applied" from "watermark advanced" and uses a *contiguous-prefix per nodeId* rule so a single blob failure halts watermark advance on that nodeId for the round, leaving the failed item to be retried next round — but doesn't block other nodeIds.

The package exposes one factory (`createSyncEngine`) producing a `SyncEngine` whose surface is essentially `exchange(): Promise<ExchangeResult>` plus a `changeNotifier` pub/sub. Two transports are provided (`in-process` and `http`); a matching HTTP server handler is provided for the responder side. A SQLite-backed `SyncStateStore` persists watermarks and HLC clock state.

## Kinds of data

Starkeep distinguishes two kinds of data, and the sync engine treats them as two first-class streams that flow through every exchange round:

### Shared data

**Not owned by any app. Always file-backed.**

Shared data is the Starkeep platform's content layer — records that any installed app can read or contribute to subject to permissions, with bytes (the "file") attached to every record. In this package, shared data appears as `AnyRecord` values flowing into and out of `localDatabaseAdapter.put/get/query`. Every shared record carries an `objectStorageKey` (and `contentHash`, `sizeBytes`, `mimeType`); the engine derives a blob manifest from those fields unconditionally for non-tombstoned shared records (`manifestForRecord`, `sync-engine.ts:469`). There is no "metadata-only" shared record at the protocol level.

In the package code, in tests, and in the existing architecture-intent doc you'll see this stream called **SR** (for *shared record*). That's the shorthand; the concept is "shared, always-file-backed data."

### App-specific data

**Owned by exactly one app. Optionally file-backed, per table.**

Each cloud-installed app declares its own tables (PK columns and table name) through an `AppSyncableNamespace` (`types.ts:14`). The engine ships row deltas from those tables as `AppSyncableRowEntry` values — a small wire shape carrying `appId`, `table`, `op` (`insert` | `update` | `delete`), the row, and an HLC `timestamp`. An app's data is exchanged only on its own per-app channel; it is never mixed with another app's data and never with shared data (see "Channel split" below).

Whether an app's row carries a blob is a per-table property:

- **File-backed app tables.** Each app may have rows in a reserved table named `_starkeep_sync_records` whose row shape includes `object_storage_key`, `content_hash`, `size_bytes`, `mime_type`, etc. (`FileRecordRow`, `types.ts:95`). For these rows, the engine derives a manifest from the row's columns (`manifestForAppRow`, `sync-engine.ts:485`) and transfers the blob alongside the metadata, the same way it does for shared data. Tombstones (`op === "delete"`) produce no manifest — blob retention on delete is a GC concern, not a sync concern. In code and tests this stream is called **AR** (for *app record with file*).
- **Metadata-only app tables.** Any other table in the app's namespace is plain row data with no blob. `manifestForAppRow` returns `null` (`sync-engine.ts:486`) and the engine ships only the row. In code and tests this stream is called **AW** (for *app row, no file*).

The choice between the two is not the engine's call: an app decides which of its tables, if any, store files by using the reserved `_starkeep_sync_records` table for them. The engine recognizes the reserved name (it must — only that name triggers the blob-manifest path) but otherwise treats AR and AW identically on the wire.

### Why the distinction matters here

These two kinds of data drive almost every design choice in the package:

- **Channel assignment.** Shared data and app-specific data ride on *separate* channels in the production deployment (see "Channel split" below). The engine doesn't multiplex them in a single channel; instead, the configuration option `syncSharedRecords` selects which one a given engine instance handles.
- **Wire types.** The exchange protocol carries two arrays, never one: `records?: AnyRecord[]` for shared data and `appSyncableRows?: AppSyncableRowEntry[]` for app-specific data (`types.ts:116`). They flow side-by-side in every request and every response.
- **Source of truth on the local side.** Shared records are read via `DatabaseAdapter.query/get/put` against a single global table. App-specific rows are read and written via the caller-provided `AppSyncableApplier` + `AppSyncableNamespaceStore` pair, which knows about per-app schemas. The engine never assumes app-specific tables exist in the same DB as shared records — that wiring is the caller's choice.
- **Blob carrying.** Shared data always implies blob handling. App-specific data implies blob handling only on the `_starkeep_sync_records` table. The contiguous-prefix rule and Staged-residency behavior apply uniformly to both whenever a blob is involved.

## The exchange round

The unit of work is `SyncEngine.exchange()`. One round walks four phases in order (`sync-engine.ts:74`):

1. **Load state.** Read own watermarks (highest HLC the requester has *applied* per nodeId) and peer watermarks (highest HLC the requester has *successfully shipped* to the peer per nodeId) from `SyncStateStore`. With no store configured, both default to `{}`.
2. **Gather outbound candidates.** Cursor-scan two sources:
   - *Shared data*: the local DB via `DatabaseAdapter.query`, filtering to records whose `updatedAt.nodeId` HLC is greater than `peerWatermarks[nodeId]`.
   - *App-specific data*: each app namespace's tables via `ScanCapableApplier.scanSince`, with the same per-nodeId watermark filter applied inline.
   Scans are cursor-paginated so rows past any single page remain reachable on later rounds.
3. **Cap and ship.** The combined outbound set (shared + app-specific) is capped at `pageLimit` (default 1000) by globally-earliest-HLC. Items are then grouped per `nodeId` in HLC order. For each item: if it carries a blob (all shared-data items; app-specific items only from the file-backed reserved table), push the blob to remote storage *before* shipping the metadata; if the blob push fails, stop shipping for that nodeId for the rest of this round (the contiguous-prefix rule). Successfully-shipped items become the request payload to `transport.exchange(...)`.
4. **Receive, apply, advance.** The response carries shared records and app-specific rows the peer believes the requester hasn't seen. Group these per `nodeId`, walk in HLC order, and for each item: apply the metadata (skipping if a local copy at-or-ahead already exists), pull the blob if any, and — only if the *whole* item landed — advance own watermark for that nodeId. Peer watermarks advance past every item received, since the peer demonstrably has each one it sent. Watermarks are persisted at the end of the round, and a `local-data-synced` change event is emitted naming the applied record IDs.

`ExchangeResult` summarizes the round: `{ applied, shipped, hasMore }`. `hasMore` is honest about there being more to drain — callers (typically a supervisor) use it to schedule another round immediately rather than waiting on the next poll.

## Watermarks and what they mean

The watermark vector is the heart of the protocol. Two distinct vectors are kept:

- **Own watermarks** — per `nodeId`, the highest HLC the requester has *durably accepted* from that node. Advanced only when both metadata and blob successfully land locally. Determines which inbound items the requester wants to receive on the next round (anything strictly greater).
- **Peer watermarks** — per `nodeId`, the highest HLC the requester believes the *peer* has accepted from that node. Advanced past every item the requester ships *and* every item the peer ships (the peer cannot ship what it doesn't have). Determines which outbound items the requester needs to send on the next round.

One pair of vectors covers *both* kinds of data on a given channel — there is no separate "shared-data watermark" and "app-data watermark." HLC `nodeId` is the only axis. This is what makes the contiguous-prefix rule (below) able to halt a single nodeId across a mixed shared + app-specific payload uniformly.

The helper module `watermarks.ts` provides the manipulators (`advanceWatermark`, `mergeWatermarks`, `selectUnseen`). The advance rule is "take the max per nodeId"; merging is the same operation.

Two properties fall out of this design:

- **No global "last sync time."** Each nodeId is tracked independently; a node that's been offline for a week is still synced correctly when it returns, without forcing every other node into a re-scan.
- **The watermark is the durable backstop.** If a record's metadata applied but its blob failed to pull, the local row is in **Staged** residency (see below). The own-watermark for that nodeId hasn't moved past it, so the next round's request still asks for it, and the peer still ships it — guaranteeing retry without any persisted `sync_status` flag.

## Per-record residency

Each file-backed record — whether shared or app-specific — has one of four states on each side, derived from facts already on disk. There is no persisted `sync_status` column (`residency.ts`):

- **Absent** — no row for this id.
- **Staged** — row present, blob required by the row, blob not yet local. Watermark *deliberately behind* this record.
- **Resident** — row present and blob present.
- **Tombstoned** — `deleted_at` is set. Propagates like Resident; blob garbage collection is a separate concern (not handled here).

`residencyOf(row, localStorage)` is the single canonical derivation. Callers (tests, residency-aware UI logic) should call it rather than reconstruct the predicate. Metadata-only app rows don't pass through residency at all — their state is "row present" or "row absent," nothing more.

## Blob transfer

`FileSyncEngine` (`file-sync-engine.ts`) is a small object that wraps `ObjectStorageAdapter.put/get/has` with three behaviors the exchange round relies on:

- **In-flight key dedupe.** `transferFile` records the in-flight key in a `Set`; a second call for the same key returns `false` without attempting a second transfer. This matters when ticks overlap.
- **Destination-already-has-it short-circuit.** `transferFile` HEADs the destination first and returns `true` immediately if the blob is there. Callers can fire-and-forget without their own HEAD; cost is at most one HEAD per item per round.
- **Source-missing return false.** A `get` that finds nothing returns `false` (treated as failure by the contiguous-prefix rule), rather than throwing.

`getFilesToPush` / `getFilesToPull` are higher-level "diff and list" helpers — present in the surface but not used by the main `exchange()` path, which derives manifests directly from the carrier (shared record or file-backed app row) being shipped (`manifestForRecord`, `manifestForAppRow`).

A blob manifest is produced only when the carrier actually carries bytes:
- **Shared records**: `objectStorageKey` set and `deletedAt` null — i.e. every live shared record.
- **App-specific rows**: table is exactly `_starkeep_sync_records`, op is `insert`/`update`, and the row has a non-empty `object_storage_key`. Plain (AW) app rows never produce a manifest. Tombstones never produce a manifest.

## Channel split

The `syncSharedRecords` option (`SyncEngineOptions.syncSharedRecords`, default `true`) is the switch that assigns this engine instance to one of the two data kinds. The intended deployment is:

- **One always-on "Drive" channel** carries the *shared-data* stream. Configured with `syncSharedRecords: true` and *no* `appSyncableSource`. It is the only channel that syncs shared records — independent of which apps are cloud-installed. This is what makes shared-data sync behavior identical regardless of installed-app set.
- **One channel per cloud-installed app** carries that app's *app-specific data* stream (both AR and AW for that one app). Configured with `syncSharedRecords: false` and an `appSyncableSource` bound to the app's namespace. It never carries shared data and never carries other apps' data.

The split is enforced on both sides. On the requester, `syncSharedRecords: false` zeroes out the shared-record outbound scan and guards inbound shared records (`sync-engine.ts:263`) so a misbehaving peer can't smuggle them in. On the responder (`in-process-transport.ts:68`), `syncSharedRecords: false` skips both apply and scan of shared records.

The architectural payoff is that the two data kinds remain independent: a user with no apps installed still syncs their shared data; installing an app adds a per-app channel without changing how shared data flows.

## The app-side contract

For app-specific data to flow at all, the engine needs two interfaces from the caller (`types.ts`):

- `AppSyncableNamespaceStore` — enumerates which apps exist and which tables each has (with PK columns). Used by the outbound scan loop to know what tables to read from.
- `AppSyncableApplier` + `ScanCapableApplier` — applies an incoming row (typically an LWW UPSERT into the app's table) and scans local rows via cursor-paginated `scanSince`. The exchange round requires `ScanCapableApplier` for the outbound side; without it, app-specific rows are silently skipped both ways.

The engine treats apps as opaque except via this contract. It doesn't know about app permissions, app-defined schemas, or app migrations — that's the app's responsibility (typically routed through `app-specific-data` and the SDK). It also doesn't know whether a given app table is file-backed except by checking the reserved name `_starkeep_sync_records`.

## Conflict resolution

Pure HLC last-write-wins (`compareHLC` on `updatedAt` for shared records, on `timestamp` for app-specific rows). Order is `(wallTime, counter, nodeId)`; ties on the first two break on the larger `nodeId`. Two consequences:

- **Cross-side identical timestamps cannot occur.** `nodeId` is part of the HLC, so two sides producing the "same time" still order deterministically.
- **No rejected[] list, no OCC retry.** The loser's metadata is silently discarded on apply (the receiver-side guard `current && compareHLC(current.updatedAt, snapshot.updatedAt) >= 0` skips the put). The loser's blob is implicitly orphaned: with content-addressable storage, a real content change produces a new `object_storage_key`, so the winner points at its own bytes and the loser's bytes sit at a key no live row references.

## Pagination and back-pressure

`pageLimit` (default 1000) caps the combined shared + app-specific outbound payload per round and is passed as the inbound `request.limit`. `scanPageSize` (default 500) caps the per-DB-query slice inside the cursor loop, so a small `pageLimit` doesn't force the DB to materialize 500 rows at once.

Both the requester's outbound scan and the in-process responder's scan are O(N) per round in the absence of a watermark-aware index — the code openly flags this as a known performance follow-up (`sync-engine.ts:91`). Acceptable at current poll volumes; the comment is precise about what a production storage adapter ought to push down (`per-nodeId index plus WHERE updated_at > peerWatermark[nodeId]`).

When more remains than fits, the responder sets `SyncExchangeResponse.hasMore: true`. The exchange round propagates this to the caller as `ExchangeResult.hasMore`, and the calling supervisor (outside this package) is expected to schedule another round immediately rather than waiting on the poll interval.

## Transports

A `SyncTransport` is anything with `exchange(request): Promise<response>`. Two are provided:

- **In-process** (`createInProcessSyncTransport`) — calls into a peer-side `DatabaseAdapter` directly. Used in tests and for collapsing both sides into one Node process. Implements the responder-side exchange semantics symmetrically across both kinds of data (HLC LWW apply, per-nodeId watermark scan, `hasMore`).
- **HTTP** (`createHttpSyncTransport`) — POSTs the request to `${baseUrl}/sync/exchange`. Optional `getAuthHeader()` callback supplies an `Authorization` header. Non-2xx responses throw `SyncError`. Wire format is the same `SyncExchangeRequest`/`SyncExchangeResponse` shape, serialized as JSON.

The matching HTTP server handler (`createHttpSyncHandler`) recognizes `POST /sync/exchange` plus a `/files/:key` family for blob `HEAD`/`GET`/`PUT`/`DELETE`. It composes with any host routing layer (returns `true` if it handled the request, `false` otherwise). By default it constructs an in-process transport from its own DB/storage adapters and a clock; an explicit `transport` override is allowed.

The exchange wire shape is intentionally small: `watermarks`, `records?` (shared), `appSyncableRows?` (app-specific), `limit?` request; `records`, `appSyncableRows`, `hasMore` response. No envelope versioning, no per-record acknowledgement, no rejection list.

## Change notifications

`ChangeNotifier` (`change-notifier.ts`) is a synchronous in-memory pub/sub over `ChangeEvent`s. Three event types are declared (`types.ts`):

- `remote-update-available` — emitted by callers (not by the engine itself in this package) when an out-of-band signal says new data is at the peer.
- `local-data-synced` — emitted *by the engine* at the end of an `exchange()` round, naming the record IDs whose metadata was newly applied this round. Blob-retries on already-applied metadata are excluded (those aren't a user-visible data change).
- `local-change-recorded` — emitted by callers when an app or shared-record write happens locally. The optional `originAppId` lets a sync supervisor nudge only the affected per-app channel; for shared-data writes, `originAppId` is left unset because shared data isn't owned by any app.

The engine's responsibility ends at emitting `local-data-synced`. Subscribing, fan-out to UI, and supervisor scheduling all live in the calling environment.

## State persistence

`createSqliteSyncStateStore` is the only built-in `SyncStateStore`. It uses node's built-in `node:sqlite` via a passed-in `DatabaseSync`, stores three JSON blobs in a single `sync_state` table — `watermarks`, `peer_watermarks`, `hlc_clock` — and is created lazily (the table is `CREATE TABLE IF NOT EXISTS`). Callers wanting durability use it; callers happy with in-memory ephemeral state (tests) omit `syncState` and the engine treats both vectors as `{}`.

The HLC clock state is *stored* but not *consumed* by the engine itself — the engine receives an already-constructed `HLCClock` and the persistence is the caller's bookkeeping for clock continuity across restarts.

## Test harness

`__tests__/sync-test-harness/` is a structured-scenario harness purpose-built for this package. It composes a two-side world (`L` / `C`), seeds initial residency, lets a test author script per-side operations, and asserts post-round residency. The data-kind distinction is baked into the harness vocabulary: tests are labeled by data type as `SR` (shared), `AR` (file-backed app), or `AW` (metadata-only app), and the candidate matrix (`sync-test-candidates.md`) enumerates dimensions of variation across all three.

The S0–S6 scenario suites realize selected candidates:

- **S0 baseline** — a no-op round converges trivially.
- **S1 presence × operation** — every `{side, verb, data-type}` × initial-presence combination, across SR / AR / AW.
- **S2 tombstones** — soft-delete propagation across sides and data kinds.
- **S3 blob × failure (single and multi)** — blob-pull/push failure in mid-round; verifies Staged residency, contiguous-prefix watermark behavior, and retry on the following round.
- **S4 watermark reset** — convergence after one side's watermark vector is reset to `{}`.
- **S5 concurrent updates × 2 rounds** — both sides update the same record between rounds; LWW resolution.
- **S6 pagination** — multi-round drains with small `pageLimit` and `scanPageSize`; verifies cursor advance.
- **Channel split** — verifies that `syncSharedRecords` partitions the two streams as declared (shared data stays on the Drive channel, app data stays on per-app channels), including the defense-in-depth inbound guard.
- **AR/AW rows** — exercises the file-backed reserved table vs. plain app-row tables through the same exchange protocol.

The harness's existence is itself a functional fact about this package: behavior under partial failure and across both data kinds is a maintained property, not an aspirational one.

## Open questions

- **HLC clock persistence consumer.** `SyncStateStore.getHlcClockState`/`setHlcClockState` are defined and SQLite-backed, but no code in this package reads them back into the `HLCClock` passed to `createSyncEngine`. Presumably the caller wires the persisted state into the clock on startup; confirming where (and verifying it actually happens on every entry path) is a question for the local-server / cloud-server topics.
- **`remote-update-available` producers.** The event type is declared, but nothing in this package emits it. The intent is clearly "the supervisor or transport layer learns out-of-band that the peer has new data and nudges the engine to schedule a round." Who emits it in production deployment isn't visible from this package.

# Part 2 — Review and evaluation

## Questionable purposes

- **`FileSyncEngine.getFilesToPush` / `getFilesToPull` appear unused by the exchange round.** The main `exchange()` path constructs manifests directly from carrier fields (shared record or file-backed app row) via `manifestForRecord`/`manifestForAppRow`; the two `getFilesTo…` helpers iterate `entries` and consult both storages. They're re-exported and documented in the README's "individual components" section, but no internal call site uses them. Either they exist for an external (non-engine) consumer not visible here, or they're vestigial from an earlier design where the engine drove file diff separately from metadata.

## Behavior inconsistent with purpose

_(no remaining items)_

## Missing behaviors

- **No supervisor / scheduler in-package.** This is intentional given the topic's scope (the calling environment owns scheduling), but worth naming explicitly: callers must drive `exchange()` themselves on every channel (the Drive channel for shared data and one per cloud-installed app for app-specific data). There is no built-in "loop until `!hasMore`" helper, no exponential backoff on transient failure, no jittered poll. If two adjacent topics each grow their own ad-hoc supervisor, a tiny shared helper in this package (or a sibling) would prevent drift.

- **No durable record-of-attempt for failed blobs.** The contiguous-prefix rule guarantees retry on the *next* round because the watermark stays behind the failed item — but nothing surfaces "this blob has failed N times" to ops. A persistently-failing blob (shared or app-specific) will be retried forever, silently logging `[sync] blob ... failed for ...` to console. There's no metric, no escalation, no quarantine. For a long-running production engine this is a real observability gap; whether to fill it here or upstream (supervisor) is a design call.

- **No back-pressure on the change notifier.** `emit` synchronously calls each listener. A slow listener (e.g. one that does an `await` inside the callback) silently blocks the end of `exchange()`. The type signature `ChangeListener = (event: ChangeEvent) => void` doesn't admit a Promise return, so the contract is "listeners must be cheap and synchronous" — but nothing enforces it. A misbehaving listener can delay watermark persistence (since the emit happens before return).

## Behavioral bugs

- **`scanSince` is called with `zeroStr` instead of the peer's watermark.** Both `sync-engine.ts:143` (outbound) and `in-process-transport.ts:151` (responder) pass `serializeHLC(ZERO_HLC)` as the `sinceHlcStr` argument when scanning app-specific tables. The peer-watermark filter is then applied client-side inside the page loop. This makes the contract of `ScanCapableApplier.scanSince` — *"scan rows with `updated_at > sinceHlcStr` in HLC order"* — effectively unused as a push-down: the engine always asks for "everything from zero" and discards rows below the watermark in memory. The known-performance comment immediately above (`sync-engine.ts:91`) names exactly this issue, but the engine itself reinforces it by never threading a non-zero `sinceHlcStr`. The peer-watermark vector is per-nodeId (not a single floor), so it doesn't fit `sinceHlcStr` cleanly — but the current code makes the parameter dead. Either the parameter should be deleted from the contract (and the comment updated), or the engine should compute a usable floor (e.g. `min(peerWatermark)` across known nodeIds) and pass it.

- **`hasMore` on the responder uses a slightly fuzzy approximation.** `in-process-transport.ts:182` derives `hasMore` from `overflowed || records.length + appSyncableRows.length >= limit`. The shared-data side is precise (`overflowed` is set when the shared scan tripped the limit), but the app-specific side's contribution to `hasMore` is "we hit the cap while collecting" — not "there are still rows past the cursor." If the app-row scan exactly hits the limit but happens to have no rows past the cursor, `hasMore` is `true` and the caller schedules an extra useless round. The cost is one wasted exchange; not a correctness bug, just inefficient under specific boundary conditions.

## Potential gaps

- **No explicit handling of HLC clock skew beyond `clock.receive`.** The engine calls `clock.receive(incomingHlc)` before applying every inbound item, which advances the local HLC monotonically past anything received. That's correct LWW behavior and matches the protocol's design — but there's no defense against an obviously-bogus HLC (e.g. `wallTime` years in the future from a misconfigured peer). A single such record permanently raises the local HLC to that future, after which local writes carry the bogus wall-time forward. Whether to clamp / reject / warn on absurd skew is a policy question, but it belongs somewhere — either here or in `HLCClock` itself. High confidence this is a real gap.

# Implementation notes

Modules in scope:

- `packages/sync-engine/src/sync-engine.ts` — `createSyncEngine` and the exchange round
- `packages/sync-engine/src/types.ts` — wire types, options, interfaces (the two data kinds appear as `AnyRecord` and `AppSyncableRowEntry`)
- `packages/sync-engine/src/file-sync-engine.ts` — `transferFile` + helpers
- `packages/sync-engine/src/watermarks.ts` — vector manipulators
- `packages/sync-engine/src/residency.ts` — `residencyOf` and `RecordResidency` (applies to all file-backed records, shared or app-specific)
- `packages/sync-engine/src/change-notifier.ts` — pub/sub
- `packages/sync-engine/src/sync-state-sqlite.ts` — built-in `SyncStateStore`
- `packages/sync-engine/src/errors.ts` — `SyncError`
- `packages/sync-engine/src/transports/in-process-transport.ts` — direct-adapter transport
- `packages/sync-engine/src/transports/http-transport.ts` — client over `fetch`
- `packages/sync-engine/src/transports/http-server.ts` — request handler for the responder side
- `packages/sync-engine/__tests__/` — scenario test harness and S0–S6 suites
