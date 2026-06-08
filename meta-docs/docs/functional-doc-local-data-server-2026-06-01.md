# Local data server — functional documentation (2026-06-01)

Topic scope: `local-data-server` and all its sub-topics (start/stop, watcher, local data operations, DB indexing, object storage, permissions, cloud auth broker, cloud sync). The cross-cutting sync engine in `packages/sync-engine` is treated as a black box at the boundary; only how the local server *uses* it is in scope here.

Audience: a new contributor who will modify this code and is comfortable with Node/TypeScript and HTTP services, but has no prior starkeep context.

---

# Part 1 — Current state

## Overview

The local data server is a single Node.js process that runs on the user's machine and owns the user's local copy of all starkeep data. It is the only thing on the box that talks directly to the local SQLite database and to the on-disk object store; everything else — installed local apps, the Drive UI, the admin web app, the filesystem watcher — goes through its HTTP surface on `127.0.0.1:9820`.

Three concerns are colocated in this process because they share the same database, the same object store, and the same view of "what the user has":

1. **A local data plane.** Two distinct planes actually: *shared records* (the user-visible content layer, collaborated on through type-based access grants) and *app-specific syncable data* (per-app SQLite tables and per-app file blobs, isolated to a single app's namespace).
2. **A cloud-authentication broker.** The local server holds the user's Cognito refresh token and STS credentials, refreshes them in the background, and presents them when talking to the cloud server. Local apps never see the user's cloud credentials directly.
3. **A bidirectional sync orchestrator.** The local server runs N+1 sync channels (one always-on Drive channel plus one per installed app) and is the only thing on the local side that pushes to or pulls from the cloud server.

Everything else in this document is one of those three jobs or a piece of the plumbing that supports them (process lifecycle, request authentication, watcher, change broadcasting).

The server is implemented in `apps/local-data-server/`; `server.ts` is the HTTP request surface and most of the orchestration logic, and the data-layer building blocks live in sibling packages (`packages/access-control`, `packages/storage-fs`, `packages/storage-sqlite`, `packages/sync-engine`).

## Process lifecycle and configuration

The server starts via `cli.ts`, which parses environment variables and the on-disk `starkeep-config.json` and then hands off to `startServer()` in `server.ts`. By default everything lives under `~/.starkeep/`: the SQLite file, the object store (`objects/`), the persisted auth tokens (`auth.json`), the STS credentials cache (`cloud-credentials.json`), and the persisted watch configurations (`watches.json`).

Startup is sequenced because later steps depend on earlier ones being ready:

1. Open the local SQLite database and run schema initialization (`packages/storage-sqlite`).
2. Build the object-storage adapters: filesystem first (always present), then an S3 adapter if cloud configuration is available.
3. Construct the HLC clock seeded with the node's identifier, then the SDK that wraps both stores, then the per-app sync-state store.
4. Install the system "apps" — Drive and the watcher — into the local app registry. Their HMAC secrets and all-access grants are created here so the rest of the server can rely on them existing.
5. Restore persisted watches from `watches.json` and arm the file-watch manager.
6. If a cloud URL is configured, build the sync supervisor and start the Drive engine.
7. Open the HTTP listener on `127.0.0.1:9820`.
8. If a persisted refresh token is on disk, start the credential-refresh timer; the supervisor will begin ticking once a live id token is available.

Shutdown is symmetric and triggered by `SIGTERM`/`SIGINT`: close open SSE connections, stop the HTTP listener, drain the sync supervisor, shut the watch manager down, close the SDK. `PATCH /config` is a deliberate exception — it writes the new configuration and then exits the process, relying on the supervisor (typically the user's launchd/systemd unit, or the admin-web "restart local server" affordance) to bring it back up against the new endpoints.

The server binds only to the loopback interface. That single fact carries most of the request-authentication model (below): the network boundary is the box, not the route.

## Request authentication: HMAC for apps, loopback for everything else

Two distinct authentication regimes coexist on the HTTP surface, and which one applies depends on the route prefix.

**HMAC-authenticated routes.** Any request whose path begins with `/data/`, `/cloud/`, `/sync/`, `/app-data/`, or `/files/` must carry an `X-Starkeep-App-Id` header and an `X-Starkeep-App-Sig` HMAC-SHA-256 of the request body computed with the app's secret. The middleware looks the secret up in the local `shared_app_registry` and validates the signature in constant time before the route handler runs (`apps/local-data-server/server.ts` middleware around line 580). Installed local apps obtain their `hmacSecret` once at install time via `POST /admin/apps/install` and keep it for the lifetime of the install.

Two routes inside those prefixes are exempt because their authorization travels in the URL itself: `GET /data/files/:token` and `PUT /data/files/upload/:token` carry a server-issued signed token in the path, so they can be embedded directly in `<img src>` or used by an external uploader.

**Loopback-authorized routes.** Everything else — `/health`, `/config`, `/auth/*`, `/watches`, `/admin/*`, `/events`, `/browse` — has no HMAC requirement. The underlying principle is that these routes are administrative or host-level: they configure the server, broker the user's own cloud session, or manage the file-watch surface, and none of them needs to read or write the user's records on behalf of a particular app. The middleware's comment ("admin and host endpoints, owned by admin-web and the user themselves") is the surface form of that principle. Because nothing on these routes is per-app data, the access-grant machinery has nothing to enforce, and the loopback bind is a sufficient boundary: anyone with code execution on the box is, by construction, allowed to administer this server.

Two routes in the loopback-authorized set don't fit that principle cleanly. `/browse` enumerates records across the whole database (watched files plus the "Library" of unwatched ones) and returns filenames, mime types, sizes, and timestamps — that is user data, not administrative state. `/events` broadcasts the SDK's change notifier (which carries record ids and event types) to every connected SSE client without consulting any app identity. Both are protected only by the loopback bind, with no equivalent of the data-plane's per-app access check. They are noted again in Part 2.

## Shared records data plane

Shared records are the layer where apps collaborate. The model is simple: every record has a *type* (typically the lowercase file extension — `photo.jpg`, `note.md`, …), and types are grouped into *categories* (photo, video, audio, document, other). Apps are granted access at the type level but enforcement happens at the category level for object-storage operations.

The on-disk shape (`packages/storage-sqlite/src/`) is a single `shared_records` table holding identity, type/kind, content hash, owner, the object-storage key for the bytes, timestamps, soft-delete tombstone, parent linkage for derived records (e.g. thumbnails belonging to a photo), and the immutable `origin_app_id` that first created the row. Per-category metadata tables (`metadata_photo`, `metadata_video`, …) are created lazily and only for categories whose schemas declare metadata; the catch-all "other" category has no metadata table at all, which is why `POST /data/records/:id/metadata` rejects records of unmapped types.

A few invariants matter for callers:

- **Owner-scoped deduplication.** `(owner_id, original_filename, content_hash)` is unique. `POST /data/records` does a pre-flight lookup against that triple and, if it hits, returns the existing record with `deduped: true` rather than letting the database raise a constraint violation. The behaviour is therefore idempotent from the caller's perspective: registering the same bytes twice is safe.
- **Derived-child deduplication is parent-scoped.** A thumbnail with the same `content_hash` and `parent_id` as an existing thumbnail is deduplicated even though the original-filename machinery doesn't apply.
- **Soft-delete, not hard-delete.** Records carry `deleted_at`; the sync engine relies on the tombstones being present.
- **Time is HLC.** All `updated_at` values are HLC strings produced by the node's clock, and `?updated_after=` filters compare lexicographically against them.

The SQLite adapter exposes generic `put` / `get` / `query` primitives plus a `getRawDatabase()` escape hatch for sibling subsystems (the sync-state store, the per-app namespace store, the installer). It does **not** enforce access control itself: every grant check happens in the HTTP layer in front of it. This split is deliberate — internal callers (sync engine, installer, watcher) reach into the adapter directly under system identities and shouldn't be paying the per-row access cost.

`POST /data/records` accepts bytes in two shapes. The *key-ref* shape assumes the caller has already uploaded the blob (via a presigned token) and is now registering the metadata around an existing object-storage key. The *filePath* shape lets the caller name a local path that the server itself reads, hashes, and ingests; it exists for the watcher and for the local CLI experience where it would be silly to make the caller round-trip its own bytes through HTTP.

Read paths follow the obvious shape: `GET /data/records` paginates the table, filters out anything the calling app can't read, and orders by `updatedAt` descending; `GET /data/records/:id` is the singleton form; `GET /data/types` reports the per-type counts of records the caller can actually see, which is the surface the Drive UI uses to populate its type sidebar.

## App-specific syncable data plane

In parallel with shared records, each installed app gets its own isolated data plane addressable under `/app-data/`. This is where an app stores private state that needs to follow the user across devices but isn't meant for other apps to read or write.

The shape is intentionally narrow:

- `POST /app-data/db/:table` / `PATCH` / `DELETE` / `GET` operate on rows in one of the tables the app declared in its manifest. Other apps' tables are not addressable.
- `PUT/GET/DELETE /app-data/files/:subKey` operate on file blobs in the app's own object-storage namespace.

Isolation is enforced two ways. At the HTTP layer, the route handler extracts the calling app's id from the validated HMAC header and refuses to operate on tables the app didn't declare. At the sync layer, each per-app sync engine is constructed against a *narrowed* namespace store that exposes only that app's tables; even a bug in the sync engine couldn't carry one app's rows into another's channel because the rows are not visible to its scan.

Shared records and app-specific data are kept on completely separate sync channels (see *Sync orchestration*), so a slow per-app channel cannot back up the user-visible shared-data sync.

## Object storage

The local object store (`packages/storage-fs`) is a content-addressed filesystem under `~/.starkeep/objects/`. Keys are deterministic — `shared/<category>/<2-char-shard>/<sha256>` for shared records, with a 256-way fan-out from the first two hex characters of the hash, and a per-app prefix for app-specific blobs. The adapter exposes `put`, `get`, `has`, `delete`, `list`, `resolvePath`, and `putSymlink`; a sidecar `.meta.json` stores the content type and any metadata next to each blob. Deletes and metadata reads tolerate `ENOENT` so callers don't have to pre-check.

The interesting affordance is `putSymlink`. The watcher uses it to make a record whose canonical bytes live at a path on the user's disk *appear* in the object store at the content-addressed key, without copying the bytes. The rest of the system can then treat that record as it would any other; the storage layer transparently follows the symlink on read.

For the cloud side, the local server uses an `HttpObjectStorageAdapter` that talks to the cloud server's S3-backed object store via presigned URLs. The local FS adapter is canonical: a missing remote blob is something the sync engine notices and re-uploads, not something that requires recovery from the cloud. `GET /data/records/:id/file-url` always checks the local cache first and only mints a remote presigned URL when the bytes really aren't on this box.

Locally, file traffic uses two patterns. *Token uploads* go through `POST /files/presign` (which checks the calling app's category write grant and mints a short-lived token over a per-startup HMAC secret) followed by `PUT /data/files/upload/:token` (which validates the body's hash matches what the token committed to). *Direct ingestion* through `POST /data/files?type=X` lets a trusted caller hand bytes over in one round-trip. The per-startup token secret is intentional: every restart invalidates all outstanding upload/read tokens, which is fine because callers regenerate them on demand and the tokens are never meant to be persisted by the consumer.

## Access control

The access-control model (`packages/access-control`) is the bridge between "apps" and "data". Three kinds of grants live in `shared_access_grants` rows keyed on `(app_id, type_id)`:

- `access = "read"` lets the app see records of that type.
- `access = "readwrite"` additionally lets the app create, update, and delete them.
- `metadata_write = 1` is an orthogonal, stricter capability that lets an app write category metadata even without `readwrite` on the record itself. The intended consumer is the thumbnail/transcode path, where a worker needs to attach derived metadata to records it doesn't otherwise own.

Enforcement is a small set of helpers (`appCanRead`, `appCanWrite`, `appCanReadCategory`, `appCanWriteCategory`, `appCanWriteMetadataCategory`) that the HTTP handlers call before they touch the adapter. A denial is uniformly a `403` with a message naming the missing grant.

Two appIds are hardwired into the package as **all-access**: `starkeep-drive` (the Drive system app) and `LOCAL_WATCHER_APP_ID` (the watcher). The helpers short-circuit to "true" for these identities without consulting the grants table. Drive is all-access because it is the user's general-purpose Browse-everything UI; the watcher is all-access because it ingests bytes whose type isn't known until the file extension is inspected. Both still authenticate via HMAC like any other app, but the access check is a no-op.

Category mapping (`categoryOf(type)`) is the layer that makes type-level grants behave as category-level enforcement for file operations. An app granted `readwrite` on `photo.jpg` can write any blob whose key is under `shared/photo/…`, including `photo.png` and `photo.heic`, because they all resolve to the same category. The package's README treats this as intentional — grants are described in user terms ("photos") even when they're stored in type terms — but it is the most surprising part of the model and the place where careful manifest design matters most.

## Cloud authentication broker

The local server is the user's Cognito session manager. Local apps never see the refresh token, the id token, or the STS credentials; they ask the local server to perform cloud operations and the local server signs those operations on their behalf.

The entry points (`cognito-auth.ts`, plus the `/auth/*` HTTP routes) are:

- `POST /auth/login` — email/password, exchanged with Cognito's `InitiateAuth`. The flow handles the `NEW_PASSWORD_REQUIRED` challenge by accepting the new password and replaying with `RespondToAuthChallenge`. On success it stores the refresh token and id token in `~/.starkeep/auth.json`.
- `POST /auth/tokens` — accepts tokens minted by an out-of-process flow (e.g. a hosted-UI redirect handled by admin-web) and persists them the same way. This is what lets the admin-web Cognito flow feed credentials in without the local server itself implementing the browser-side OAuth dance.
- `POST /auth/logout` — clears both files.
- `GET /auth/status` — reports whether a live id token exists.

Behind those endpoints, two refresh paths run independently. The id token / refresh token pair is refreshed on a one-hour timer (the JWT's `exp` claim is decoded locally and the token is treated as stale five seconds before expiry). The STS credentials are exchanged via `GetIdentityPoolCredentials` whenever a fresh id token lands; the resulting credentials are written to `~/.starkeep/cloud-credentials.json` and are *re-read from disk on every cloud adapter call* rather than being held in memory. The disk-roundtrip pattern is deliberate: it lets an external process rotate the credentials file without restarting the server.

The supervisor watches the id-token liveness gate: `idTokenIsLive()` decodes the stored JWT and inspects `exp`. Sync exchanges are simply skipped while the gate is closed, which avoids a thundering herd of 401s every time the user's network has been off for longer than the token's lifetime. When a refresh succeeds, the refresh callback calls `supervisor.kick()` to reset every per-engine backoff and run all engines immediately, which is the path that drains accumulated local writes once auth is back.

## Sync orchestration

The local server runs the sync engine; this section is about *how it runs it*, not how the engine itself works.

The supervisor (`sync-supervisor.ts`) owns N+1 sync engines. One is the *Drive channel*: always on, attributed to the `starkeep-drive` identity, responsible for the entire shared-records data plane. The other N are *per-app channels*: one per installed non-system app, each responsible only for that app's app-specific tables and blobs. System apps (Drive itself and the watcher) do not get their own channels — their shared-record writes ride the Drive channel under Drive's identity.

Each engine has three timing inputs:

- An **idle tick** every `exchangeIntervalMs` (default 30 s) that runs `engine.exchange()` whether or not anything has changed locally.
- A **nudge** debounced at `nudgeDebounceMs` (default 500 ms) that fires after a local write to the engine's data plane. The nudge cancels the idle tick, runs an exchange immediately when it fires, and resets the tick.
- A **per-engine exponential backoff** capped at 5 minutes that replaces the tick interval after a failed exchange. Success resets back to the default.

`POST /sync/pause` clears every timer; `POST /sync/resume` schedules an immediate exchange on every engine; `POST /sync/now` is the same as resume without the "stop first" step. `GET /sync/status` reports per-engine state including current backoff, last error, and last successful exchange.

The supervisor exposes one more method internally: `rescan()`, called by the installer whenever an app is installed or uninstalled. It diffs the registry against its current engine set, creates engines for newly installed apps, and stops engines for removed ones — so installing a new local app starts syncing it without restarting the process.

There is one cross-cutting detail worth knowing: a local write to *any* data plane nudges *every* engine, not just the engine that would have something to push. The engines short-circuit internally when they have no new rows, so the cost is small, but it does mean nudge volume scales with installed apps. This is observable in `/sync/status` as engines that "exchanged" but moved no data.

## Filesystem watcher

The watcher (`watcher.ts`) lets the user point the server at a directory on disk and have its contents become shared records automatically. It is implemented as a `WatchManager` that owns a set of `Watch` instances, each restored from `watches.json` on startup.

A watch has three lifecycle states. *Scanning* is the initial full walk: every file under the watched path is hashed (SHA-256), inserted into the private `watch_files` table that maps disk path → record id, and registered as a shared record under the watcher's all-access identity. *Watching* is steady state: a Node `FSWatcher` observes the directory and reacts to add, modify, and delete events by rehashing or tombstoning as needed. *Error* is the terminal state for permission denied, path no longer exists, and similar conditions.

Concurrency and limits live here too: at most four files are hashed in parallel; files larger than 100 MB are skipped with a logged warning; a small default exclusion list (`.DS_Store`, `Thumbs.db`, `.gitkeep`) is hard-coded and supplemented by user-supplied include/exclude glob patterns. `recursive` is a per-watch flag.

The `watch_files` table is a watcher-internal concern: it is in the same SQLite database as user data but does not appear in any sync channel and is never exposed over the HTTP surface as data. Its job is to let the watcher answer "have I seen this file before, and if so at what hash?" without scanning every shared record.

The HTTP surface for the watcher splits into two groups. `POST /watches`, `GET /watches`, `GET /watches/:id`, `DELETE /watches/:id`, and `GET /watches/:id/files` are the admin-facing CRUD that admin-web drives. `GET /watches/file-status?path=…` and `GET /watches/directory-status?path=…` are point-lookups used by the File Provider integration to decorate items in the OS file browser, and `GET /browse?path=/` is the hierarchical view (watched directories plus a virtual "Library" of records that aren't in any watch) used by the same integration.

## Change broadcasting (`/events`)

`GET /events` is a Server-Sent Events endpoint. Every connected client receives a `change` event whenever the SDK's change notifier fires, regardless of which plane the change happened on. This is what the Drive UI and admin-web use to refresh in-place rather than polling. The server writes a comment-line keepalive (`: ping`) every 25 seconds to each connection to keep proxies and OS-level idle disconnects from closing it.

The fan-out is intentional and broad: the same notifier that fires on local writes also fires when the sync engine applies remote changes, so a watcher event on one device produces a `/events` push on every other device the user has online.

## Administrative surface

`POST /admin/apps/install` accepts an app manifest, runs the installer (which writes registry rows, mints an HMAC secret, and creates declared grants), and returns `{ appId, hmacSecret }` to the caller. `DELETE /admin/apps/:appId` runs the corresponding uninstaller. `GET /admin/apps` lists installed apps with their grants but never returns secrets. All three are loopback-authorized per the model above.

`GET /cloud/data/types` and `GET /cloud/data/records` are a small read-only proxy: the local server signs requests to the cloud server with the user's id token and pipes the results back. The intended consumer is the Drive UI's "show me what's in the cloud that isn't here yet" view; the alternative — having the UI obtain cloud credentials directly — would defeat the broker model.

## Open questions

- The cloud proxy currently exposes only `/types` and `/records` (read paths). Are there cases where the admin UI needs a write proxy, or is the deliberate scope read-only-by-design?
- The watcher's 100 MB skip threshold and the 4-way hash concurrency are hard-coded constants. Are these placeholder values pending tuning, or are they considered settled for now?
- `PATCH /config` ends with a process exit, relying on an external supervisor to restart the server. Is the assumption that admin-web is always running under a supervisor (launchd / systemd / a parent process), or is there a fallback for ad-hoc CLI runs?

---

# Part 2 — Review and evaluation

## Questionable purposes

**`/browse` and `/events` violate the loopback-authorized set's own principle.** The justification for skipping HMAC on the loopback-authorized routes only holds when those routes carry no per-app user data: configuration, auth brokering, app install, watch CRUD. `/browse` and `/events` are inside that set but expose record-level data — `/browse` enumerates filenames, sizes, MIME types, and timestamps across the whole database (with no per-app filter and a hard-coded 100 000-row scan limit in the Library branch); `/events` broadcasts every change-notifier event, with record ids and event types, to every connected SSE client. Any process that can reach `127.0.0.1:9820` reads them, regardless of which app it is or whether it is an app at all. Installed apps that go through the data plane have to declare grants to see the same information. The mismatch is the part that warrants attention: either these endpoints should sit behind app HMAC and per-app filtering (which is invasive — admin-web and Drive both consume them and would need app identities), or the principle should be explicitly weakened to "loopback + admin scope + a known set of user-data leaks the file-provider integration and live-update UI require".

> **Resolved (2026-06-01, in progress):** Investigation found `/browse` has zero consumers across the starkeep umbrella (it was conceived for a File Provider integration that does not exist) and `/events` has one consumer — `starkeep-apps/photos/src/lib/usePhotoSync.ts` — which uses it purely as a kick signal and discards the payload. The prerequisite refactor (photos app no longer chooses between local/cloud data servers; deployment context picks one) was completed in the same session; the followups — delete `/browse` and tighten `/events` (strip payload or gate behind HMAC + per-app filtering) — are deferred pending the photos refactor being verified in both runtime contexts.
>
> **Resolved (2026-06-01, complete):** Code change to `starkeep-core/apps/local-data-server/server.ts`. Deleted the `/browse` route and removed its entry from `LOOPBACK_AUTHORIZED_PATTERNS` and from the `LISTEN_HOST` comment; dropped the now-unused `extensionForMime` helper. Tightened the `/events` SSE fan-out to emit a payload-less kick (`data: \n\n`) instead of `JSON.stringify(event)`; the only consumer (`usePhotoSync.ts`) already discards the payload and calls `fetchSince` through the HMAC-gated data plane, so the visible record-id / event-type stream over loopback is now gone. Local typecheck (`tsc --noEmit -p apps/local-data-server`) clean.

**Loopback as the boundary is implicit, not enforced.** Separately from the `/browse`/`/events` question, the rule for "which routes skip HMAC" is encoded as "anything not under `/data/`, `/cloud/`, `/sync/`, `/app-data/`, `/files/`" — an implicit deny-list. A future route added under, e.g., `/internal/` or `/metrics/` inherits "no HMAC needed" silently, and a future move off loopback (containerization, an explicit `--listen-host`, a reverse proxy in front) would quietly de-authenticate all of them at once. An explicit per-route `requireLoopbackOnly` middleware (or even an allow-list constant next to `APP_AUTH_REQUIRED_PREFIXES`) would make both the boundary and its load-bearing role visible at the call site.

> **Resolved (2026-06-01):** Code change to `starkeep-core/apps/local-data-server/server.ts`. Replaced the deny-list with an explicit allow-list constant `LOOPBACK_AUTHORIZED_PATTERNS`. Hoisted `LISTEN_HOST` to a top-level constant with a comment explaining its load-bearing role. Added a fail-closed branch: if `BIND_IS_LOOPBACK` is false, every loopback-authorized route returns 403 immediately. Today `BIND_IS_LOOPBACK` is `true`; the change is structural.

## Behavior inconsistent with purpose

**Nudge fans out to every engine on any write.** A local write to the photos app's app-specific table nudges the Drive channel and every other per-app channel too. Each engine short-circuits when it has no work, so the cost is small, but the behaviour does not match the per-app-channel design's stated reason for existing (isolation, so one channel can't slow another). Nothing observably breaks; it just means a chatty app increases tick volume across the system rather than just on its own engine.

> **Resolved (2026-06-01):** Wider fix landed. Investigation revealed a related and more serious under-nudge: app-specific data writes (`/app-data/db/:table`, `/app-data/files/:subKey`) emitted no change event at all, so per-app sync engines were never nudged by their own data plane (only the 30 s idle tick). Fix: extended `ChangeEvent` with optional `originAppId`, hoisted the `ChangeNotifier` out of the SDK so the local-data-server can share one instance with the app-specific factory, made the factory emit `local-change-recorded` tagged with the calling appId on every successful write, and changed the supervisor's subscriber to route the nudge — `originAppId === undefined` → Drive only (shared records), `originAppId` set → that app's engine only. Six files: `packages/sync-engine/src/types.ts`, `packages/sdk/src/{sdk,types}.ts`, `packages/shared-space-api/src/app-syncable/factory.ts`, `apps/local-data-server/{server,sync-supervisor}.ts`. All 136 affected tests pass.

## Missing behaviors

**No persistent revocation of HMAC secrets short of uninstall.** Once an app is installed, its HMAC secret is valid until `DELETE /admin/apps/:appId`. There is no "rotate this app's secret" affordance and no "this secret is compromised, refuse it" affordance. For a system whose access control is otherwise quite expressive, this is a meaningful gap if the secret ever leaks.

> **Resolved (2026-06-01, deferred):** Real gap, no concrete threat model today. Captured as a `todos` meta-doc at `docs/todos-local-server-permissions-2026-06-01.md` (codebase-manager doc id 3, topic `local-server-permissions`) for a future security-hardening pass. Revisit before any deployment context where third parties install apps the user did not author.

**No surface for repairing watch state when files move underneath a watch.** The watcher reacts to add/modify/delete on the watched directory, but a `mv` across two watches, or out of any watch entirely, is observed as a delete on one side and either an add on the other or nothing at all. The shared record on the deleted side is tombstoned even though the bytes still exist elsewhere. There is no reconciliation pass that notices the same `content_hash` reappearing under a different path and re-binds the record rather than creating a new one with a fresh id.

> **Resolved (2026-06-01, dismissed):** "Moved file becomes a new record" is accepted as current-state behaviour. The bytes still exist on disk regardless, so no data is lost; the cost is a record-id discontinuity for the moved file and a redundant tombstone+record pair on the sync channel. Not a behavioural bug, just a missing convenience. No follow-up action.

## Behavioral bugs

None identified with high confidence at the local-server level on this read. (Behaviour inside `packages/sync-engine` is explicitly out of scope.)

## Potential gaps

None identified with high confidence.
