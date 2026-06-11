# Cloud data server — Functional Review (2026-06-05, revised 2026-06-10)

> **Revision note (2026-06-10).** Revised after commits `345ec13` (HMAC app-auth), `10ce75b` (Pulumi passphrase + cloud-side `/app-data/*` routes), and `9e88958` (removed `owner_id` from `shared.records`). Part 1 has been updated to describe the current state; Part 2 captures the bugs and gaps these changes introduced.

Scope: the `cloud-data-server` topic and its nine children (auth, data-ops, db-indexing, install, object-storage, security, serverless, sync, uninstall). The deep IAM/PG/trust-policy reasoning belongs to the cloud bootstrap doc and to `roles-and-permissions.md`; this review covers it only to the extent that it shapes how the cloud data server *works*.

---

# Part 1 — Current state

## Overview

The cloud data server is the single AWS-side component that holds and serves a user's data. From the outside it is a public HTTPS endpoint (API Gateway) plus an S3 bucket; from the inside it is a thin **broker Lambda** that, for every request, assumes the calling app's IAM role and runs the actual data operations under those credentials. Persistent state lives in two backing stores it provisions for itself: an **Aurora DSQL cluster** holding all shared records, per-app metadata, and a small amount of control-plane state, and a **files bucket** holding the actual bytes for every file-backed record.

Three concepts organize the rest of Part 1:

- **Broker model.** The cloud data server owns infrastructure (DSQL, S3, the gateway) but never holds data-plane permissions in its own name; every request is executed under a freshly-assumed app role.
- **Two-store data plane.** A flat shared records table in DSQL, per-category metadata tables, and one S3 bucket holding the content-addressed blobs.
- **Lifecycle.** A one-shot install run brings the entire data plane into existence and seeds its schema; a symmetric uninstall tears it back down. Per-app installs after that ride on top of this foundation.

## The broker model

The cloud data server's runtime identity (`...-app-cloud-data-server-role`) has standing power to do exactly one thing on the data plane: assume any `...-app-<appId>-role`. Every other capability — reading a record, writing a file, signing a presigned URL — flows from the app role it is impersonating for a specific request. The Lambda is therefore best understood as a per-request **identity switch** that wraps the data adapters.

The mechanics are mostly enforced outside this code:

- API Gateway authenticates the calling human (or app) at the network edge. The reserved data-plane routes (`/apps/{appId}/{data,files,sync}/{proxy+}` and `GET /apps/{appId}/health`) are still wired with a Cognito JWT authorizer (`authorizationType: "JWT"`, `identitySources: $request.header.Authorization`) in `cloud-data-server-program.ts`. `GET /health` and `OPTIONS /{proxy+}` are unauthenticated.
- IAM permissions boundaries cap what any app role can do regardless of attached policy (the cloud data server's runtime role is bounded by the *foundational* boundary; everything else by the per-app one).
- The S3 bucket policy denies cross-app prefix access independent of IAM.

What the cloud data server itself contributes to this layered model lives in four places:

- **HMAC-verify the caller's app identity.** Before any per-app work, the broker reads `X-Starkeep-App-Id` and `X-Starkeep-App-Sig` headers and checks the signature against the per-app HMAC secret it loads from SSM SecureString at `/${stackPrefix}/app-creds/${appId}` (cached per warm Lambda for 5 min in `hmacSecretCache`). The signature is HMAC-SHA256 over `${appId}:` ++ raw body bytes (empty body for GET/HEAD); the header `X-Starkeep-App-Id` must match the appId parsed from the URL path. A mismatch returns 401 before any DSQL/S3 work runs. This is the application-layer "the caller really is this app" check that sits underneath the gateway-level JWT and above the IAM/PG enforcement.
- **STS-assume the per-app role on every request.** `getAppCreds` (in `api-handler.ts`) caches assume-role credentials per `appId` for slightly under their 15-minute STS lifetime and refreshes them with a 60-second skew. A single hop — Lambda exec role → per-app role — with no Manager in the chain; per-app roles trust the cloud data server directly.
- **Build per-request DSQL and S3 adapters using those credentials.** The DSQL client signs `DbConnect` (not `DbConnectAdmin`) tokens with the assumed credentials; the S3 adapter is constructed with them directly.
- **Run the application-layer access check.** DSQL has no row-level security and `shared.records` is one flat table for every shared type, so before either records or blobs are touched the handler loads the caller's per-extension grants from `shared.access_grants` and gates each route through `canRead`/`canWrite`/`canReadCategory`/`canWriteCategory` (in `access-enforcer.ts`).

The reserved `starkeep-drive` app id is the **User-Data-Owner channel**: it is granted all-access by app id (not via grant rows), and it is the only channel that ships shared records to the cloud (see Sync, below). The cloud data server's authorization code special-cases this app id; the deeper rationale for why Drive owns shared-record custody is the bootstrap doc's concern.

The end result is that compromise or buggy behavior in the broker code can still only do what the calling app's role allows. *How* and *why* that property is constructed at the IAM layer is covered exhaustively in `roles-and-permissions.md` and the cloud-overview-and-bootstrap functional doc; this doc covers only the per-request mechanics the broker enforces in code.

## The shared API surface

The cloud data server presents one HTTPS API to clients. The shape is `/apps/{appId}/<surface>` plus a couple of unauthenticated probes:

- `GET /health` — unauthenticated liveness probe (no Cognito JWT required).
- `GET /apps/{appId}/health` — authenticated, checks DSQL + S3 reachability under the assumed app role.
- `/apps/{appId}/data/*` — record reads/writes, per-record metadata, file-URL retrieval.
- `/apps/{appId}/files/*` — direct file access by content-addressed key (presigned PUT/GET, HEAD, DELETE).
- `/apps/{appId}/sync/exchange` — the channel-level sync endpoint (see Sync).
- `/apps/{appId}/app-data/db/<table>` (GET/POST/PATCH/DELETE) and `/apps/{appId}/app-data/files/<key>` (GET/PUT/DELETE) — the cloud counterpart of local-data-server's `/app-data/*` surface, letting a cloud-served app read and write its own app-specific syncable data through the broker. The handler logic was added in the 2026-06-10 changes; the gateway route `ANY /apps/{appId}/app-data/{proxy+}` is claimed in `cloud-data-server-program.ts` (verified reachable 2026-06-11). The byte-path shape is still suboptimal — see todos 40 (existence check downloads full bytes) and 41 (PUT pushes bytes through APIGW instead of presigning).

Two structural points are worth calling out because they shape what the API *does*:

- **The `/apps/{appId}/` namespace is shared with every installed app's own Lambda.** Per-app installs attach their own routes to the same API Gateway (see Install). The data-server routes claim the reserved `data`, `files`, `sync`, and `health` sub-namespaces; everything else under `/apps/{appId}/` flows to the app's own Lambda. APIGW v2's most-specific-match rule keeps the routing unambiguous.
- **The handler reuses the per-request grants for both records and blobs.** A `POST /data/records` write is rejected if the type is not in the caller's `writableTypes`. A `POST /files/presign` is rejected if the *derived category* of the requested key (`shared/<category>/...`) is not in the caller's `writableCategories`. The same grants object services both checks.

App-private file keys (`apps/<appId>/syncable/...`) are only legal for the named app — cross-app syncable keys are rejected outright in `parseObjectKey`. Shared keys (`shared/<category>/<shard>/<hash>`) are gated by the category-level grants.

## Records, files, and metadata

A shared record is one row in `shared.records` plus one immutable blob in S3 and zero-or-one row in a per-category metadata table.

- **`shared.records` is a single flat PostgreSQL-compatible table.** Every shared type — photos, markdown, generic blobs, etc. — lives in the same table, keyed by id. Per-type segregation is *application-layer* (the access grants gate above) plus PG-level on metadata tables (below); the records table itself is one heap of rows.
- **All records are file-backed.** There is no inline content column. The record carries a `content_hash` (SHA-256, hex) and an `object_storage_key`; the bytes live in S3 at that key. Writes are content-addressed: the client first PUTs the bytes via a presigned URL to `shared/<category>/<shard>/<hash>`, then registers the record by hash. The server refuses to register a record whose blob is not already in S3 (`409`).
- **Per-category metadata tables.** Each category (image, markdown, etc., excluding `other`) has its own `shared.record_<category>_metadata` table generated from the `CATEGORIES` registry. Apps write metadata through `POST /data/records/{id}/metadata`; the server validates that the keys are in the category's schema and writes through the database adapter. Read is symmetric.
- **Parent / derived-record dedup.** A record may carry a `parentId` (used for thumbnails and other derived blobs). On register, the server looks for an existing live record with the same `(parentId, contentHash)` and returns it instead of creating a duplicate. The dedup is bytewise-exact: different crops of the same source produce different hashes and stay distinct.
- **Soft-delete via tombstone.** `DELETE /data/records/{id}` updates `deleted_at` and `updated_at` to the current cloud HLC timestamp; the row stays in the table so sync can observe the deletion. File-bucket cleanup of orphan blobs is not done by this endpoint.
- **No `owner_id` column.** As of 2026-06-09 `owner_id` was removed from `shared.records` in both the cloud (DSQL) and local (SQLite) schemas; the broker no longer reads `event.requestContext.authorizer?.jwt?.claims.sub` and no longer stamps records with an owner. The Starkeep cloud is single-tenant per deployment — record custody is now entirely a property of the system, not a per-record field. The access-control engine's "owner has full access" branch was removed in the same commit.
- **The records table is also the duplicate-prevention boundary.** A unique index `uq_records_filename_hash` on `(original_filename, content_hash, deleted_at)` is intended to reject byte-identical re-uploads of the same filename while allowing re-upload after delete (tombstoned rows have a non-NULL `deleted_at`; live rows have NULL). Built with `CREATE INDEX ASYNC` because DSQL does not support `IF NOT EXISTS` on the async form (`ensureIndex` pre-checks `pg_indexes`). **Note (see Part 2): the prior partial-index form `WHERE deleted_at IS NULL` is not supported by DSQL, and the replacement scheme relies on NULLs colliding in a unique index — which they do not by default in PostgreSQL/DSQL — so dedup of live rows is effectively broken.**

Records are essentially immutable. `PUT /data/records/{id}` accepts only `originalFilename` and `parentId` updates. Editable content lives in the app-specific data world (out of scope here).

## The DSQL data store

DSQL is a managed PostgreSQL-compatible serverless cluster — but its surface is narrower than stock Postgres in three ways that shape every piece of code that touches it:

- **No multi-statement transactions for DDL** — every DDL statement runs in its own implicit transaction, so the schema initializer ships statements one at a time.
- **No PL/pgSQL anonymous code blocks** — `CREATE ROLE` and similar idempotency is done by probing `pg_roles` / `sys.iam_pg_role_mappings` and only issuing the create if absent.
- **No foreign-key constraints** — cascade and SET NULL semantics live in application code (the parent_id column is just plain text; the app must repoint or null it on delete).
- **No partial indexes** (`CREATE INDEX ... WHERE ...` returns SQLSTATE 0A000). Predicates must be folded into the index key. The dedup index (above) is the in-tree casualty.
- **Secondary indexes must be built async** (`CREATE INDEX ASYNC`), and the async form does not accept `IF NOT EXISTS`. `ensureIndex` pre-checks `pg_indexes` by name to stay idempotent.

The schema itself is small. Beyond `shared.records` and the per-category metadata tables, four small tables live in the same schema:

- `shared.access_grants` — one row per (app_id, type_id) carrying `access` (`read` | `readwrite`) and a `metadata_write` flag. The access-enforcer reads this once per request to build the in-memory grants object.
- `shared.app_install_steps` — the per-step ledger (one row per `(app_id, operation, step)`) the orchestrator writes during install/uninstall. Drives resume-on-failure: completed steps are skipped on retry.
- `shared.app_registry` — one row per installed cloud app (`app_id`, `version`, `name`, `installed_at`, `updated_at`). Source of truth for "is this app installed?" — populated by the orchestrator's `register_app` step, removed by `delete_app_registry`.
- `shared.app_syncable_namespaces` — registry of installed apps' app-specific syncable tables (used by the pull path to enumerate per-app tables).

The DSQL **adapter** (`storage-aurora-dsql`) is a thin `DatabaseAdapter` over `pg`. Records serialize to/from a single row shape; queries compile through Kysely's PostgreSQL dialect (compile-only, against `DummyDriver`) and execute through the per-request client. Transactions are implemented via savepoints because DSQL prohibits nested begin/commit but accepts savepoints.

The **IAM ↔ PG mapping** is the load-bearing piece of cloud-server-auth as it touches the data plane. `CREATE ROLE ... LOGIN` is not sufficient by itself; DSQL has a separate authorization layer (`sys.iam_pg_role_mappings`) that decides which IAM principal may log in as which PG role. Per-app install DDL adds the explicit mapping for each app role; uninstall removes it before dropping the PG role. Without this mapping the app's runtime `DbConnect` fails with `FATAL 28000` and no hint.

## The files bucket

A single S3 bucket (`<stackPrefix>-files-<accountId>-<region>`) holds every byte of every file the system stores in the cloud. The cloud data server provisions it during install and addresses it through `S3ObjectStorageAdapter` from `storage-s3`.

- **Key namespaces.** Two prefixes are legal: `shared/<category>/<shard>/<hash>` for shared records (content-addressed, app-agnostic), and `apps/<appId>/...` for per-app private bytes (owned by the named app). Anything else is rejected at the application layer.
- **Cross-app isolation has three layers.** The per-app permissions boundary caps each app role to its own `apps/<appId>/*` prefix; the bucket policy denies cross-app prefix access using a `${aws:PrincipalTag/starkeep:appId}` expansion; and the handler's `parseObjectKey` rejects `apps/<other-app>/...` keys before any AWS call.
- **Direct uploads/downloads via presigned URLs.** Browsers and the local data server hit S3 directly with a URL issued by the broker. This sidesteps the API Gateway payload limit and keeps the broker out of the byte-pumping path. The bucket has a permissive CORS configuration to make this work from the browser.
- **Multipart uploads on > 5 MB writes.** Handled by the S3 adapter automatically.
- **Cloud-side cleanup is partial.** App uninstall deletes `apps/<appId>/*` (under the app role, scoped by the boundary). Tombstoned shared records do not trigger a corresponding S3 cleanup — file lifetime follows the record lifetime, but blobs of soft-deleted records are not removed.

## Sync (cloud side)

The cloud data server's sync surface is exactly one endpoint per app: `POST /apps/{appId}/sync/exchange`. The request body is a `SyncExchangeRequest` carrying a per-nodeId watermark vector and any records / app-syncable rows the caller wants to push; the response is a `SyncExchangeResponse` carrying records / rows the caller hasn't seen yet plus a `hasMore` flag.

The cloud sits on the **responder** side of the exchange protocol. It uses `createInProcessSyncTransport` (from `sync-engine`) wrapping the per-request DSQL adapter, which is the same transport used in tests — there's no separate cloud-only sync implementation. The protocol is HLC last-write-wins; conflict resolution is implicit (compare HLCs, drop the older one) and there is no explicit conflict list.

The **channel split** is the cloud-side expression of the deployment topology:

- The `starkeep-drive` channel ships **all** shared records and no app-specific rows. The transport is created with `syncSharedRecords: true` and no `appSyncableSource`.
- Every per-app channel ships only that app's app-specific rows and no shared records. The transport is created with `syncSharedRecords: false` and an `appSyncableSource` built from `DsqlAppSyncableNamespaceStore` + `DsqlAppSyncableApplier` for that connection.

So every shared byte that reaches the cloud is written by the Drive channel under `...-app-starkeep-drive-role`, gated by the User-Data-Owner permissions boundary on `shared/*`. The per-app channels never write shared records — they couldn't, because their per-app PG role doesn't have INSERT on `shared.records` (unless they declared `readwrite` extensions in their manifest, which gates the local pre-ship check; even then, those rows would still flow over the Drive channel). The cross-cutting "how IAM, PG GRANTs, and bucket policy together enforce this" reasoning belongs to the bootstrap doc; what this topic enforces in code is: the channel split is a single `if (appId === DRIVE_APP_ID)` in the handler.

The cloud **HLC clock** is seeded per request from the highest cloud-stamped `updated_at` visible to the assumed role. The cloud nodeId is now per-Lambda-instance — `cloud-${AWS_LAMBDA_LOG_STREAM_NAME ?? randomUUID()}` — because the literal `"cloud"` nodeId let two warm Lambda containers mint timestamps with the same `(wallTime, counter, nodeId)`. The seed query was updated to `WHERE updated_at LIKE '%:cloud-%'` to pick up stamps from any cloud replica. New cloud writes (presently only tombstones from `DELETE /data/records/{id}`) get the per-instance stamp.

## Install (cloud-data-server itself)

Installing the cloud data server is one-shot foundational provisioning, not an idempotent "app install" of a third-party manifest. It happens once, before any other app can be installed, and is driven from the admin web UI by an admin user who has just assumed the admin-app role.

The install pipeline (`installCloudDataServer`):

1. **Mint the cloud-data-server role** with the foundational permissions boundary (routed to that boundary by a magic-string check on the app id). The role's standing inline policy carries the broker capability (`sts:AssumeRole` on `<prefix>-app-*`) plus the per-app HMAC-secret read powers — `ssm:GetParameter` on `/${stackPrefix}/app-creds/*` and `kms:Decrypt` conditioned on `kms:ViaService=ssm.*.amazonaws.com` — that the verifier needs to load app secrets at runtime.
2. **Ensure the Pulumi state passphrase exists.** `ensurePulumiPassphrase` creates `/${stackPrefix}/pulumi/passphrase` as an SSM SecureString with a fresh 32-byte value if absent, and leaves it alone if present. CloudFormation cannot create SecureString parameters, so bootstrap defers this to the installer. Crucially the installer never overwrites — Pulumi derives state-bucket encryption from this value, so rotation after any `pulumi up` would brick every later up/destroy. (Replaces the prior "rotate the bootstrap placeholder" flow.)
3. **Attach the wide temp-install policy** to the cloud-data-server role itself. This policy carries the install-time AWS verbs (DSQL cluster admin, S3 bucket admin on the well-known patterns, Lambda/API Gateway admin, CUR setup) that the foundational boundary permits but the runtime role does not standardly have.
4. **Wait ~60s for IAM propagation** to Lambda/CUR/etc., because PutRolePolicy's effects propagate to per-service authz caches on a delay measured in tens of seconds. The installer logs and waits rather than racing.
5. **Run an inline Pulumi program** under the cloud-data-server role's credentials. The program (`cloud-data-server-program.ts`) is hard-coded rather than manifest-driven because the resources it creates — DSQL cluster, files bucket and policy, Lambda + log group, API Gateway + Cognito JWT authorizer + reserved routes, billing bucket + CUR report — can't be expressed in the per-app manifest shape. The gateway's CORS config explicitly allows `X-Starkeep-App-Id` and `X-Starkeep-App-Sig`, the headers the HMAC verifier reads.
6. **Initialize the shared schema** against the now-existing DSQL cluster. `initializeSharedSchema` runs the full DDL each time (no migration ledger — see "Why no migrations" below) and is fully idempotent.
7. **Detach the temp-install policy.** On failure the installer intentionally leaves it attached so IAM/S3 cache propagation done during the failed run can be reused by the retry.

Idempotency is by existence checks rather than the `shared.app_install_steps` ledger, because that ledger lives in the very schema this install creates. Pulumi handles compute-step idempotency natively, and the schema DDL is independently idempotent.

A second built-in app install runs next: **`installDrive`** rides on the standard per-app `installApp` orchestrator (compute disabled, app-specific syncable disabled, only the identity + DDL stages). Drive's per-app role is minted with the User-Data-Owner boundary (routed by app id), and the DDL stage gives it the all-categories grants implied by `fileAccessAll: true`. After this point shared-record sync can flow.

**Pre-cleanup of orphans.** Before each `pulumi up` the installer probes for resources whose URNs are absent from current Pulumi state and tries to delete them best-effort — log groups, lambdas, buckets, CUR reports left by previous interrupted runs that would otherwise collide with the next `pulumi up`. Pulumi-managed resources are never touched. This is the pragmatic answer to install retries after a partial failure.

Per-app installs (cloud side) are a thin wrapper over the same orchestrator (`installApp`), gated by `assertCloudInstallableAppId` and the `assertNotReservedAppId` check. They mint the app role, attach a per-install temp policy on the install-ddl and install-infra roles, run DDL as install-ddl (PG role + IAM mapping + per-app schema + shared-table GRANTs + access-grants rows + app-syncable tables), run the app's Pulumi program as install-infra (the app's Lambdas/routes attach to the existing gateway), then detach. The orchestrator persists per-step status to `shared.app_install_steps` so a partial failure resumes cleanly.

## Uninstall

Uninstall is symmetric and idempotent. For the cloud data server itself, `uninstallCloudDataServer` attaches the temp-install policy (it covers the delete-side verbs too), assumes the cloud-data-server role, runs `pulumi destroy` against the same stack (which deletes DSQL, the bucket, the Lambda, the API Gateway, the CUR report and the billing bucket), then deletes the role plus all its inline policies. Drive uninstall (`uninstallDrive`) is a thin wrapper over `uninstallApp` with no compute teardown.

Per-app uninstall (the standard `uninstallApp` flow) is the symmetric inverse of install: destroy the per-app Pulumi stack as install-infra, delete `apps/<appId>/*` under the app role, revoke and drop everything DSQL-side as install-ddl (revoke all shared-table GRANTs, revoke `USAGE ON SCHEMA shared`, delete the `access_grants` and `app_syncable_namespaces` rows, drop the app schema, revoke the IAM-to-PG mapping, drop the PG role), delete the registry entry, delete the app's IAM role. **Shared records persist.** A shared photo created by app A stays in `shared.records` and in S3 after A is uninstalled; its `origin_app_id` continues to point at A's id immutably. The expected next step is some app that still holds matching grants to read it.

## Why no migrations (and what that means)

The cloud-data-server is **pre-production**. There is no migration ledger and no schema versioning; `initializeSharedSchema` applies the full DDL every time, relying on `IF NOT EXISTS` and pg_roles probes for idempotency. This is a deliberate choice — per project-level guidance, migrations are a production concern and are not implemented until they are needed and testable. Functionally this means: schema changes only land safely if they are pure additions (new tables, new columns with defaults). Anything that would require a backfill or rename has no plumbing today.

## Observational IAM check

A separate test package (`@starkeep/iam-permission-tests`) simulates every AWS call the installer makes against the policy actually attached to the calling principal at that moment, using `@cloud-copilot/iam-simulate`. There are contexts for `install-cloud-data-server`, `install-ddl`, and `install-infra`; the package replays Pulumi traces and node-side SDK traces against each and reports denials. The "expected calls" lists are authored alongside the policy builders the installer uses, so policy edits flow through without code duplication. This is the cloud-server-security topic's observational counterpart to the static "every temp action is also in the boundary" check the installer carries.

It does not run in production and is not part of the broker code path; it is a development-time guard that catches install-time IAM gaps before AWS does.

---

# Part 2 — Review and evaluation

## Missing behaviors

- **(Deferred with todo 15)** **Blob garbage collection for tombstoned records.** Soft-deleting a record updates `deleted_at` in DSQL but leaves the S3 blob in place. The records table grows with tombstones, and the files bucket grows with orphaned blobs that no live record references. There is no current path for either. (App-uninstall deletes `apps/<appId>/*` private keys, but shared keys under `shared/<category>/...` are not cleaned up by anything.) Whether this is "intentional, will be done out-of-band" or "intentional, never delete" is unclear; the *functional* gap is that disk usage in the cloud is monotonically increasing under normal use.
- **(Deferred with todo 16)** **No staleness signal on cached app credentials beyond expiry.** `getAppCreds` caches STS credentials per app id for ~14 minutes. If an admin uninstalls an app and immediately reinstalls it (which mints a fresh role with a new RoleId), the cached credentials remain valid against the *old* role identifier for up to the cache TTL. The Lambda would then keep brokering under stale credentials until the cached entry expires or the worker recycles. There is no cache invalidation hook tied to install/uninstall. The same property now applies to `hmacSecretCache` (5-min TTL): an uninstall + reinstall flips the per-app HMAC secret in SSM, but in-flight warm Lambdas continue to accept signatures under the old secret (or reject signatures from the new caller) until the cache expires.

## Behavioral bugs

- **(Deferred with todo 39)** **HMAC signature does not bind method, path, or time.** Input is `${appId}:` ++ body bytes. A signed body from one POST is replayable against any other POST endpoint that accepts the same shape, and any captured request can be replayed indefinitely. There is no nonce/timestamp window and no path/method covered by the MAC. For an internally-issued secret used between trusted infra components this is low risk, but it is a meaningful weakening of the prior posture where Cognito JWTs carried short expiries.
- **(Deferred with todo 17)** **`buildAppSyncableSource` opens a second DSQL client per request.** Each non-Drive `/sync/exchange` builds a fresh `DatabaseClient` (`appSyncableSource.client`) on top of the same per-app credentials, in addition to the per-request adapter's own client. Both are closed in `finally`, but the request now pays for two DSQL connect round-trips on every exchange. The 2026-06-10 refactor now also shares this client with the `/app-data/*` view inside the same request (`getAppSyncableSource` lazily builds at most one per request), which is good — but the per-request connect cost is unchanged.

## Behavior inconsistent with purpose

_(no remaining items)_

## Potential gaps

- **(Deferred with todo 40)** **`GET /app-data/files/<key>` pulls bytes just to verify existence before presigning.** The handler calls `view.getFile(subKey)` purely to return 404 when absent, then presigns via `storage.getSignedUrl`. Depending on whether `view.getFile` does a HEAD or a full GET in the factory, the Lambda may be downloading the entire object before issuing a redirect URL. A head-only existence probe would avoid the bytes round-trip.
- **(Deferred with todo 41)** **`/app-data/files/*` pushes bytes through APIGW + Lambda instead of using direct-to-S3 presigned URLs.** Shared data settled on the right pattern: client → broker → presigned S3 URL → client uploads/downloads bytes directly to S3, bypassing the gateway entirely. The 2026-06-10 `PUT /app-data/files/<key>` route instead reads `event.body` and writes through the Lambda, capped at API Gateway HTTP API's 10 MB request-body ceiling (the handler's nominal 20 MB cap is unreachable). App-private bytes are storage-identical to shared bytes — different key prefix only — and should ride the same direct-to-S3 mechanism. Top-priority follow-up.
- **(Deferred with todo 15)** **`shared.records.parent_id` integrity is fully application-managed because DSQL has no FKs.** Today no code repoints or nulls `parent_id` on a parent's tombstone; a child record (e.g. a thumbnail) keeps pointing at a soft-deleted parent. The dedup-by-(parentId, contentHash) check still works, but consumers reading `parent_id` get a stable reference to a deleted row. High-confidence gap: there is no `parent_id` repair pass anywhere.

None of the broader categories below this bar — e.g. "the API has no rate limiting", "there is no request-level tracing exported" — meet the high-confidence threshold for this section. They are real but speculative as gaps until the topic explicitly takes a position on them.
