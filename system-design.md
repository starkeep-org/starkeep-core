# Starkeep — System Design Overview

This document describes the intended high-level design of Starkeep: what the major parts are, what kinds of data they handle, and how that data moves through the system. It is a companion to `data-roles-and-permissions.md`, which covers the trust boundaries between these same parts. Where this doc says "the app's data operations are mediated by the cloud-data-server," that doc explains *why* — and what stops the admin user, an app, or the broker itself from stepping outside the lane.

This is intentionally high-level. Wire formats, table layouts, and manifest schemas live in code and in the package READMEs.

---

## Stance

Three properties drive the design.

1. **Data files are the user's, not the app's.** Apps are tenants on top of a user-owned data plane. Shared data items have an identity and a lifetime that is independent of any one app: they outlive uninstalls, can be operated on by multiple apps simultaneously, and are typed against a global registry that the platform — not any one app — owns. (However, apps may also have app-specific data, and Starkeep provides a common mechanism to sync suhc app-specific data between local and cloud).
2. **One service touches cloud data; everything else goes through it.** The cloud-data-server is the sole writer/reader of shared bytes in the cloud. Apps in the cloud do not hold direct credentials for the data store; they invoke the broker, which performs the operation under the *calling app's* identity. This is what makes the per-app attribution property in `data-roles-and-permissions.md` real at the data plane.
3. **Local and cloud share the data-plane primitives.** The local-data-server is the on-device analog of the cloud-data-server. They are *separate* hosts — the SDK (`@starkeep/sdk`) drives the local side, while the cloud side is a standalone Lambda handler — but both are built from the same shared building blocks: the type/category registry and object-key scheme (`@starkeep/protocol-primitives`), the sync engine, the app-specific data plane (`@starkeep/shared-space-api`), and the per-type access-grant predicate (`protocol-primitives/access`). Because the grant→category derivation and the `can*` checks are one shared module, a manifest grant that is wrong, or a type-level filter that is missing, fails in the same shape locally as in the cloud. What each host supplies for itself is only what is genuinely host-specific: its store (SQLite vs DSQL), its credential/transport layer, and its all-access policy.

A consequence: the admin app, which the human user drives, never appears on the data path. It mints, installs, and uninstalls — and stops there.

---

## The major parts

### Bootstrap stack

A one-shot CloudFormation stack that creates the identities, permission boundaries, and supporting resources used by the rest of the system (Cognito pools, the admin role, Manager, install-ddl, install-infra, the Pulumi state bucket, the artifacts bucket, and the permission boundaries: foundational, per-app, the two install-time boundaries, and the User-Data-Owner boundary). It runs once, in the user's AWS account, before anything else exists. It produces no data-plane resources — those come from the cloud-data-server deploy in the next phase. Note: the reserved User-Data-Owner *role* is **not** created by this stack; it is minted at Starkeep Drive install, under the User-Data-Owner permissions boundary this stack defines.

`data-roles-and-permissions.md` covers what each identity is and why.

### Admin app

A platform component that the human user logs into. Its job is to drive **deployment, install, and uninstall** — not data access. The admin app:

- Deploys the cloud-data-server (the "Phase 2" deploy in the roles doc) by delegating to Manager.
- Installs and uninstalls apps by orchestrating Manager's chain of role assumptions through install-ddl (for per-app PG roles, schemas, and grants) and install-infra (for per-app Lambdas, log groups, API Gateway routes).
- Surfaces install state, grant state, and configuration to the user.

The admin app **cannot read or write user data in the cloud**. It has no standing data-plane permissions, and the temporary install-time policies it triggers are attached to dedicated install-time roles, never to the admin role itself. If a user wants to view their photos, they do that through the photos app, not through admin.

### Cloud-data-server

A platform component, deployed as a built-in app during Phase 2. It is the data broker — the analog of the local-data-server, but for cloud-side data.

- It is the **only service in the cloud that directly touches shared data** (the records table, the per-type metadata tables, the files bucket).
- It necessarily holds broad type-level capability to do its job, but it does **not** use its own identity for shared-data reads and writes. For every data request it assumes the calling app's per-app role and runs the operation under those credentials, so every shared byte is attributable to a specific app.
- It enforces type-level filtering at the application layer for the shared records table (since DSQL has no row-level security), in addition to the PG GRANTs that govern per-metadata-table access.
- It exposes a uniform request shape that covers both **shared-data** operations (records + type metadata + files) and **app-specific syncable** operations on behalf of the calling app.

### Apps (e.g. photos)

Apps are installed by the admin app on a user's deployment. From the data plane's point of view, an app is:

- A **manifest** declaring its appId, the shared data types it needs (and read vs read/write), any per-type metadata it owns, and any **app-specific syncable** schema and filespace it wants.
- A **per-app IAM role**, minted at install, that the app's Lambda(s) run as. The role has no install-time verbs; its ceiling is exactly its runtime job.
- A **per-app PG role and schema**, created at install with type-level grants matching the manifest.
- A **shared API Gateway route** that the app's Lambda is reachable on.

Apps do not touch cloud data directly. All shared and app-specific data operations they perform go through the cloud-data-server, which assumes the app's role and runs the operation under that identity. An app reaches the local-data-server the same way it reaches the cloud — over an HTTP data API, gated by the same per-type access-grant predicate — so the two are interchangeable from the app's point of view.

Install grants the app-specific schema, the app's filespace prefix, and the declared shared-type grants. Uninstall reverses install: it drops the per-app PG role and schema (so app-specific DB rows are removed), clears the app's filespace prefix (so app-specific files are removed), and tears down the app's Lambda + routes. **Shared records and shared files are not deleted** by uninstall — they are owned by the user, not the app, and other apps with grants on those types continue to see them.

### Local-data-server

A platform component that runs **outside the cloud**, on the user's machine. It is the local analog of the cloud-data-server: it mediates access to local SQLite and the local filesystem, built from the same shared data-plane primitives the cloud uses (the type/category registry, the sync engine, the app-specific data plane, and the access-grant predicate).

- It holds no AWS credentials and never talks to S3 or DSQL directly.
- It is the sole local writer/reader of the local data plane.
- It runs the **sync engine**, which replicates the local data plane to and from the cloud-data-server. Because it carries data for *every* installed app on the device, it ultimately needs broader data-type capability than any single app does — but, mirroring the cloud-data-server's role on the cloud side, it does not expose that breadth to apps; apps talk to it over its local HTTP API and are filtered to their declared grants.

Because local and cloud share the same access-grant predicate and data-plane primitives, a misconfigured grant denies in development the same way it denies in production.

---

## How data is classified

Starkeep recognises two categories of user data, with very different lifetimes, sharing rules, and storage layouts. The distinction is enforced structurally — by where the bytes live and which schema/prefix owns them — not by convention.

### Shared data

Shared data is the user's content, typed against a registry that the platform owns. Defining properties:

- **One item per file.** Each shared-data item is stored as a single file under the `shared/<category>/...` prefix in object storage. This makes items portable (they map cleanly onto a filesystem) and makes large items cheap (the database does not carry their bytes).
- **Indexed by `shared.records`.** A single records table holds one row per item — id, type (the canonical `<category>/<format>` id), timestamps, a `version` counter, the content-addressed object-storage key, and common bookkeeping. The `version` is bumped on each write but is **not** an OCC/concurrency token — nothing reads it to gate a write, and conflict resolution is last-writer-wins on the HLC `updated_at` (see "Sync semantics" below). The records table is the index; the file is the content.
- **Identified by a canonical type, organized by category.** An item's `type` is a canonical two-level `<category>/<format>` Starkeep type id (e.g. `image/jpeg`, `document/markdown`) in Starkeep's own namespace — **not** an IANA MIME type and **not** a file extension. The writing app declares the type; the filename extension and MIME type are advisory only (a convenience for ingestors, such as the local watcher, that have only a filename) and never decide identity. The platform owns a hardcoded registry of types and categories; a type's category is structurally the prefix of its id. Apps cannot invent new types or categories; they declare types from the registry and are granted access at the category level. Unmapped or extension-less files fall into the terminal **`other/other`** type (category `other`) — visible only to Starkeep Drive (the User-Data-Owner), never to an installable app, because `other` is excluded from the set of grantable categories; Drive reaches it via its `shared/*` IAM ceiling.
- **Per-category metadata, deterministic.** Each mapped category has an associated metadata table (e.g. for images: width, height, capture time, camera/EXIF, GPS). These tables are caches/indices of properties that are **deterministically derivable from the file itself** — not a place to hang app-specific commentary. Two apps reading the same image see the same width and height. `other` has no metadata table.
- **Shareable across apps.** Multiple apps may hold grants on the same categories, and operate on the same items. The type/category system, the records table, and the per-category metadata tables are the contact surface they share through.
- **Advisory interest labels.** Because the same type is shared across apps, one app can flood a category with records that are technically the right type but of no interest to other readers — the canonical case is Photos writing a re-sized **thumbnail** as an `image/jpeg` record, which every other image-declaring app would otherwise have to wade through. A record therefore carries an optional `label` column: a `<appId>/<purpose>` string (e.g. `photos/thumbnail`) the origin app sets at creation to mark such records so *other* apps can filter them out. It is **advisory** — nothing enforces filtering; a reader chooses whether to honor it — and orthogonal to `parent_id` (the structural thumbnail→original link is separate from the interest hint). A `null` label means general interest. The label is set once at creation and never changed; the write path validates that a present label's prefix matches the writing app's id, so an app cannot squat another app's namespace. Because it is a plain column on `shared.records`, it rides the normal shared-record sync and is filterable in the ordinary records query (no join).
- **Outlives uninstall.** Uninstalling an app does not delete shared records or shared files anywhere — including at the location where the app was uninstalled. The records belong to the user; another app with a grant on that type continues to see them, and reinstalling the app re-exposes them.
- **Synced across locations.** Shared data is replicated by the local-data-server ↔ cloud-data-server sync. Because shared items are typed at the platform level, sync is inherently cross-app: a photo written by photos on one device shows up on another device even if the only app installed there is something else that declares a grant on images.

#### Sync semantics for shared data

Records are conflict-resolved by last-writer-wins on a Hybrid Logical Clock `updated_at`; there is no `baseVersion`, no OCC, and no change-log outbox. Each side maintains a per-channel `{ [nodeId]: HLC }` watermark map — "what I have seen per replica" — and a single `/sync/exchange` round carries both sides' watermarks and the records each believes the other hasn't seen. Both push and pull synthesize record deltas inline by scanning the records table on `updated_at > watermark[nodeId]`. Shared-record sync flows through a single always-on channel owned by the built-in **Starkeep Drive** app (`starkeep-drive`, the User-Data-Owner): the local-data-server ships every shared record over this one channel and the cloud-data-server serves it under `app-starkeep-drive-role`. There is no per-record re-assumption of the originating app's role — origin attribution is preserved as an immutable `origin_app_id` data attribute on the record, set once at local creation. A record's origin app does **not** need to be cloud-installed for its shared data to sync (that is the point of routing shared sync through Drive). Per-app type confinement is enforced **locally before ship** by the local-data-server's `appCanWrite` check (layer 1) and **bounded in the cloud** by Drive's IAM grant on `shared/*` (layer 2). See `data-roles-and-permissions.md` for why this routing exists.

### App-specific data

App-specific data is the app's own state — captions on a photo, layout preferences, the photos app's tag taxonomy. It does not interoperate across apps. It exists because apps need to keep state that the shared data plane is intentionally not the right home for.

- **Declared by the app, in a namespaced schema and filespace.** A manifest may declare app-specific syncable tables (`app_<appId>.<table>` in the cloud, `<appId>_syncable_<table>` in SQLite) and an app-specific filespace (`apps/<appId>/syncable/...`). The shapes of those tables and the layout of files inside that prefix are entirely up to the app.
- **Structurally segregated from shared data.** App-specific data lives under its own schema/prefix, not in `shared.records` or `shared/...`. No app can write to another app's namespace, and shared-data tables and prefixes are off-limits to app-specific writes.
- **Synced only between instances of the same app.** Replication is conditional on the app being installed at the destination: an app-specific row written by photos on device A appears on device B only if photos is also installed on B. There is no cross-app fan-out and no orphan replay.
- **Does not survive uninstall *at that location*.** Uninstalling an app on a device deletes its app-specific schema, tables, and filespace on that device. Other devices that still have the app installed are unaffected — their copy continues to exist and continues to sync among themselves.
- **No platform-managed scratch space.** The system does not provide a managed non-syncable namespace for apps. The `apps/<appId>/` prefix is reserved for `apps/<appId>/syncable/...` and nothing else. Apps that need non-syncable scratch storage handle it themselves; it must stay out of `shared/...` and `apps/<appId>/syncable/...` and is not visible to the data plane.

#### Sync semantics for app-specific data

App-specific syncable rows are last-write-wins on `updated_at` (an HLC timestamp), with no OCC and no conflict ledger. The row's `updated_at` column **is** the durable change marker — the client-side change-log outbox is not used for app-syncable rows. Both push and pull synthesize transient app-syncable entries inline by scanning the per-app tables on `updated_at > cursor`. App-syncable rows ride alongside record changes on the wire as a separate top-level field in the sync request/response, sharing the same HLC cursors but never mixed into the record change stream.

The cloud's push handler rejects app-syncable rows whose `appId` is not present in the app-syncable namespaces registry — i.e., rows for an app that is not installed in the cloud. Pull is symmetric: app-specific rows for an app not installed at the destination are not delivered there.

### Type metadata vs app-specific metadata

The split between per-category metadata (a property of the shared data plane) and app-specific metadata (a property of an app) is important and easy to confuse:

- **Per-category metadata** lives in a platform-owned per-category table, must be deterministically derivable from the file, and is visible to every app with a grant on a matching category. For example, image width and height belong here.
- **App-specific metadata** lives in the app's own schema, is not constrained to be derivable from the file, and is invisible to other apps. A photo caption entered into an app by a user belongs here, even though it is "about" a shared image.

If a property is intrinsic to the bytes, it is per-type metadata. If it is something the app or the user (using an app) decided about the item, it is app-specific data.

### Per-record residency (a derived state, not a column)

Rows that carry a blob exist in one of four residency states on a given side. Two kinds of row carry a blob: shared records (every `kind:"data"` record is blob-backed), and the file-bearing app-syncable rows that live in the reserved `_starkeep_sync_records` table. **These states are derived at read time from facts already on disk, not stored in a status column.** This is non-obvious enough to be worth stating explicitly, because the absence of a `sync_status` column has historically misled both humans and code-reading agents into thinking the state isn't tracked.

The four states:

- **Absent** — no row for this id on this side.
- **Staged** — the metadata row is present and references an `objectStorageKey`, but the blob is not yet present in this side's object storage. The side knows it is *expecting* the file.
- **Resident** — the metadata row is present AND (the record carries no blob, OR the blob is present in this side's object storage).
- **Tombstoned** — `deletedAt` is set on the metadata row. Treated identically to Resident by the sync protocol; the tombstone propagates the same way an update does. Blob garbage collection is a separate concern not handled by sync.

The classification (`residencyOf`) is derived from just two persisted facts (plus `deletedAt`, which decides Tombstoned):

1. Presence of the metadata row in the appropriate records table.
2. Presence of the blob in this side's object storage (`localObjectStorage.has(key)`).

It does **not** read the watermark. The watermark is a *separate* mechanism that makes the Staged state durable across restarts rather than an input to the classification: while a record is Staged (blob not yet received), this side's watermark does not advance past that record's `updated_at`, so the gap persists and the next exchange round naturally surfaces the record again. No retry queue, no scan-everything reconciliation pass, no `sync_status` column — the watermark gap *is* the work queue. Steady state issues zero storage HEAD requests, because there is no gap to drive any.

Rows that never carry a blob skip the Staged state entirely — row-present implies Resident. These are the non-file app-syncable rows, which live in the per-app tables rather than in `_starkeep_sync_records`. (Shared records are always blob-backed, so they never fall in this category; whether an app's syncable row carries a blob is determined by which table it lives in, not by a per-record flag.)

A request from an app's client to read or write a shared item, in steady state, looks like this:

1. The client calls the **shared API Gateway** with a Cognito JWT (the user) and an app identification (the calling app).
2. The **cloud-data-server Lambda** authorizes the user, identifies the calling app, and **assumes the calling app's per-app role** for the duration of the request. The per-app role's trust policy names the cloud-data-server as a principal, so this is a single hop.
3. Under those assumed credentials, the cloud-data-server constructs DSQL + S3 adapters and runs the operation. The app's grants — declared in its manifest and enforced both by PG GRANTs and by application-layer type filtering on `shared.records` — determine what it can see and change.
4. Writes update `shared.records`, the relevant per-category metadata table, and the file in `shared/<category>/...`. Reads return a record + metadata + file URL/contents tuple.

For an **app-specific** operation the same shape applies, but the operation targets the app's own schema and filespace: `app_<appId>.<table>` and `apps/<appId>/syncable/...`. No other app can see the result; sync only carries it to other locations where the same app is installed.

For **sync**, the local-data-server and cloud-data-server perform a single `/sync/exchange` round per channel: each side advertises its per-replica HLC watermarks and ships the records and app-syncable rows it believes the other hasn't seen. Both record changes and app-syncable rows are synthesized inline by scanning the respective tables on `updated_at > watermark[nodeId]` — no client-side change-log outbox is involved. Per-record origin-app re-attribution happens inside the cloud-data-server, not at the sync API boundary — the local-data-server does not carry AWS credentials and is not the writer of cloud bytes.

---

## Why this layout, in one paragraph

The user owns the data; the platform owns the type system, the broker, and the install/uninstall mechanism; apps are tenants with declared, narrow access. Shared data is structurally cross-app and outlives any one app, so it lives in a single platform-owned records table and a typed file layout that the cloud-data-server brokers access to. App-specific data is structurally per-app and dies with the app at a location, so it lives in a namespaced schema and filespace that is invisible to other apps and is torn down on uninstall. The cloud-data-server is the only service in the cloud that touches data, and it does so under the calling app's identity rather than its own, so every byte is attributable. The local-data-server is its on-device twin, built from the same data-plane primitives and the same access-grant predicate, so authorization and typing mistakes surface in the same shape during development as they do in production. The admin app, which the human user drives, never appears on the data path — it deploys, installs, and uninstalls, and stops there.
