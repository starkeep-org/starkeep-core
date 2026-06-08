# Developing a local app for Starkeep — Functional Review (2026-06-08)

Scope: the `developing-a-local-app-for-starkeep` topic. 

Part 1 is a **how-to guide** for a developer building a new local Starkeep app. Part 2 is the usual functional review of gaps and bugs surfaced while writing Part 1.

---

# Part 1 — How to build a local Starkeep app

## What you are building

A local Starkeep app is a directory on the operator's machine with three things in it:

1. A `starkeep.manifest.json` at the root, declaring the app's identity, the shared-data extensions it wants to touch, and any app-private tables it wants the platform to sync.
2. (Usually) a long-running dev/serve process — Next.js, Vite, an Express server, a CLI watcher — that the operator starts and stops from admin-web.
3. (After installation) a credentials file written by admin-web to `$STARKEEP_DATA_DIR/app-creds/<appId>.json` (default `~/.starkeep/app-creds/`), containing the app's HMAC secret and the local-data-server URL. This is the only credential your process needs to authenticate; you load it via `@starkeep/app-client`, never by hand.

That is the entire surface. The platform takes care of: discovering your app, validating the manifest, materializing your declared tables, gating shared-data access by your declared extensions, signing the per-app secret, spawning your process on a free port, and tearing the lot down on uninstall. Your job is to write the manifest, point your process at the data-server, and consume the HTTP API. There is no in-process SDK to embed and no daemon protocol to implement — the local-data-server (`apps/local-data-server`) already runs as a separate process on `127.0.0.1:9820` and exposes everything you need over plain HTTP.

(Aside on `@starkeep/sdk`: despite the name, this package is not an app-development client library. It is the internal engine that wires together storage adapters, the sync engine, access control, and query orchestration; the local-data-server instantiates it to do its work. An app that "embedded the SDK" would be running its own parallel data engine against its own adapters, bypassing `shared_app_registry`, the supervisor, and the access-grant checks that make multi-app coexistence safe. Local apps are always thin HTTP clients against the data-server — that is the only supported shape.)

The rest of Part 1 walks through this in the order you would actually do it: pick a directory, write the manifest, install, authenticate, call the data-server, run a dev loop. The Photos app at `starkeep-apps/photos` is the worked example referenced throughout.

## 1. Pick a directory under a configured parent dir

Discovery is filesystem-based. Admin-web scans every directory listed in `~/.starkeep/config.json` under `appParentDirs`, treats each immediate subdirectory as a candidate app, and reads its `starkeep.manifest.json`. The default parent dir is `<starkeep-core>/../starkeep-apps`, seeded on first read.

Practical consequence for development:

- Place your new app at `<starkeep-apps>/<app-id>/` (or add a custom parent dir to `appParentDirs` and put it there). The directory name must match the `id` field in your manifest — the install route rejects mismatches with a 400.
- An app becomes "visible" the moment a manifest exists at that path. There is no registration step before install. Conversely, an app in an unconfigured parent dir can never be installed via the UI.
- An app that fails to parse its manifest is silently dropped from the discovery list and will fail again with a structured error on install.

## 2. Write the manifest

The manifest is the contract everything else hangs off of. Its schema is in `packages/admin-manifest/src/schema.ts`; the validator in `packages/admin-manifest/src/validate.ts` is what the installer runs.

A minimum-viable local-only app manifest looks like:

```json
{
  "id": "my-app",
  "name": "My App",
  "version": "0.1.0",
  "tier": "community",
  "targets": ["local"],
  "localRun": {
    "command": "pnpm",
    "args": ["dev"],
    "portFlag": "-p"
  },
  "infraRequirements": {
    "fileAccess": [
      {
        "extensions": ["md", "txt"],
        "access": "readwrite",
        "metadataWrite": false,
        "rationale": "App stores notes as markdown/text."
      }
    ],
    "appSpecificSyncable": {
      "tables": [
        {
          "name": "note_pin",
          "columns": [
            { "name": "record_id", "type": "text", "primaryKey": true, "notNull": true },
            { "name": "pinned_at", "type": "text" }
          ]
        }
      ]
    }
  }
}
```

The fields you actually choose, in priority order:

### Identity (`id`, `name`, `version`, `tier`, `targets`)

- `id` is the stable kebab-case key the registry uses; it must equal the directory name. Pick it carefully — renaming requires uninstall+reinstall, which drops your app-specific tables.
- `tier` is `official` | `verified` | `community`. The installer does not currently treat tiers differently, but the admin UI surfaces it on the app card.
- `targets` is the list of install surfaces (`local`, `cloud`, or both). Default `["local"]`. Setting `["cloud"]` will hide the app from the local-apps list entirely; setting both means the same manifest drives both installers.

### Shared-data access (`infraRequirements.fileAccess`)

`fileAccess` is the only place an app declares its claim on the shared-data plane (the user's typed records under `shared_records`). Each entry enumerates a lowercase, dotless extension list, an access mode (`read` or `readwrite`), and a `rationale` string that the operator sees on the install screen.

Two things to be deliberate about:

- **Extensions, not wildcards.** Every extension is matched against the platform's known set; unknown extensions are rejected. There is no "all images" macro — you list `jpg`, `jpeg`, `png`, … explicitly, the way Photos does. The `fileAccessAll: true` escape hatch is reserved for the built-in Drive app and is rejected by the validator for anything else.
- **`metadataWrite: true` is its own permission.** It governs whether your app may write into the per-category metadata tables (EXIF for images, tag rows, etc.). Read-only consumers leave it false.

`fileAccess` only confers rights on the *shared* plane. Your app's app-specific tables (next section) are unconditionally available to your app and require no grant.

### App-specific data (`infraRequirements.appSpecificSyncable`)

This block carves out a private namespace for your app — SQLite tables only your app can address, optionally with a per-app object-storage prefix for blobs. Tables are declared as columns; the installer runs `CREATE TABLE IF NOT EXISTS <appId>_syncable_<table>` against the local database and appends two reserved columns to every row: `updated_at` and `deleted_at` (used by the inline-HLC sync change tracking; you cannot name your own columns either of these — the schema validator refuses).

- `tables[].columns[]` is `{ name, type, notNull?, primaryKey? }` with types `text | integer | real | blob | boolean`. Standard SQLite.
- `files: true` opts you into a sync-eligible per-app file prefix at `apps/<appId>/syncable/`, addressable via `/app-data/files/:subKey`. It also provisions the framework-reserved `_starkeep_sync_records` table that drives byte-sync. Apps with row-only state leave this off.

A common confusion: "I write thumbnails for the user's photos — does that go in app-specific files?" No. **Derived bytes produced from shared data are themselves shared records** authored by your app (with a `parent_id` linkage), not app-specific files. App-specific files are for blobs that belong to *the app itself* and would be meaningless to other apps.

### Local run command (`localRun`)

`localRun` tells admin-web how to spawn your process. The shape:

```json
"localRun": {
  "command": "pnpm",
  "args": ["dev"],
  "portFlag": "-p",
  "cwd": "."
}
```

- If `portFlag` is set, admin-web allocates a free port at start time and appends `[portFlag, "<port>"]` to your args. Drop `portFlag` only if your app picks its own port.
- `cwd` is relative to the manifest directory; default `.`.
- Omit `localRun` entirely if your app has no long-running process (a pure CLI utility, for example). It will still install; it just won't get a Start button.

The Photos manifest uses `pnpm` + `dev` + `-p` *without* a `--` separator. The comment in `apps/admin-web/src/lib/exec-commands.ts` records why: with `--`, pnpm passes the separator through verbatim to Next, which then misinterprets `--` as a positional. Mimic the Photos pattern if you are using pnpm.

### Cloud-only fields (ignored locally)

`infraRequirements.compute`, `additionalResources`, `sharedResources`, `brokerPower`, `requiredPermissions`, `optionalPermissions` are consumed only by the cloud installer. The local install path validates them (so the manifest must be schema-valid) but does not act on them. If your app targets both surfaces, declare these once and let each installer pick what it needs. The Photos manifest is the worked dual-target example: a `compute` block with two Lambda handlers that the cloud installer wires into API Gateway, ignored entirely by `pnpm dev` locally.

## 3. Install and let the platform set you up

With the manifest in place:

1. Open admin-web at `http://localhost:3000` and navigate to the Apps page. Your app should appear with status `not_installed`. If it does not, check that its directory is under a configured parent dir and that the manifest parses (admin-web silently skips malformed ones at discovery time).
2. Click Install. Admin-web shows the manifest's `infraRequirements.fileAccess` entries with their rationales as the approval surface.
3. On approval, admin-web POSTs `{ appId, approved: true }` to its own `/api/apps/install`, which reads the manifest from disk, forwards it to the local-data-server's `POST /admin/apps/install`, and on success writes `$STARKEEP_DATA_DIR/app-creds/<appId>.json` at mode `0o600`. That file contains `{ appId, hmacSecret, dataServerUrl }` — the bridge your process will read at startup via `@starkeep/app-client`'s `loadAppCredentials(appId)`. Credentials live under the host's data directory, not in the app's source tree, so apps no longer need to `.gitignore` them.

What the data-server does on its end (driven by `installLocal` in `packages/admin-installer/src/local/installer.ts`) is a five-step idempotent ledger keyed on `(appId, operation, step)`:

1. Insert a `shared_app_registry` row with `status='installing'`.
2. Write one `shared_access_grants` row per `(appId, extension)` from your `fileAccess`.
3. `CREATE TABLE IF NOT EXISTS` for each declared `appSpecificSyncable.tables` entry (plus `_starkeep_sync_records` if `files: true`).
4. Register the app's namespace in the shared `app_syncable_namespace` table so the sync engine picks it up.
5. Flip registry `status` to `active`.

Each step records `pending` / `done` / `failed`. Re-running install on an active app is a no-op that returns the same HMAC secret — useful for re-deriving `.starkeep-local.json` without dropping your app-specific tables. After the call returns, the data-server invokes `supervisor.rescan()` so your per-app sync channel starts immediately rather than waiting for the next supervisor tick.

If install partially fails, admin-web's Apps page exposes the ledger via a per-app **Steps** dialog (it auto-opens on failure) — that's where to look first before assuming the registry is wedged.

## 4. Authenticate from your process

The local-data-server's auth model for app traffic is straightforward HMAC-SHA256 over the request body, validated against the app's row in `shared_app_registry`:

- **Header 1:** `X-Starkeep-App-Id: <your-app-id>`
- **Header 2:** `X-Starkeep-App-Sig: hex(hmac_sha256(hmacSecret, "<appId>:<body>"))`
- **Body in the signature** is the raw request body for `POST` / `PATCH` / `PUT` / `DELETE`, and the empty string for `GET` / `HEAD`. Binary bodies are signed as the raw bytes; the signature must match the bytes that hit the wire.

The platform package `@starkeep/app-client` (in `starkeep-core/packages/app-client/`) owns all of this: `loadAppCredentials(appId)` reads from `$STARKEEP_DATA_DIR/app-creds/`, `signRequest` / `signedFetch` produce the headers (signing raw bytes — no string detour for binary bodies), and `createNextProxyHandler` is a one-liner Next route handler that proxies same-origin browser traffic through to the data-server with HMAC added server-side. Photos's `app/api/local-data/[...path]/route.ts` is two lines: `import { createNextProxyHandler } from "@starkeep/app-client"` and re-export the handler.

A few practical notes:

- **Credentials are read at server-side startup.** Never expose `hmacSecret` to the browser. The recommended shape is the `createNextProxyHandler` proxy — same-origin URL for the browser, secret stays server-side, no CORS.
- **HMAC rotation requires a process restart.** The rotation case is uninstall+reinstall (no in-place rotate exists yet — see Part 2). The app-client caches credentials in-process; the file rewrite happens while your process is down, so the new value is picked up cleanly on next start.
- **The bind boundary matters.** The local-data-server only enforces HMAC on the per-app routes; a small set of administrative routes (`/health`, `/config`, `/auth/*`, `/admin/*`, `/watches/*`, `/events`) are loopback-gated rather than HMAC-gated, and a separate token-in-URL scheme covers `<img src>`-embedded file URLs. You will not normally call any of those from an app, but it explains why your app does not need credentials to hit `/health` for a connectivity check.

## 5. Read and write shared data

Once authenticated, the shared-data HTTP surface (in `apps/local-data-server/server.ts`) is the same one admin-web and the watcher use. The relevant endpoints for an app:

| Endpoint | Use |
|---|---|
| `GET /data/types` | List the record types your app may see, derived from your `fileAccess` grants. |
| `GET /data/records?limit=&updated_after=` | Page through records. With no `type` filter, scoped to your granted extensions — Photos uses this to fetch all granted image types in one call. |
| `POST /data/records` | Register a new shared record (typically after uploading bytes via presign — see below). |
| `GET /data/records/:id` | Fetch a single record. |
| `GET /data/records/:id/file-url` | Get a short-lived URL to the underlying file bytes — embeddable in `<img>` etc. |
| `GET /data/records/:id/metadata/:category` | Read per-category metadata (EXIF, etc.). |
| `POST /data/records/:id/metadata` | Write metadata (requires `metadataWrite: true` on the relevant `fileAccess` grant). |
| `POST /files/presign` | Mint a presigned S3 PUT URL for large uploads. The canonical flow for files > a few MB. |

Two flow patterns worth knowing:

- **Inline file upload (small files):** `POST /data/files` with the bytes in the body, or `POST /data/records` with the content already addressed by hash. Subject to the local server's body-size handling.
- **Presigned upload (large files, matches the cloud surface):** `POST /files/presign` → `PUT` the bytes to the returned URL → `POST /data/records` with `contentHash` and `sizeBytes`. The data-server registers by content hash, which deduplicates across calls automatically. Photos uses this path unconditionally (`addPhotoFromPath` in `src/lib/data-server-client.ts`) so the same code works against the cloud surface, which enforces a ~7 MB API Gateway body cap.

Every shared-data write is scoped by access control to your declared extensions. A request to write a record whose `type` is outside your `fileAccess` will be rejected by the enforced database adapter; it is not a per-route check.

## 6. Read and write app-specific data

The app-private namespace is at `/app-data/`:

| Endpoint | Use |
|---|---|
| `GET /app-data/db/:table?col=val&…` | Query rows from one of your declared tables. Query params become equality filters. |
| `POST /app-data/db/:table` `{ row: {...} }` | Insert a row. |
| `PATCH /app-data/db/:table` `{ where, patch }` | Update matching rows. |
| `DELETE /app-data/db/:table` `{ where }` | Delete matching rows. |
| `PUT /app-data/files/:subKey` | Upload a blob (only when `files: true`). |
| `GET /app-data/files/:subKey?expiresIn=` | Get a presigned URL for a blob. |
| `DELETE /app-data/files/:subKey` | Delete a blob. |

Every `/app-data/` operation is scoped to your app's id by the data-server's `appSpecificFactory` — you address tables by their bare declared name (e.g. `image_enriched`), and the platform translates that to `<appId>_syncable_<table>` internally. You cannot read or write another app's app-specific data through this surface even with a valid HMAC.

If your manifest did not declare any `appSpecificSyncable`, the `/app-data/` routes return 404 with `"App did not declare appSpecificSyncable in its manifest"`. Add a table to the manifest and reinstall.

## 7. Observe changes

The data-server exposes a unified SSE stream at `GET /events` (loopback-gated, no HMAC). Subscribe from your server-side process to receive `local-change-recorded` and sync-driven `pull` / `conflict` events as they happen. There is no per-app filtering on this stream — every change emits — so your app is responsible for filtering by the record ids or types it cares about.

The browser side of Photos uses `usePhotoSync.ts` to consume this through the same `/api/local-data` proxy. The pattern generalizes to any thin-client app.

## 8. The dev loop

Once installed:

- **Start:** admin-web's Start button POSTs `/api/exec/daemon` with `action: "start"`. That route resolves your `localRun` block, allocates a free port via bind-to-0, spawns the command detached with stdio piped to `$STARKEEP_DATA_DIR/pids/<appId>.log` (default `~/.starkeep/pids/`), and writes a `.pid` + `.meta.json` recording the chosen port. The Apps page surfaces the bound port as a link.
- **Logs:** tail `$STARKEEP_DATA_DIR/pids/<appId>.log`. The file is truncated on every start, so it reflects only the current run.
- **Status:** `GET /api/exec/daemon/status?id=<appId>` prefers a TCP probe of the recorded port over `process.kill(pid, 0)` because `pnpm dev` is a launcher whose own PID may exit once Next/Vite takes over. The status route only garbage-collects the bookkeeping when both the port probe fails and the recorded PID is dead.
- **Stop:** the Stop button signals the recorded PID's process group (`SIGTERM` to `-pid`, because pnpm spawns children). Port-based fallback exists for cases where the PID file was lost; it now refuses to signal anything that doesn't look like a known dev-server command shape (`pnpm | node | next | vite | npm`).

For iteration on the manifest itself:

- **Adding a `fileAccess` extension:** uninstall + reinstall (the access grants are written at install time only). Your `appSpecificSyncable` tables are dropped on uninstall, so anything you depend on there must come back from sync after reinstall, or you accept the data loss.
- **Adding an `appSpecificSyncable` table:** uninstall + reinstall, for the same reason — the installer uses `CREATE TABLE IF NOT EXISTS`, but no migration path runs against an existing app. Same caveat about table contents.
- **Changing `localRun`:** stop, reinstall (to re-derive `.starkeep-local.json` if needed), start. The daemon route reads `localRun` from disk on each start; no admin-web restart required.
- **Rotating the HMAC secret:** there is no exposed rotate operation. Uninstall + reinstall is the only path today, which drops your app-specific tables.

## 9. Optional: building one app for both local and cloud

If your manifest sets `targets: ["local", "cloud"]`, the same directory installs into both surfaces with the same id. The shape that makes this comfortable in practice is **a single data-source resolver in your client code** that picks between the local proxy and the cloud API Gateway based on runtime config. Photos's `src/lib/data-client.ts` is the worked example: it returns `{ baseUrl, headers }` for either target, and every call site goes through it. Locally it returns `/api/local-data` with no auth headers (the proxy adds HMAC server-side); against the cloud, it returns the API Gateway URL with a Cognito `Authorization: Bearer` token.

The HTTP surface is intentionally similar enough that most call sites are target-agnostic. The two real differences:

- **Cloud paths are prefixed with `/apps/:appId`** because the cloud-data-server is multi-tenant; the local data-server scopes by HMAC and uses bare paths.
- **Large uploads require presign on cloud** (API Gateway body cap). Using presign unconditionally makes both surfaces work with one code path, at the cost of one extra round-trip on the local hop.

The mechanics of how the cloud Lambda authenticates against DSQL, the per-app role assumption, and the cloud installer's API Gateway wiring all live in the `cloud-apps` and `cloud-server-auth` topics, not here.

---

# Part 2 — Review and evaluation

_All items raised in this review have been processed. See the deferred todos
in this topic for the work that was tracked rather than done inline._
