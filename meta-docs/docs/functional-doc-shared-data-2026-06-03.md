# Shared data — functional review

**Scope:** `shared-data` topic and all descendants (definitions, handling, indexing, storage-model, sync, type-categories, type-metadata, types, cloud-side, local-side).
**Date:** 2026-06-03
**Source ref:** `starkeep-core` @ `fd1d3fe`

---

# Part 1 — Current state

## Overview

Shared data is the part of Starkeep that holds *items a user would recognize as their own files* — photos, documents, audio, archives, code — in a form that is portable across the apps installed on the system and across the two physical sides of a deployment (the user's local machine and their cloud). The platform's contract is twofold: every shared item is a **file** (bytes in object storage) **plus a row** (in a flat shared-records table), and every item is identified by its **lowercase file extension** drawn from a fixed, hardcoded registry. That registry is what makes interop possible: a photos app and a viewer app can read the same `jpg` because both recognise `jpg` as `image` from the same closed set, not because they've agreed on a vendor schema.

The shape repeats on each side. The local data-server hosts the canonical SQLite database, a filesystem object store, and an HTTP surface for installed local apps. The cloud data-server (a Lambda fronting Aurora DSQL + S3) hosts the same logical schema, gated by per-app IAM. A bidirectional version-vector sync engine keeps the two sides aligned at the row and the blob level, using a single hybrid-logical-clock ordering for both metadata and files. Apps never touch raw storage; they go through the **shared-space API** that the data-server exposes, and the data-server is what authoritatively decides what a "type" is, who may read or write it, and whether a file belongs in shared storage at all.

The rest of Part 1 walks the concepts roughly in dependency order: identity → types → storage model → metadata → handling → indexing → sync → cloud and local specifics.

## Identity, ownership, and ordering

Every shared item has a `StarkeepId` (a ULID) generated at creation time on whichever side first sees the write. IDs are globally unique and never reissued; the ULID's lexicographic order is a coarse creation-time signal but it is **not** the system's ordering of truth.

The ordering of truth is a hybrid logical clock. Each side maintains an HLC keyed by a `nodeId` (`"local"` and `"cloud"` are the two real ones today), and every record carries an `updatedAt: HLCTimestamp` stamped at write time. Conflict resolution is pure last-write-wins by `compareHLC` (wallTime, counter, nodeId — larger nodeId wins ties). The cloud side seeds its HLC on each request from the highest cloud-stamped row visible to the calling app, so a fresh Lambda container does not start behind the durable state.

Each record names two principals:

- **`ownerId`** — the human owner of the data. There is exactly one owner per record today; ownership is set at write time and not transferred.
- **`originAppId`** — the installed app whose request produced the record. Set by the data-server at write time from the authenticated subject, not by the app. This is the field the sync supervisor uses to nudge the right per-app channel on local changes, and it is the field the cloud cleanup paths use to attribute records to apps.

A record may carry a nullable `parentId` pointing at another record. The codebase exercises this for derived children — e.g. a thumbnail produced by Photos hangs off its original — and the dedup-on-write rule keys on `(parentId, contentHash)` so byte-identical children of the same parent collapse to one row. The parent may be of any type; the schema validator, the local data-server write path, and the database all permit cross-type parent links. There is also no transitive parent chain enforced anywhere — parent is a single hop.

## Types and categories

Two closed registries in `packages/protocol-primitives/src/types/core-types.ts` define the entire shared-data type system: `EXTENSIONS` (lowercase extension → category) and `CATEGORIES` (the eleven category definitions, each with its own metadata column list). A record's `type` is the lowercase extension verbatim — `"jpg"`, `"md"`, `"xyz"`. The category is *derived*, not stored: `category = EXTENSIONS[ext] ?? "other"`.

There are eleven categories: `image`, `video`, `audio`, `document`, `text`, `code`, `font`, `archive`, `data`, `model3d`, and the terminal catch-all `other`. Mapped categories own a per-category metadata table; `other` does not. The shape is intentional: by hardcoding the map in one file, every part of the system that needs a type view — manifest validation, IAM emission, DSQL schema-init, SQLite bootstrap, object-key construction, the cloud access enforcer — derives its view from the same source. Adding a new file extension or a new metadata column is a one-file edit; there is **no runtime registration path** that lets an app extend either registry. Apps may only declare extensions that are already in `EXTENSIONS`, and they may never declare `other`.

`other` is a Drive-only catch-all. The User-Data-Owner (the built-in Starkeep Drive app, app id `starkeep-drive`) is the only installable app that can see records whose extension is unmapped or absent. Drive's all-access path is granted by app id rather than by per-extension grant rows — both the local data-server and the cloud access enforcer special-case it. Every other app sees only the categories its manifest declared.

There is also a separate `type_registrations` table populated by `sdk.typeRegistrations.register` (control-plane only, never synced). Apps call it on bootstrap — photos registers `typeId: "image"` with an empty JSON-schema object — and the row is then read back by `get`/`list`. Nothing on the write path consults the schema, the schema version, or the `registeredByAppId` field; type enforcement at write time is the extension/category check plus per-extension `access_grants` and access-control policies. The TypeRegistration table is effectively an idempotency record for the bootstrap call (see Part 2).

## Storage model

A shared record is two things in two places:

1. **A row** in `shared.records` (cloud, Postgres) or `shared_records` (local, SQLite). Same logical shape on both sides: `id`, `type`, `created_at`/`updated_at`/`deleted_at` (serialized HLCs as text), `owner_id`, `version`, `content_hash`, `object_storage_key`, `mime_type`, `size_bytes`, `original_filename`, `origin_app_id`, `parent_id`. One flat table per side — there is no per-type sharding at the row level.
2. **A blob** in object storage at a deterministic key: `shared/<category>/<2-char-prefix>/<contentHash>`. Both sides use the same key scheme (`dataRecordObjectKey` in `packages/protocol-primitives/src/storage/object-keys.ts`), so the key for a blob is identical whether it lives in S3 or in the local filesystem store. The category is derived from `type`, so unmapped/extension-less records bucket under `shared/other/...` — that bounded prefix set is what makes IAM grants enumerable.

Two design properties fall out:

- **Content-addressable.** The key is the content hash; identical bytes share one blob. A real edit produces a new hash and therefore a new key — the row's `object_storage_key` simply repoints. This makes conflict resolution cheap on the blob side: the loser's bytes still live at the loser's key, and the winning row simply doesn't reference them; there is no in-place overwrite to coordinate.
- **The prefix is determined by what is stored, not who writes it.** Even when an app with `readwrite` access produces a record, the blob still lands at `shared/<category>/...`, never under that app's `apps/<appId>/` prefix. That is what allows a *different* app with read access to the same category to fetch the blob under its own IAM grants.

A separate prefix, `apps/<appId>/syncable/...`, holds app-specific syncable files (e.g. captions a Photos app stores about a photo it doesn't own as data). The system intentionally does not provide an app-private non-syncable namespace — apps that want one handle it themselves.

Local SQLite enforces a **per-owner duplicate-file rule** via a partial unique index on `(owner_id, original_filename, content_hash) WHERE deleted_at IS NULL AND original_filename IS NOT NULL`: re-uploading the exact same filename + bytes is rejected, but a re-upload after a soft delete is allowed (the rule excludes tombstones) and records without an original filename are unconstrained.

## Type-based metadata

Each mapped category owns one metadata table — `shared_record_<category>_metadata` locally and `shared.record_<category>_metadata` in DSQL — generated from the category's `metadataColumns` list. `record_id` is the PK; the remaining columns are typed and deterministically derivable from the file's bytes: `image` carries width, height, EXIF, GPS; `video` carries codec and duration; `audio` carries sample rate and tags; `document` carries page and word counts; and so on.

Two invariants distinguish this from app-private metadata:

- **Deterministic, not opinionated.** Every column other than `record_id` "must be deterministically derivable from the record's file bytes" (per `MetadataRow` in `protocol-primitives/src/records/types.ts`). Different apps that look at the same `jpg` will compute the same `width`, so this is safe to share.
- **App-level fields stay app-private.** Titles, captions, edit provenance, album membership — anything that depends on user intent or one app's UX — are explicitly *not* on these rows. They live in app-private storage (the app-syncable namespace), so two apps disagreeing about a caption never produce a shared-metadata conflict.

The terminal `other` category has no metadata table and the SQLite/DSQL bootstrap paths both skip it.

## Handling: the shared-space API and the data-server's authority

Apps reach shared data through the **shared-space API**, a versioned HTTP-shaped surface (`packages/shared-space-api`) that the local data-server hosts and that the cloud Lambda mirrors. Endpoints register under `namespace:version/path` (e.g. `@photos/image:v1/list`), and every request carries an authenticated `ApiSubject` (`{ subjectType: "app", subjectId }`). The router resolves the endpoint; the handler receives an `ApiContext` containing the database adapter, object storage adapter, the side's HLC clock, the `ownerId`, and — when the subject is an installed app — a scoped `appSpecific` view of that app's app-syncable namespace.

The `appSpecific` operations on `ApiContext` are about *app-private* data and are largely out of scope here; they touch shared data in exactly one place — the reserved `_starkeep_sync_records` table the framework materialises in every file-enabled app's namespace carries the row metadata that lets the sync engine ship app-syncable file blobs through the same path it ships shared-record blobs.

The architectural fact that matters for shared data is that **the data-server is the authoritative registrar of shared types**: app packages export their type definitions; the data-server imports them on install, registers them in `type_registrations`, and validates every write against the extension-keyed category at the shared database boundary. Apps do not maintain their own type registries.

Access to shared records is gated by per-extension grants on both sides: the local server reads `shared_access_grants` keyed by `app_id`, and the cloud side does the same against `shared.access_grants` (see "Cloud-side specifics" for why this is at the application layer rather than the DB layer).

## Indexing: unified search

`query-orchestrator` sits on top of the database adapter to give apps an indexed view of shared records. It exposes `createUnifiedIndex({ databaseAdapter })` with `search(query)` and `getWithMetadata(id)`. Today's implementation translates the supported `IndexQuery` fields — `types`, `dateRange`, `limit`, `cursor` — into a `DatabaseAdapter.query()` call and returns the matching `DataRecord` rows wrapped as `IndexItem`. `getWithMetadata` does not actually join metadata in the current code (it returns `{ dataRecord }`); the name is aspirational.

The package owns no persistent index tables today; it goes through the same `DatabaseAdapter`, which is what gives the local SQLite and the cloud DSQL adapters the same query surface from the planner's point of view.

## Sync: one exchange round, HLC LWW, contiguous-prefix watermarks

The sync engine (`packages/sync-engine`) drives **one version-vector exchange round per tick**. It is the only path by which shared data crosses sides; there is no separate "reconciliation" pass and there is no persistent `sync_status` column on records.

Each side stores three pieces of state in its own `syncState`: its own `wallTime`/`counter` (the HLC clock seed), `ownWatermarks` (per-nodeId HLC of the highest record successfully applied from that node), and `peerWatermarks` (per-nodeId HLC the peer is known to have seen). On `exchange()` the engine:

1. Reads both watermark maps.
2. Scans local rows the peer hasn't seen — both shared records (`shared.records`) and app-syncable rows (`_starkeep_sync_records` + plain app tables) — by interleaving per `nodeId` in HLC order, capped at `pageLimit` items per round.
3. For each outbound item, pushes its blob first (if it has one); then ships the row.
4. On the inbound side, applies the row first; then pulls its blob.
5. Advances watermarks **only over the contiguous successful prefix per `nodeId`**: a single blob failure halts shipping for the rest of that `nodeId` in this round, the watermark stays behind the failed item, and the next round naturally retries it. Other `nodeId`s are unaffected. This is the rule that keeps a single transient failure from orphaning a record forever.

Per-record residency on a side is named in `residency.ts` and derived from `(row presence, blob presence, deletedAt)` — `absent | staged | resident | tombstoned`. There is no persisted residency column. The watermark is the durable backstop for `staged`: a row whose blob hasn't landed yet does not let the watermark advance past it.

`compareHLC` orders by `(wallTime, counter, nodeId)` with the larger `nodeId` winning ties. Because `nodeId` is part of the serialized HLC string, cross-side bytewise-identical timestamps cannot occur. With content-addressable storage, a real content change produces a new `object_storage_key`, so "loser-blob discarded" is implicit — the loser's bytes simply sit at the loser's key with no row pointing at them.

### Shape A: Drive is the only channel that carries shared records

The deployment splits sync into channels: one per installed cloud app plus the always-on **Starkeep Drive** channel. By convention (Shape A), only the Drive channel ships shared records (`syncSharedRecords: true`, no `appSyncableSource`). Per-app channels set `syncSharedRecords: false` and carry only their own app-specific rows. Both the requester (`sync-engine.ts`) and the responder (`in-process-transport.ts`) guard against an over-shipping peer. The practical consequence: shared-data sync is identical regardless of which other apps the user has cloud-installed.

The sync supervisor uses the `originAppId` on a `local-change-recorded` event to nudge the right channel: a shared-record write (no `originAppId`) wakes Drive; an app-specific write wakes that app's channel.

## Cloud-side: how shared data is stored, scoped, and accessed

The cloud schema is materialised by `packages/admin-installer/src/dsql-schema-init.ts`: a `shared` Postgres schema containing the flat `shared.records` table, per-category metadata tables generated from `CATEGORIES` (via `pgMetadataDdl`, skipping `other`), `shared.access_grants` (per-app, per-extension), `shared.type_registrations`, and `shared.app_syncable_namespaces`. Two tables are cloud-only: `shared.sharing_tokens` (sharing tokens are issued and validated only by the cloud data-server) and `shared.access_policies` (control-plane policies that are never synced).

DSQL has no row-level security, and `shared.records` is one flat table for every shared type. Postgres `GRANT`s alone therefore cannot scope an app to its own extensions, so per-extension enforcement on shared records is at the **application layer**, not the DB layer: the cloud-data-server's `access-enforcer.ts` loads the caller's grants from `shared.access_grants` into an `AccessGrants` set and exposes `canRead(type)` / `canWrite(type)` / `canReadCategory(category)` / `canWriteCategory(category)` that every shared-data request handler consults. The category-level variant exists because the category-namespaced resources (object-storage keys under `shared/<category>/...` and the per-category metadata tables) need a category-granular check on top of the extension-keyed row check.

Object storage on the cloud is S3 using the same `shared/<category>/<shard>/<hash>` key scheme as the local side — that's what lets a record sync without rewriting its `object_storage_key`. The S3 IAM ceiling is per-category: each `shared/<category>/*` resource is added to an app's runtime policy for each granted category (read-only by default, with `PutObject`/`DeleteObject` for `readwrite` grants). Drive's `fileAccessAll` widens this to `shared/*`, which is what lets Drive — and only Drive — touch the `other` catch-all.

Drive is special-cased on both axes of the cloud's shared-data picture: its IAM ceiling is `shared/*` (categories), and its application-layer enforcement is "all-access by app id" — `loadAccessGrants` short-circuits to `allAccess: true` for `starkeep-drive` and writes no per-extension rows to `access_grants`. This mirrors the local data-server's all-access check, so the two sides cannot drift on who can see `other`.

The cloud-side HLC is seeded from the highest cloud-stamped `updated_at` visible to the caller (`WHERE updated_at LIKE '%:cloud'` against `shared.records`), so a fresh Lambda container does not regress the clock for shared writes. (Wall-clock dominance corrects it quickly anyway; see Part 2.)

Mechanics of how the Lambda reaches DSQL and S3 in the first place (STS role assumption, per-app Postgres roles, the broker-power pattern) are general cloud-data-server architecture and live with the `cloud-server-auth` / `cloud-bootstrap-roles-permissions` topics, not here.

## Local-side: how shared data is stored and scoped

The local SQLite schema (`packages/storage-sqlite/src/schema/bootstrap.ts`) parallels the DSQL one, just with prefix-named tables in one file: `shared_records`, `shared_record_<category>_metadata`, `shared_access_grants`, plus the install/registry bookkeeping tables. Per-category metadata DDL comes from the same `CATEGORIES` list via `sqliteMetadataDdl`, so an edit in `protocol-primitives/src/types/core-types.ts` keeps cloud and local in lockstep. The local schema is bootstrapped from scratch; there is no migration system today, and CLAUDE.md is explicit that migrations have been deferred as a production concern.

The local object store (`storage-fs`) writes blobs to disk at `<root>/shared/<category>/<shard>/<hash>` — the exact key `dataRecordObjectKey` produces, so the same value identifies a blob on either side. Drive's all-access is enforced by the local data-server's app-id check against `starkeep-drive`, mirroring the cloud enforcer.

Two cross-side parity properties matter for sync correctness:

- The duplicate-file partial unique index on `(owner_id, original_filename, content_hash) WHERE deleted_at IS NULL AND original_filename IS NOT NULL` is defined the same way on both sides.
- The per-category metadata tables and the `shared.records` / `shared_records` columns are generated from the same source, so a record landed on one side has a place to land on the other.

Everything else the local data-server does — HMAC app authentication, the filesystem watcher, the sync supervisor — is local-server-general and belongs under `local-server-*` topics, not here.

## Open questions

None at the moment.

---

# Part 2 — Review and evaluation

_(no remaining items)_

## Behavior inconsistent with purpose

_(no remaining items)_

## Missing behaviors

_(no remaining items)_

## Behavioral bugs

_(no remaining items)_

## Potential gaps

None identified with high confidence at this pass. Two areas warrant a closer look in a follow-up but are not certain enough to call gaps here:

- Whether the app-syncable file-blob path (`_starkeep_sync_records` + `manifestForAppRow`) and the shared-record blob path have meaningfully different failure modes that the contiguous-prefix rule does not equally handle. Both ride the same per-`nodeId` rule, but only the shared path has been described in the docs.
- Whether the local SQLite duplicate-file rule (`uq_shared_records_owner_filename_hash`) and the cloud DSQL equivalent diverge on tombstones in any way that matters during sync — the rule excludes tombstones by `deleted_at IS NULL`, which is consistent on both sides, but I did not exhaustively trace the interaction with HLC LWW on re-uploads.
