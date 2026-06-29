# Starkeep platform — test plan (2026-06-11)

Scope: the whole starkeep platform — `local-data-server`, `cloud-data-server`, `data-sync`, `shared-data`, `app-specific-data`, `local-apps`, `cloud-apps`, `admin-web`, `drive`, `sdk`, `cloud-overview-and-bootstrap` — plus the `starkeep-apps/photos` example app as the e2e basis for installed apps. `starkeep-org` is out of scope.

This plan supersedes the survey in [[todo-systematic-test-coverage]] (doc 35) with concrete tiers, libraries, and cases; that todo's policy section (strict `passWithNoTests`, "tests exist and pass" as the minimum bar for new packages) carries forward unchanged.

Guiding principle (per the request that produced this plan): **test functionality, not implementation.** Prefer driving the real HTTP surfaces and real processes; mock only at the AWS boundary or where a real dependency is structurally unavailable (DSQL, IAM, Lambda).

---

## The four tiers

| Tier | Kind | Runs against | AWS needed | When |
|---|---|---|---|---|
| 0 | Unit | pure functions, single packages | no | every `pnpm test` |
| 1 | Integration | real local-data-server process (+ fake cloud responder), real SQLite + FS storage | no | every `pnpm test` |
| 2 | E2E (local) | real admin-web, local-data-server, drive, photos in browsers via Playwright | no | every CI run / pre-merge |
| 3 | E2E + integration (cloud) | real AWS account: bootstrap → deploy → install → sync → uninstall | yes | gated (env flag); slow, run infrequently — on-demand and/or scheduled |

Tiers 0–2 must run on a laptop with no AWS credentials. Tier 3 is the only place real DSQL/S3/IAM/Lambda behavior is exercised; everything cloud-shaped below Tier 3 tests the platform's own logic (routing, HMAC, access enforcement, DDL/template generation) with the AWS SDK boundary faked.

## Test libraries

- **Vitest** (already in place, workspace-configured) — Tiers 0 and 1. No change.
- **Playwright** (`@playwright/test`) — Tiers 2 and 3 browser flows. Standard choice for Next.js apps; its `webServer` config can boot multiple servers, but for the multi-process topology here a custom global-setup that orchestrates the daemons (see Implementation notes) is cleaner.
- **`aws-sdk-client-mock`** — unit-mocking AWS SDK v3 clients (STS, SSM, IAM, S3, Cognito) in `admin-installer`, `app-client`, and broker-handler unit tests. Pairs with the existing `@smithy/smithy-client` pin.
- **`@cloud-copilot/iam-simulate`** (already in place via `iam-permission-tests`) — continues to be the IAM-correctness layer below Tier 3; no duplication of its coverage elsewhere.
- No supertest/nock/msw needed: the local servers are plain Node HTTP on configurable ports; tests use `fetch` against real listeners.

---

## Existing coverage

### sync-engine (13 files) — strong
- What it covers: S0–S6 scenario suites over the purpose-built two-side harness (`__tests__/sync-test-harness/`): presence×operation matrix across SR/AR/AW, tombstones, blob failure with Staged residency and contiguous-prefix watermarks, watermark reset, concurrent LWW, pagination, channel split with the inbound defense guard.
- Kind: integration-style unit tests; in-process transport, mock storage adapters with failure injection.
- Gaps: nothing engine-internal worth adding now. The uncovered area is *orchestration around* the engine (supervisor nudge/backoff/rescan), which lives in local-data-server and is covered under Tier 1 below. Two Part-2 findings worth pinning with tests when touched: the dead `scanSince` since-parameter and HLC absurd-skew acceptance.

### protocol-primitives (5 files) — adequate
- HLC ordering, identifiers, object keys, record shapes, schema. Keep current; add cases only alongside changes.

### iam-permission-tests (1 file + simulate CLI) — adequate for its layer
- Guard test for SDK→IAM action mapping; the `simulate` CLI replays modeled + captured calls per context. This is the standing answer to "will install-time IAM work" without AWS. Tier 3 confirms it against reality occasionally.

### One-file packages — thin
- `access-control`, `query-orchestrator`, `sdk`, `shared-space-api`, `storage-adapter` (2), `storage-fs`, `storage-s3`, `storage-sqlite` each have a single smoke-level suite. Real behavior gaps are listed per-concept below.

### Zero-test packages — red
- `admin-installer`, `admin-manifest`, `app-client`, `aws-bootstrap`, `storage-aurora-dsql` have no tests and **fail `pnpm test`** (vitest exits 1 on no files). `apps/local-data-server`, `apps/admin-web`, `apps/drive`, and `starkeep-apps/photos` have no test scripts at all.

---

## Behaviors to cover

Organized by functional concept. Each case names its tier. Cases already covered above are not re-listed.

### 1. Manifest contract (`admin-manifest`) — Tier 0
The manifest is "the entire contract between an app and the platform"; its validator is the first gate on every install.
- Important cases:
  - A valid full manifest (photos' own `starkeep.manifest.json` as a fixture) parses and round-trips typed.
  - `fileAccessAll` rejected for any id except `starkeep-drive`; `brokerPower` rejected except `cloud-data-server`.
  - Reserved ids (`cloud-data-server`, `starkeep-drive`) rejected for ordinary installs.
  - Syncable-table column rules: `updated_at`/`deleted_at` reserved names rejected; snake_case enforced; type whitelist enforced.
  - Extensions: lowercase-alphanumeric enforcement; extensions outside the platform map rejected (or whatever the intended behavior is — pin it).
  - `localRun` block accepted/optional; `targets` gating (`cloud` required for cloud install, `local` for local).
- Edge cases: empty `fileAccess`, duplicate extensions across entries, handler `routes` strings that don't parse as `"METHOD /path"`.

### 2. Access control & grants (`access-control` + enforcement points) — Tier 0 + Tier 1
The load-bearing security property locally: an app sees exactly its declared types.
- Important cases (Tier 0, against the package):
  - Grant matrix: `read` vs `readwrite` vs `metadata_write` across `appCanRead/appCanWrite/appCanWriteMetadataCategory` — including `metadata_write` without `readwrite` (the thumbnail-worker shape).
  - Category-widening behavior: a grant on `jpg` permits category-level file ops on `png` (documented-intentional; pin it so a future change is deliberate).
  - All-access short-circuit for `starkeep-drive` and the watcher id; no grant rows consulted.
  - Unknown extension → `other` category → no installable app can reach it.
- Important cases (Tier 1, through the local server's HTTP surface):
  - App with read-only grant gets 403 on record create/update/delete of that type; no grant at all → records of that type invisible in `GET /data/records` and `/data/types` counts.
  - Metadata write rejected for `other`-category records (no metadata table).

### 3. Local data plane (`local-data-server` HTTP surface) — Tier 1
The central integration surface; everything (apps, drive, admin-web, watcher) goes through it. This is the highest-value new suite in the plan.
- Request auth:
  - HMAC accepted/rejected: valid sig, wrong secret, missing headers, body tampering, app-id/path mismatch; constant-time-comparison behavior is implementation, skip.
  - Loopback-authorized routes work without HMAC; data-plane prefixes refuse without it.
  - Token-in-URL exemptions: `GET /data/files/:token` and `PUT /data/files/upload/:token` work unauthenticated with a valid token; expired/garbage token rejected; token invalidated by server restart (per-startup secret).
- Records:
  - Create (filePath shape and key-ref shape), read, list pagination + `updated_after`, soft delete → tombstone visible to sync, not in normal lists.
  - Owner-scoped dedup: same bytes + filename twice → `deduped: true`, same id. Derived-child dedup by `(parentId, contentHash)`.
  - Key-ref registration for a blob that was never uploaded → rejected.
- App-specific data:
  - CRUD on a declared table; un-declared table → refused; **other app's table → refused** (isolation).
  - `/app-data/files/:subKey` put/get/delete confined to own namespace.
  - Reserved `_starkeep_sync_records` table created only when `files: true`.
- Install/uninstall lifecycle (via `/admin/apps`):
  - Install returns `{appId, hmacSecret}`; `GET /admin/apps` never leaks secrets; re-install on active app is a no-op returning the same secret.
  - Step-ledger resume: fail a step mid-install (injectable), re-drive, verify completed steps skipped and final state correct; `GET /admin/apps/:appId/install-steps` reflects the failure.
  - Uninstall drops app tables + grants + namespace + files prefix; **shared records survive**; uninstall of a never-installed app cleanly no-ops; supervisor `rescan()` adds/removes the per-app sync engine (observable via `/sync/status`).
- Sync orchestration (supervisor, against the fake cloud responder):
  - `/sync/now`, `/sync/pause`, `/sync/resume` affect `/sync/status` as documented; backoff appears after a failing exchange and resets on success.
  - Nudge routing: a shared-record write nudges only the Drive channel; an app-data write nudges only that app's channel (the 2026-06-01 fix — pin it).
  - Auth gate: with no live id token, exchanges are skipped (status shows it), no 401 storm.
- Watcher:
  - Watch a temp dir: initial scan registers records; add/modify/delete on disk → record created/updated/tombstoned; excluded patterns and >100 MB skip honored; `watches.json` persistence across server restart.
  - Symlinked bytes readable through the object store (`putSymlink` path).
- Events:
  - `/events` SSE delivers a kick on local write and on sync-applied remote change; payload is empty (the tightened post-review contract).
- Config & lifecycle:
  - Server boots against an empty `STARKEEP_DIR` (fresh-machine path); `PATCH /config` writes then exits the process (assert exit, not survival).

### 4. Sync end-to-end across the wire (`data-sync` × local server × cloud responder) — Tier 1
The engine is well-tested in-process; what's untested is the full HTTP path with real SQLite/FS on the local side.
- Important cases:
  - Two real local-data-server instances (A, B) syncing through one fake cloud: create on A → visible on B with blob resident; update on B → LWW wins on A; delete propagates as tombstone. (Replaces the dead `scripts/test-sync.sh` smoke script, deleted 2026-06-11, as a real test.)
  - App-specific rows sync only where the app is installed: install photos on A only → its rows reach the cloud responder but do not land on B; install on B → backfill arrives.
  - Blob staging across the wire: make the fake cloud's blob endpoint fail once → record Staged locally, watermark held, next round repairs.
  - Restart durability: kill and restart a local server mid-stream → watermarks/HLC restored from the SQLite state store, no re-ship storm, convergence completes.
- Edge cases: large-ish blob (multipart threshold isn't hit locally, but >1 page of records is — drain with small `pageLimit`).

### 5. Local apps lifecycle (`local-apps`, admin-web routes) — Tier 1 (route-level) + Tier 2 (browser)
- Important cases (Tier 1, hitting admin-web's API routes with the local server running):
  - `/api/apps/list` discovery from a temp parent dir: manifest found → listed; malformed manifest skipped; install status joined; data-server down → graceful `not_installed` fallback.
  - Install approval gate: `approved !== true` rejected; dir-name vs `manifest.id` mismatch → 400; success writes `.starkeep-local.json` mode 0600.
  - Uninstall stops a running app process first (the fixed behavior), deletes the secret file, forwards the DELETE.
  - Daemon start/status/stop: manifest `localRun` drives the spawn; status prefers TCP probe over PID liveness; stop falls back to port discovery but refuses to kill non-dev-server processes (pin the `ps` guard).
- Edge cases: two apps with the same manifest id across two parent dirs (first wins); start when already running; stop when nothing is running (404).

### 6. Built-in apps and Drive — Tier 1 + Tier 2
- Drive and the watcher are installed at boot by `installLocal` with synthesized manifests: assert both present in the registry on a fresh boot, Drive all-access works, and neither gets a per-app sync channel.
- Drive UI (Tier 2, Playwright): records list renders from `/api/records`, type sidebar from `/api/types`, live-updates on `/events` kick when a record is added underneath it.

### 7. Photos example app — Tier 2 (the canonical installed-app e2e), split across two homes
The plan's representative for "how installed apps behave on the platform." Browser flows, full stack (admin-web + local-data-server + photos dev server), driven by Playwright. Flows split by what they assert (decision 2026-06-11, open question 4):

**(a) Platform flows — starkeep-core `e2e/`** (photos is the fixture; the assertions are against platform surfaces):
- Install photos through the admin-web UI (approval dialog shows the manifest grants), start it, open it on its allocated port; stop it.
- Cross-app visibility: a photo uploaded in the photos app appears in Drive's UI; its caption does not (shared vs app-specific data semantics).
- Upload the same photo fixture twice → dedup at the platform layer, no second record.
- Uninstall photos → captions (app data) gone, photos and thumbnails (shared data) still visible in Drive; reinstall → photos re-exposed, captions absent (locally).
- HMAC contract negative test: corrupt `.starkeep-local.json` secret → photos API calls fail with 401, UI surfaces an error state.

**(b) App-functionality flows — `starkeep-apps/photos`** (assert photos' own behavior; double as the worked example of how an app developer tests an app on the platform, using the harness exported from core — see Implementation notes #3):
- Upload a photo fixture → appears in the grid; EXIF/dimensions land in image metadata.
- Thumbnail registered as a *shared* derived record with `parentId`.
- Set a caption/title → persisted in `image_enriched` via `/app-data` (verify it's not in shared records); survives photos restart.
- Photos-specific unit tests (EXIF extraction, client helpers) also live here, Tier 0 style.

The HMAC client chain (`local-app-creds.ts` → `signedFetch` → same-origin proxy route) is exercised implicitly by every flow in both homes.

### 8. Admin-web cloud setup & wizard — Tier 0/1 (logic) + Tier 3 (real)
- Tier 0: `admin-core`/`aws-bootstrap` CFN template generation — snapshot/assertion tests on the four install-time roles' trust policies, the five permissions boundaries, the Manager allow-list, stack outputs (subsumes [[todo-cloud-overview-and-bootstrap-aws-bootstrap-tests]], doc 13).
- Tier 1: config route seeding (`appParentDirs` default), wizard state persistence shape in `~/.starkeep/config.json` (against a temp dir), region derivation from `userPoolId` never persisted.
- Tier 3: the wizard's deploy step against a real account (below).
- Browser-level wizard step navigation (Tier 2) is worth one smoke test with the cloud calls stubbed at the route layer; deep cloud-setup UI coverage is not worth it pre-production.

### 9. Cloud install pipeline (`admin-installer`) — Tier 0 + Tier 3
Everything here that is pure computation gets Tier 0 coverage with `aws-sdk-client-mock`; the AWS-real behavior is Tier 3.
- Important cases (Tier 0):
  - Orchestrator state machine with faked steps: ledger rows written pending→done; mid-run failure → re-run resumes at failed step; uninstall after partial install completes cleanly.
  - DDL generation (`dsql-ddl.ts`): for the photos manifest, the statement sequence includes PG role probe-then-create, `AWS IAM GRANT` mapping, schema + default privileges, shared-table grants matching `read`/`readwrite`/`metadataWrite`, per-extension `access_grants` upserts, app tables with reserved sync columns + index, namespace upsert. Drive (`fileAccessAll`) writes zero grant rows. (Kysely-compiled SQL is assertable without a database.)
  - Pulumi program build (`pulumi-program.ts`): route prefix rewriting (`GET /` → `GET /apps/<id>`, `{proxy+}` pass-through), reserved-subpath collision (`data|files|sync|health`) is a hard failure, `auth: jwt|public` wiring, env filling of empty-string manifest keys, the three cloud-client envs always present.
  - Boundary routing in `createAppRole`: per-app vs foundational vs User-Data-Owner selected by the two magic ids and nothing else.
  - Temp-policy symmetry: every action in each temp policy is within the corresponding boundary (the static check the cloud doc mentions — make it a real test).
- Tier 3 covers the same flows against AWS (below).

### 10. Cloud broker (`cloud-data-server` api-handler) — Tier 0/1 (handler logic) + Tier 3
The handler is a Lambda, but its routing, HMAC verification, access enforcement, and key parsing are plain code.
- Important cases (handler invoked directly with synthetic APIGW events; STS/SSM/DSQL/S3 faked):
  - HMAC verification: happy path, sig mismatch, header-vs-path app-id mismatch → 401 before any data work; secret cache TTL behavior (stale-after-reinstall is a known deferred gap — assert current behavior, reference todo 16).
  - Access enforcement parity with local: read/write/category checks consult `shared.access_grants`; `starkeep-drive` all-access by id.
  - `parseObjectKey`: shared keys gated by category grants; `apps/<otherApp>/...` rejected outright; malformed keys rejected.
  - Channel split: `/sync/exchange` as drive → shared records, no app source; as an app → app rows only.
  - Registration refuses a record whose blob isn't in storage (409); dedup by `(parentId, contentHash)`.
  - `/app-data/*` route handlers (db CRUD with manifest gate, files put/get-presign/delete) respond correctly when invoked, plus a route-table test asserting the gateway program claims `ANY /apps/{appId}/app-data/{proxy+}` (the plane landed 2026-06-10/11 — todo 37 verified done; this is the regression guard). The byte-path shape is still open: assert current PUT-through-Lambda behavior loosely so todos 40/41 (HEAD-probe existence, presigned PUT) can change it without false failures.
- DSQL-specific behavior (savepoint transactions, async index creation, the live-row dedup unique-index semantics flagged as broken in the cloud doc) cannot be faked honestly → Tier 3 cases.

### 11. Cloud e2e (Tier 3, gated)
One scripted journey per run, idempotent against a dedicated test stack prefix, runnable on demand:
- Bootstrap stack create (or verify) → admin Cognito user → deploy cloud-data-server → `installDrive` → cloud-install photos (bundle build, Lambda, routes) → local server syncs a photo to the cloud (record + blob in DSQL/S3 under Drive identity, `origin_app_id` = photos) → photos cloud static handler serves; resize endpoint round-trips → caption written through the cloud `/app-data` plane → uninstall photos (app schema/role/Lambda gone; shared records persist) → optional full teardown.
- IAM negative checks ride `iam-permission-tests` simulation, not live probing; Tier 3 only confirms the happy chain.
- DSQL-specific assertions: schema-init idempotent on re-run; filename+hash dedup behavior on live rows (currently expected-broken — pin intended semantics); IAM↔PG mapping required for `DbConnect` (FATAL 28000 without it).

### 12. SDK and storage adapters — Tier 0, opportunistic
- `sdk`, `query-orchestrator`, `shared-space-api`, `storage-fs/s3/sqlite` each have one suite; expand only where the concepts above don't already exercise them through the HTTP surface (most do). Specific adds:
  - `storage-aurora-dsql` (zero tests): Kysely query compilation against the `shared.records` schema (compile-only, no DB), row serialization round-trip, savepoint-transaction call sequence.
  - `app-client` (zero tests): HMAC signing matches `validateAppHmac`'s `sha256(secret, "<appId>:<body>")` byte-for-byte (cross-package contract test against the server's verifier — the single most regression-prone constant in the app ecosystem); local-mode creds from `.starkeep-local.json`; cloud-mode async loader from faked SSM; sync loader returning null in cloud mode (pin until todo 42 removes it).
  - `storage-fs`: sidecar metadata, ENOENT tolerance, symlink follow — if not already covered by its one suite.

---

## Implementation notes

Infra to build, roughly in dependency order:

1. **Local-data-server test harness (blocks most of Tier 1).** A helper that spawns `tsx server.ts` as a child process with `STARKEEP_DIR=<tmp>` and `STARKEEP_PORT=<ephemeral>`, waits on `/health`, and tears down. Env-based config already exists (`server.ts:57-58`); note todo 31 wants env reads moved to explicit config — build the harness against whatever that lands on, or land it first. In-process boot is not currently possible (config is read at module load); child-process is fine and more honest anyway.
2. **Fake cloud responder (blocks Tier 1 sync cases).** A small HTTP server composing `createHttpSyncHandler` + `storage-sqlite` + `storage-fs` plus the presign/file endpoints the local server's `HttpObjectStorageAdapter` expects, accepting any auth. The local server needs a test path to (a) point its cloud URL at the fake and (b) bypass the Cognito id-token liveness gate — likely a config flag or a seeded fake token. `scripts/test-sync.sh` implies this once existed on :9920; it does not today (see Open questions).
3. **Playwright workspace (blocks Tier 2).** A root-level `e2e/` package in starkeep-core with a global-setup that orchestrates: local-data-server (harness from #1), admin-web (`next dev`), drive, and photos (installed via the real admin-web API, started via the real daemon route — the orchestration *is* test coverage). Photo fixtures: a handful of small images incl. one with EXIF. The boot/install orchestration helpers must be **exported as a reusable harness** (a small published-in-workspace package or importable module) so `starkeep-apps/photos` can consume them for its own e2e (case 7b) via the existing sibling-checkout layout (`DEFAULT_APPS_DIR`). Photos' e2e in starkeep-apps gets its own Playwright config depending on that harness.
4. **Per-package vitest for the five red packages.** No infra beyond `aws-sdk-client-mock` as a root devDependency; turns `pnpm test` green and is where most Tier 0 cases land.
5. **Broker-handler test entry.** `api-handler.ts` needs its AWS clients injectable (or module-mocked) to run under vitest with synthetic APIGW events. Small refactor; keep it shaped as "pass clients in" rather than test-only seams.
6. **Tier 3 runner.** A vitest project (or plain script) gated on `STARKEEP_AWS_TESTS=1` + a dedicated stack prefix, wired as a separate turbo task (`test:aws`) excluded from default `test`. Reuses `admin-installer` CLIs and `scripts/teardown-*.sh`. Budget: one full cycle is tens of minutes; design it to resume (the step ledger already supports this).
7. **CI.** There is no CI config in the repo today. Tiers 0–2 want a single workflow (`pnpm test` + Playwright); Tier 3 a manually-triggered/nightly workflow with AWS credentials. Out of scope for this plan beyond noting it.

Ordering recommendation: 4 (green baseline) → 1 → Tier-1 local-data-server suite → 2 + sync-over-wire suite → 3 + photos e2e → 5 + broker suite → 6/7.

## Open questions — resolved 2026-06-11

1. **Tier 3 appetite.** *Decided: yes, essential* — sync is a core investment and requires the cloud to work. Run infrequently (gated env flag; on-demand and/or scheduled), never in the default `pnpm test` path.
2. **Fake cloud vs. local cloud-server mode.** *Decided: test-only fake responder.* `scripts/test-sync.sh` was confirmed dead code and deleted (2026-06-11).
3. **Stale CLAUDE.md doc pointers.** *Done (2026-06-11):* CLAUDE.md now points at `system-design.md` and `data-roles-and-permissions.md`.
4. **Photos-repo test placement.** *Decided: split (2026-06-11).* Platform-behavior e2e (install/uninstall lifecycle, cross-app visibility, data-survival semantics) lives in starkeep-core's `e2e/`, where the system under test and the harness live; app-functionality e2e (upload→grid, captions, EXIF) lives in `starkeep-apps/photos`, consuming the harness core exports and doubling as the example of how an app developer tests an app on the platform. Case 7 reflects the split.
5. **`/app-data` cloud plane.** *Resolved by verification (2026-06-11):* todo 37 (the plane itself, incl. the gateway route) is done — its tests are ordinary regression tests now. Todos 40 (existence check downloads full bytes) and 41 (PUT pushes bytes through APIGW, ~10 MB ceiling; no presign-PUT route) were checked against the code and remain open; case 10 asserts current behavior loosely so those fixes don't break tests.
