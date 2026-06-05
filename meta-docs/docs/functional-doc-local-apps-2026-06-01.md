# Local apps — functional doc — 2026-06-01

Scope: the `local-apps` topic and its children (`installing`, `starting`, `stopping`, `uninstalling`, `photos-example`). Concept-first description of what the local-app surface does today, followed by a review pass.

---

# Part 1 — Current state

## Overview

A **local app** in Starkeep is a third-party (or built-in) program that participates in the user's personal data plane via a stable identity, a declared data shape, and a permission grant. From the operator's perspective it looks like a tile in the admin UI with Install / Start / Stop / Uninstall affordances. From the system's perspective it is a row in `shared_app_registry`, a set of sync-eligible tables, a set of file-access grants, and (optionally) an OS process running on the operator's machine.

Three concepts organize the rest of Part 1:

1. **App discovery** — how the system learns which apps exist on disk and which are installed.
2. **Install / uninstall lifecycle** — what changes in the local data plane when an app is added or removed.
3. **Process lifecycle** — how the per-app web/CLI process is started, observed, and stopped.

A fourth section grounds these in the concrete **Photos sample app**, the only non-built-in local app currently shipped.

The boundary of "local apps" is sharp at two seams: the local-data-server, which owns the database the installer writes into, and the admin-web Next.js process, which owns process spawning and approval prompts. Both seams are crossed by plain HTTP — admin-web does not link the installer in-process; it POSTs manifests to the local-data-server's `/admin/apps/*` endpoints. Code paths for app processes are bare `child_process.spawn` calls with PID files, not a daemon supervisor.

## The local-app manifest

Every local app declares itself in a `starkeep.manifest.json` at the root of its directory. The manifest is the contract that drives every other lifecycle described below: discovery reads it, install validates and replays it into registry/grants/tables, the daemon route consults it for how to start the app, and the cloud installer reads the same file for cloud-side wiring. It exists in one place so the operator (during the approval gate) and both data-planes (local and cloud) see the same declaration.

At a high level the manifest has four kinds of content:

- **Identity** — a stable `id` (kebab-case; must match the directory name) plus human-readable name/description fields.
- **Shared-data access** — `infraRequirements.fileAccess`: a list of `{ extension, mode, metadataWrite? }` entries, optionally a Drive-only `fileAccessAll: true`. This is the only place an app declares its claim on the shared-data plane.
- **App-specific data shape** — `appSpecificSyncable.tables` (SQL DDL the installer materializes inside the app's private namespace) and `appSpecificSyncable.files` (a boolean opting the app into per-app file-bytes sync). Together these define everything the per-app sync channel will carry.
- **Run / compute** — `localRun` (command, args, optional port flag, optional cwd) for how admin-web should `spawn` the app locally, and a separate `compute` block consumed only by the cloud installer (ignored by the local lifecycle).

### Shared data vs app-specific data — the distinction the manifest commits to

This is the most important thing the manifest gets right or wrong, because it draws the line between two completely different planes that the local-data-server keeps strictly separated. A local app effectively chooses how much of each it wants:

- **Shared data** is the user-visible content layer: typed records (e.g. `photo.jpg`, `note.md`) living in the single `shared_records` table with content-addressed file bytes always backing every row. It is collaborative across apps — multiple apps can read or write the same record subject to per-type grants in `shared_access_grants`. It is owned by the user, not the app: it **survives uninstall**, syncs on the always-on Drive channel under the Drive identity, and is what other apps (including a future reinstall) can keep using. The manifest touches this plane only through `infraRequirements.fileAccess`, which is the operator's chance to consent to exactly which type-categories the app may read or write.

- **App-specific data** is the app's private namespace: SQLite tables the app declared in its manifest (addressed under `/app-data/db/:table`) and, optionally, file blobs in a per-app object-storage prefix (addressed under `/app-data/files/:subKey`, opt-in via `appSpecificSyncable.files: true`, which also provisions the framework-reserved `_starkeep_sync_records` table for byte-sync). No other app can address either half — the local-data-server's app-data router scopes every operation to the calling app's id. It is owned by the app, not the user: uninstall **drops** the tables and `rm -rf`s the per-app file prefix. It syncs on the per-app channel, isolated from shared-data sync so a chatty app cannot back up the user's content.

Practical consequences worth being explicit about, because they're easy to get backwards:

- File bytes exist on both planes, but they are not the same thing. Shared-data files are always present (every shared record has bytes); the `appSpecificSyncable.files` flag is about *app-specific* file blobs only, and is a meaningful opt-in — an app that only needs row state can leave it off.
- Derived bytes an app produces from shared data (thumbnails, transcodes) are *shared* records authored by the app, not app-specific data. They go into `shared_records` with a parent linkage, not into the app's private namespace.
- A category-scoped `fileAccess` grant only confers rights on the *shared* plane. The app does not need any grant to read or write its own app-specific tables and files — those are unconditionally available to the app that declared them.

The shared-data and app-specific-data topics each have their own functional doc that goes into the storage, indexing, and sync details; this section only documents what the local-app manifest commits to about each.

## App discovery

Discovery is a filesystem scan of one or more **parent directories**, each of which is expected to contain one subdirectory per app, each with a `starkeep.manifest.json` at its root.

- The parent-dir list lives in `~/.starkeep/config.json` under `appParentDirs`. The default — `<repo-root>/../starkeep-apps` (the sibling checkout) — is seeded on first read; an empty list is treated as an intentional "scan nothing".
- `GET /api/apps/list` walks each existing parent dir, reads every immediate child's `starkeep.manifest.json`, de-duplicates by manifest `id` (first parent wins), and joins the result against the local-data-server's `GET /admin/apps` to attach an install status. Malformed manifests are silently skipped at this stage — they will fail again on install with a structured error.
- A side effect of this design: an app is "visible" purely by virtue of having a manifest on disk in a configured parent dir. No registration step is needed to make Install show up; conversely, an app with no manifest at a configured path can never be installed via the UI.

The list endpoint degrades gracefully when the local-data-server is down: `installed` falls back to empty and every discovered app appears as `status: not_installed`.

## Install lifecycle

Installation has two layers — an **approval gate** in admin-web and an **idempotent step ledger** in the installer — separated by an HTTP boundary.

### Approval gate (admin-web)

`POST /api/apps/install` accepts `{ appId, approved }`. The endpoint rejects anything where `approved !== true`; the requirement is duplicated in the API layer specifically so a buggy or malicious UI cannot install behind the operator's back. (The admin UI is expected to display the manifest's `infraRequirements.fileAccess` grants for review before sending `approved: true`.) On approval the route reads the manifest from `<parent-dir>/<appId>/starkeep.manifest.json`, forwards it to the local-data-server, and on success writes a per-app secret file `<app-dir>/.starkeep-local.json` containing `{ appId, hmacSecret, dataServerUrl }` at mode `0o600`. That file is the bridge the app's own server process reads at startup to authenticate with the data-server.

### Idempotent step ledger (installer)

The local-data-server's `POST /admin/apps/install` calls `installLocal(db, manifest)` in `packages/admin-installer/src/local/installer.ts`. The function validates the manifest, mints (or reuses) an HMAC secret, and then runs five named steps under a step-ledger pattern. Each step is keyed on `(appId, operation, step)` in `shared_app_install_steps` with a `pending`/`done`/`failed` status; on retry, steps with `status='done'` are skipped, so a crashed install can be safely re-driven from the same request body.

The five install steps:

1. `create_app_registry_row` — inserts `shared_app_registry` with `status='installing'`.
2. `create_access_grants` — one `shared_access_grants` row per `(appId, extension)` from the manifest's `fileAccess`. Apps with `fileAccessAll: true` (Drive only) write no grant rows; the access functions grant them all-access by app id.
3. `create_syncable_tables` — `CREATE TABLE IF NOT EXISTS` per declared `appSpecificSyncable.tables`, plus the framework-reserved `_starkeep_sync_records` table if `files: true`. Reserved columns `updated_at` and `deleted_at` are appended to every table for inline-HLC sync change tracking.
4. `register_syncable_namespace` — records the namespace in the shared `app_syncable_namespace` table so the sync engine knows which tables belong to which app.
5. `mark_active` — flips registry `status` to `active`.

After the call returns, the local-data-server invokes `supervisor.rescan()` so the freshly-installed app's sync channel starts immediately rather than waiting for the next supervisor tick. The response `{ appId, hmacSecret }` flows back through admin-web, which is the only point at which the secret is visible — `GET /admin/apps` deliberately omits the HMAC.

### Idempotency and the "already installed" path

If `appRegistryRow` already shows `status='active'`, `installLocal` returns the existing secret unchanged and skips every step. This means re-running install on an active app is a no-op that's useful for rewiring an app's `.starkeep-local.json` without a true reinstall — a property the admin route does not currently expose explicitly, but that the installer guarantees.

### Built-in apps

Two apps are installed by the local-data-server at startup, by the same `installLocal` primitive: the **local watcher** (the FS-scanning ingester) and **Starkeep Drive** (the user-data-owner identity). These have synthesized manifests written inline in `apps/local-data-server/server.ts` rather than loaded from disk. From the registry/grants/sync perspective they are indistinguishable from third-party installs; they simply skip the admin-web approval flow because the operator's installing the data-server *is* the consent. Drive is the only app permitted to set `fileAccessAll: true`.

## Process lifecycle (start / stop)

Once an app is installed, the operator can ask admin-web to **start** its development server (typically Next.js or Vite) and **stop** it again. The data plane (database, files, sync) is fully decoupled from this — an app can be installed and syncing with no process running, and the process can be stopped without disturbing the registry or any data.

Daemon management lives in `apps/admin-web/app/api/exec/daemon/route.ts` (`POST /api/exec/daemon`) with a partner status endpoint at `…/daemon/status` and a small command registry in `src/lib/exec-commands.ts`. The registry separates two kinds of daemon by config shape:

- **Workspace daemons** in `DAEMON_COMMANDS` — `local-data-server` and `drive` — with a fixed pnpm filter and a fixed port (9820 and 9830).
- **Installed app daemons** in `APP_DAEMONS` — currently just `photos` — with a per-app `cwd` and a port-injecting `args(port)` callback.

The app-daemon shape exists because installed apps must not collide with each other or with admin-web's own port 3000, so the port is allocated at start time.

### Starting

For an installed app `id` keyed in `APP_DAEMONS`, the start path:

1. Allocates a free TCP port by binding `127.0.0.1:0`, reading the bound port from the kernel, and closing the socket. There is an acknowledged race between close and the child binding the same port; it's accepted as good-enough for local dev.
2. Opens `<repo-root>/.pids/<id>.log`, truncating on each start so the log reflects only the current run.
3. Spawns `pnpm dev -p <port>` with `cwd = <starkeep-apps>/<cfg.cwd>`, `detached: true`, and stdio redirected to the log fd. `child.unref()` lets admin-web's request finish without waiting on the child.
4. Writes `.pids/<id>.pid` with the child PID and `.pids/<id>.meta.json` with `{ pid, port, logPath }`. The meta file is what the status route and the UI use to know which port the app bound to.

Workspace daemons follow the same pattern but with a fixed port (when known) and `cwd = REPO_ROOT`.

### Status

`GET /api/exec/daemon/status?id=<id>` reads the PID file and, when a port is recorded in the meta file, prefers a **TCP probe** of `127.0.0.1:<port>` (with an IPv6 fallback) over `process.kill(pid, 0)`. This matters because pnpm dev acts as a launcher whose process may exit once the real server takes over; the launcher's PID can be dead while the app is happily serving on the port. The route only deletes the PID and meta files when both the port probe failed *and* the recorded PID is dead — preventing a transient startup window from prematurely garbage-collecting the bookkeeping.

### Stopping

`POST /api/exec/daemon` with `action: "stop"` first tries the PID file: read the recorded PID, `process.kill(-pid, SIGTERM)` to terminate the whole process group (because pnpm spawns children), then unlink both bookkeeping files. If there is no PID file, the route falls back to **port-based discovery** — `lsof -ti tcp:<port>` against the port from the meta file (for installed apps) or the fixed port from `DAEMON_COMMANDS` (for workspace daemons) — and signals whatever process owns the port. This fallback handles the case where the PID file was lost or never written but a process is still bound.

The endpoint returns `{ stopped: true }` either way, or 404 with `"Not running (no PID file)"` if neither path found a target.

## Uninstall lifecycle

Uninstall mirrors install in structure but inverts the responsibility: the installer is authoritative for the database, and the side effects in admin-web are cosmetic cleanup.

`POST /api/apps/uninstall` accepts `{ appId }` and issues `DELETE /admin/apps/:appId` against the local-data-server. After a successful response it deletes `<app-dir>/.starkeep-local.json` if present. The route does not stop a running app process — that is a separate operation; uninstalling an app whose dev server is still up will leave a zombie process whose authentication will start failing as soon as it tries to call the data-server.

The local-data-server's handler invokes `uninstallLocal(db, appId, { deleteFilesPrefix })` and then calls `supervisor.rescan()` to tear down the per-app sync loop. `uninstallLocal` runs a six-step ledger paralleling install:

1. `mark_uninstalling` — flips registry `status='uninstalling'` (visible during a long uninstall).
2. `revoke_access_grants` — deletes the app's `shared_access_grants` rows.
3. `drop_syncable_tables` — `DROP TABLE` for every namespace-recorded table.
4. `delete_syncable_files` — calls `deleteFilesPrefix("apps/<appId>/syncable/")`, which the local-data-server wires to `rm -rf` of the FS adapter's prefix. If the callback returns a Promise, the step fires-and-forgets and logs failures; the DB cleanup is treated as authoritative.
5. `delete_syncable_namespace` — removes the namespace record.
6. `delete_app_registry_row` — removes the registry row.

The step ledger is then cleared so a subsequent reinstall starts from a clean slate.

**What survives uninstall.** Shared records — the file-records and shared-data rows the app produced or stamped — are intentionally left in place. These belong to the data, not to the app: another app (or a reinstall of the same app) can keep using them. This mirrors the cloud-side uninstall design. The app's *app-specific* syncable tables, however, are dropped — those are app-private by definition.

If the registry row is already missing on entry, `uninstallLocal` just clears the step ledger and returns — a previous failed-mid-install can be "uninstalled" cleanly even though there's nothing in the registry.

## The Photos sample app

Photos (`starkeep-apps/photos`) is the only non-built-in app currently shipped. It is a Next.js + OpenNext "thin-client" web app: the Next.js server makes authenticated HTTP calls to the local-data-server on 9820 for all data operations rather than embedding the SDK directly. It exercises:

- **Manifest-declared file access**: `readwrite` + `metadataWrite` on ten raster-image extensions, justifying its right to write EXIF-derived metadata into the image metadata table.
- **App-specific syncable data**: an `image_enriched` table for per-image user overrides (caption, title, date-taken override).
- **The `files: true` flag**: opts the app into the framework-reserved `_starkeep_sync_records` table, so file-bytes sync is wired up alongside the row tables.
- **Cloud-tier compute** — present in the manifest purely to describe the cloud deployment shape; the local-app path neither reads nor reacts to it. The two declared Lambda handlers (a `resize` API and a static handler) and the route table exist for the cloud installer's API Gateway wiring; locally, `pnpm dev` runs Next.js in dev mode and serves everything in-process. Included here only to flag that the manifest is dual-purpose and that the local lifecycle ignores half of it.

The per-app daemon config in `APP_DAEMONS["photos"]` invokes `pnpm dev -p <port>` from the `photos/` cwd. The choice of *not* using a `--` separator before `-p` is deliberate: pnpm with `--` would pass the separator through verbatim to Next, which would then misinterpret `--` as a positional argument. The comment in the source records this as a discovered constraint.

Photos has no special handling anywhere in the installer or daemon code — it goes through the exact same `installLocal` and `APP_DAEMONS` paths any third-party app would.

## Open questions

- **No documented relationship between the daemon port and `STARKEEP_API_GATEWAY_URL`-style env vars.** The Photos manifest declares cloud env vars in `compute.handlers[].env` that get filled in at cloud-install time. Locally, the equivalents (data-server URL, HMAC secret) are read from `.starkeep-local.json`. It is not clear from the code whether any local app today needs anything from a runtime-config endpoint analogous to the cloud handlers' `env` block, or if the local path is always content with the secret file alone.
- **Workspace daemons in `APP_DAEMONS` versus `DAEMON_COMMANDS`.** `drive` is registered as a *workspace* daemon — fixed pnpm filter, fixed port — even though Drive is itself installed via `installLocal` at boot, so by the broader system's definition it is "an app". The split appears to be pragmatic (Drive lives in `apps/drive`, not `starkeep-apps/`), but it means the admin UI's per-app start/stop control for Drive uses a code path different from the per-app control for Photos. Whether that's intentional or vestigial is unclear from the code.

---

# Part 2 — Review and evaluation

## Behavior inconsistent with purpose

- **Uninstall does not stop a running app process.** `POST /api/apps/uninstall` removes the registry row and HMAC secret file but does not signal the app's dev server (if any). Any in-flight or post-uninstall request from that process to the local-data-server will then fail authentication — a confusing state from the user's perspective. The two endpoints exist; the uninstall route could (and arguably should) call the stop path for the same `appId` before forwarding the DELETE.
  > **Resolved (2026-06-02): Address now (code).** Uninstall route now calls `stopById(appId)` before forwarding DELETE. Best-effort — no-PID-file is fine.

- **The `appSpecificSyncable.files` flag is vestigial and should be removed.** All shared records are now file-backed, so the framework-reserved `_starkeep_sync_records` table is needed for every app — there is no longer a meaningful "files-off" case. The installer still gates `createReservedFileRecordsTable` and the namespace's `filesEnabled` on the manifest flag, and uninstall mirrors that gate when deciding whether to call `deleteFilesPrefix`. The flag should become unconditional (or, equivalently, treated as always-true) and dropped from the manifest schema; until then, an app that omits or sets `files: false` ends up half-installed relative to current data-plane assumptions.
  > **Resolved (2026-06-02): Dismiss — original critique was incorrect.** The `files` flag is about *app-specific* syncable data, not shared data. Shared data is always file-backed (so the critique conflated the two); app-specific data can legitimately be row-only, and the flag is a meaningful opt-in. The flag stays.

- **The `/api/apps/install` route accepts an `approved` flag but cannot verify what the user was actually shown.** The approval gate is structurally just a boolean: the route does not see, hash, or otherwise commit to the manifest the user reviewed. If the manifest on disk changes between display and POST, the user will have approved a different document than what gets written to the registry. The window is narrow but the check is purely positional, not cryptographic.
  > **Deferred (2026-06-02).** Real issue, narrow window; revisit when the UI gains a richer manifest-review surface.

## Missing behaviors

- **No "reinstall to refresh HMAC".** The installer's idempotency guarantees that re-running install on an active app returns the same secret, which is useful, but there is no exposed way to *rotate* the HMAC secret for an installed app. If a secret leaks, the only path today is uninstall+reinstall, which drops the app-specific syncable tables and forces a re-sync from the cloud peer. A `rotate-hmac` operation would be a small addition (mint a new secret, update `shared_app_registry`, rewrite `.starkeep-local.json`) and would not need to touch the step ledger at all.
  > **Deferred (2026-06-02).** Real gap; not pressing in dev.

- **No port reuse hint across restarts.** Every start call allocates a fresh port via bind-to-0, so the URL changes whenever an app is restarted. For a user who has bookmarked, say, `http://localhost:54321/`, restarting Photos sends them to a new port with no indication. A "prefer last-bound port" heuristic stored in the meta file would smooth this without removing the no-collision property (fall back to bind-to-0 if the preferred port is taken).
  > **Deferred (2026-06-02).** UX nice-to-have; revisit after the manifest-driven `localRun` rollout settles.

- **No visibility into install failures past the ledger.** `shared_app_install_steps` records which step failed and the error message, but there is no admin-web endpoint to read it back. A failed install via the UI surfaces only the immediate HTTP error; the operator cannot inspect or clear partial state without dropping into the SQLite DB. A "GET /api/apps/:appId/install-status" or similar would close this loop and make the ledger pattern actually visible.
  > **Resolved (2026-06-02): Address now (code).** Added `listInstallSteps` in `admin-installer/src/local/registry.ts`, `GET /admin/apps/:appId/install-steps` in local-data-server, and `GET /api/apps/[appId]/install-status` in admin-web that proxies it. Apps page (`app/(shell)/apps/page.tsx`) now has a per-app **Steps** button that opens an `InstallStepsDialog`, and the dialog auto-opens on install failure so the operator sees which step got stuck.

## Behavioral bugs

- **`stopById` race when no PID file exists and the port resolves to the wrong process.** The fallback path runs `lsof -ti tcp:<port>` and SIGTERMs whichever PID is bound there. If the recorded port has been reclaimed by another process (admin-web crashed before unlinking files; the OS re-issued the port), the stop endpoint will happily kill an unrelated process. There is no check that the discovered PID belongs to a pnpm/Next.js descendant. The probability is low locally but the failure mode is severe.
  > **Resolved (2026-06-02): Address now (code).** Port-fallback in `stopById` now reads the discovered PID's command line via `ps -o command=` and refuses to signal anything that doesn't match `(pnpm|node|next|vite|npm)`. Returns a 404 with an explanatory message instead.

- **`findOpenPort` races between `close()` and child `bind()`.** The comment in the source acknowledges this. In practice it's rare, but two near-simultaneous starts could be handed the same port — the first child binds, the second's pnpm dev errors out, and the user sees a started-then-instantly-dead daemon. There's no retry on the spawn-side EADDRINUSE.
  > **Deferred (2026-06-02).** Rare in single-operator local-dev use; revisit if it surfaces.

- **`delete_syncable_files` swallows synchronous errors after logging.** If `deleteFilesPrefix` throws synchronously, the step records itself as `done` (because `runStep` only catches via its own try, and the inner try/catch swallows the throw). The step ledger therefore claims success while the files are still on disk. This is benign for re-runs (the next uninstall attempts to re-delete a non-existent prefix and succeeds), but it does mean the ledger is not a reliable record of what was actually cleaned up. The async fire-and-forget path has the same property by design.
  > **Deferred (2026-06-02).** Real issue; revisit alongside a broader decision on ledger semantics for best-effort steps.

- **`/api/apps/install` does not validate that `<appId>` matches the manifest's `id` field.** It reads the manifest at `<parent-dir>/<appId>/starkeep.manifest.json` and forwards it; if the directory and the manifest `id` disagree, the installer will install under `manifest.id` while admin-web writes `.starkeep-local.json` under the directory `appId`. The two will not match. The installer's own validation catches manifest shape problems but not directory-vs-id drift.
  > **Resolved (2026-06-02): Address now (code).** Install route now rejects with 400 when `manifest.id !== appId`.

## Potential gaps

- **No mechanism for an installed local app to declare a long-running process at all.** `APP_DAEMONS` is a hand-curated map in admin-web source, not a manifest-derived registry. Adding a new local app to the start/stop UI requires editing admin-web and rebuilding — there is no path for a third-party local app to ship metadata that says "I am started with command X in cwd Y". For a system whose stated purpose is to host third-party apps, this is a real gap; the install path is plugin-friendly but the run path is not. (High confidence: the only entry in `APP_DAEMONS` is Photos, and the comments treat the file as the source of truth.)
  > **Resolved (2026-06-02): Address now (code).** Added `localRun: { command, args, portFlag?, cwd? }` to the manifest schema (`admin-manifest`). `APP_DAEMONS` removed; admin-web's daemon route now resolves spawn config from the app's manifest via a shared `app-scan` helper. `DAEMON_COMMANDS` remains for the two workspace daemons (local-data-server, drive). Photos manifest updated to declare its `localRun` block.

---

## Review action log

### 2026-06-02

- **Item:** Behavior inconsistent with purpose — uninstall doesn't stop running app process.
- **Outcome:** Address now (code).
- **Note:** Extracted PID/port-based stop logic into `src/lib/daemon-control.ts`; uninstall route now calls `stopById(appId)` before forwarding DELETE. The status route was refactored alongside to share the helper.

- **Item:** Behavior inconsistent with purpose — `appSpecificSyncable.files` flag is vestigial.
- **Outcome:** Dismiss — original critique was incorrect.
- **Note:** The flag governs *app-specific* syncable data, not shared. Shared data is always file-backed; app-specific data may legitimately be row-only. Initial removal edits were reverted; manifest schema comment now states the distinction explicitly.

- **Item:** Behavior inconsistent with purpose — install `approved` flag not bound to manifest contents.
- **Outcome:** Defer.

- **Item:** Missing behavior — no HMAC rotation.
- **Outcome:** Defer.

- **Item:** Missing behavior — no port-reuse hint across restarts.
- **Outcome:** Defer.

- **Item:** Missing behavior — install-step ledger not exposed.
- **Outcome:** Address now (code).
- **Note:** Added `listInstallSteps` to `admin-installer/src/local/registry.ts`, exported from package index. New endpoint `GET /admin/apps/:appId/install-steps` on local-data-server; admin-web proxy at `GET /api/apps/[appId]/install-status`. UI follow-up (same day): `app/(shell)/apps/page.tsx` now exposes a per-app "Steps" button opening an `InstallStepsDialog`, and the dialog auto-opens on install failure.

- **Item:** Behavioral bug — `stopById` can SIGTERM unrelated process via port-fallback.
- **Outcome:** Address now (code).
- **Note:** `daemon-control.ts` now reads `ps -o command=` for the discovered PID and refuses to signal anything that doesn't match a known dev-server command shape. Returns 404 with `Port X is bound by pid Y (...) which does not look like an app daemon`.

- **Item:** Behavioral bug — `findOpenPort` close→bind race.
- **Outcome:** Defer.

- **Item:** Behavioral bug — `delete_syncable_files` swallows sync throws but marks step done.
- **Outcome:** Defer.

- **Item:** Behavioral bug — `/api/apps/install` doesn't validate dir-name vs manifest.id.
- **Outcome:** Address now (code).
- **Note:** Install route now returns 400 if `manifest.id !== appId` with a message suggesting renaming the directory or fixing the manifest.

- **Item:** Potential gap — no manifest-driven mechanism for declaring a local run command.
- **Outcome:** Address now (code, larger refactor).
- **Note:** Added `localRun` block to manifest schema (`admin-manifest`). Created `apps/admin-web/src/lib/app-scan.ts` (shared by `/api/apps/list` and the daemon route). `/api/exec/daemon` POST start path now resolves spawn config from `manifest.localRun` for any id not in `DAEMON_COMMANDS`; `APP_DAEMONS` removed from `exec-commands.ts`. `daemon-control.ts` now identifies workspace daemons by `DAEMON_COMMANDS` membership and treats every other id as a manifest-defined app. Photos manifest declares `localRun: { command: "pnpm", args: ["dev"], portFlag: "-p" }`. All four affected packages typecheck clean.

Source ref after changes: starkeep-core `git rev-parse HEAD` at time of commit.
