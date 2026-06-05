# Cloud apps — Functional Review (2026-06-05)

Scope: the `cloud-apps` topic and its eight children — `cloud-apps-installing`, `cloud-apps-registering`, `cloud-apps-uninstalling`, `cloud-apps-compute`, `cloud-apps-app-data`, `cloud-apps-shared-data`, `cloud-apps-sync`, `cloud-apps-photos-example`. The companion `cloud-data-server` doc covers the broker, DSQL, S3 bucket, and per-request authorization model; this doc covers the same system from the **app's** perspective — what an app declares, how that declaration is realized in the cloud, what an app can do once running, and what tears down on uninstall. Cross-cutting topics (`app-specific-data`, `shared-data`, `data-sync`, `cloud-data-server`) are referenced as black boxes; their internals are out of scope here.

---

# Part 1 — Current state

## Overview

A **cloud app** is an installable unit that the Starkeep platform mounts behind the user's shared API Gateway. From the platform's standpoint it is one JSON file — the `starkeep.manifest.json` — describing the app's identity, the file extensions it wants to read or write in the user's shared store, optionally an app-specific data namespace, and optionally a set of Lambda handlers with their routes. From the user's standpoint it is just one more entry under `/apps/<appId>/...` on the same HTTPS endpoint the platform already exposes; from the app developer's standpoint it is a manifest plus, optionally, a `pnpm bundle` script that produces a `dist.zip`.

Three concepts organize the rest of Part 1:

- **Manifest as the spec.** Cloud apps are *declared*, not coded against AWS. The manifest is the contract: what file types the app handles, what routes it serves, what app-private data it needs. The platform owns the IAM/DDL/Pulumi side; the app ships zero infrastructure code.
- **Per-app cloud identity.** Each app's authority on the cloud is one IAM role plus one PG role plus a small set of grant rows. Everything the app can do — read shared records of a category, write to its own S3 prefix, query its app-private schema — is gated by these three identities, which are minted at install and dropped at uninstall.
- **Two built-in apps that the platform treats specially.** `cloud-data-server` is the broker itself, installed before any third-party app can be. `starkeep-drive` is the User-Data-Owner — the only channel that ships shared records to the cloud. Both ride the same orchestrator but are pinned to reserved app ids and route to special permission boundaries.

## The manifest

Every cloud-installable app is described by a single `starkeep.manifest.json` validated by `appManifestSchema` in `@starkeep/admin-manifest`. The cloud-relevant fields and what each one *causes* to happen at install time:

- **`id`** — the stable app identifier. The platform derives almost every other name from it: IAM role `<stackPrefix>-app-<appId>-role`, PG role `<stackPrefix>_app_<appId>` (lowercased, hyphens-to-underscores), Lambda name `<stackPrefix>-app-<appId>-<handlerName>`, route prefix `/apps/<appId>/...`, app-private schema `app_<id>`, S3 prefix `apps/<appId>/...`. App ids `cloud-data-server` and `starkeep-drive` are reserved (`assertNotReservedAppId`) and only the two built-in install wrappers may set `allowReservedAppId` on the orchestrator input.
- **`targets`** — must include `"cloud"` for the app to be cloud-installable.
- **`infraRequirements.fileAccess`** — a list of `{ extensions, access: "read" | "readwrite", metadataWrite, rationale }` entries. Each entry declares a set of file extensions the app wants to handle in the shared store. Per-extension grants are written verbatim into `shared.access_grants`; the implied set of *categories* (image, markdown, etc., excluding the unmapped `other`) drives metadata-table GRANTs in DSQL. Extensions outside the platform map are unreachable to apps; only Drive can claim the `other` catch-all via `fileAccessAll: true`.
- **`infraRequirements.fileAccessAll`** — wildcard authority. The manifest validator (in `admin-manifest`) refuses this flag on any id other than `starkeep-drive`; it routes Drive's IAM role to the User-Data-Owner permissions boundary and writes no per-extension grant rows (Drive's all-access is enforced at runtime by app id, not by grant lookup).
- **`infraRequirements.appSpecificSyncable`** — `{ tables: [...], files: boolean }`. Each table becomes a DSQL table `app_<id>.<tableName>` with two reserved sync columns (`updated_at`, `deleted_at`) plus an index on `updated_at`. `files: true` additionally creates the framework-owned `image_records` (FILE_RECORDS_TABLE) bookkeeping table under the same schema and opens the `apps/<appId>/syncable/` S3 prefix for the app. A row in `shared.app_syncable_namespaces` records the resulting table set so the sync pull path can enumerate it.
- **`infraRequirements.compute`** — `{ enabled, handlers: [...] }`. Each handler entry compiles to one Lambda + one log group + one APIGW v2 integration + one route per declared `routes` entry. Per-handler fields are `name`, `handler` (entry point), `memoryMb` (default 256), `timeoutSeconds` (default 30), `routes` (array of `"<METHOD> <path>"` strings, default `["$default"]`), `env` (map), and `auth` (`"jwt"` default — the route is wired to the gateway's shared Cognito JWT authorizer — or `"public"` — no authorizer, requests reach the Lambda unauthenticated).
- **`infraRequirements.brokerPower`** — `sts:AssumeRole` on `<stackPrefix>-app-*` roles. Only the `cloud-data-server` built-in may set this; it is the runtime-identity-switch power the broker needs and that nothing else has.
- **`migrations`** — ordered ids of shared-schema migrations. Empty for typical user apps; intended for system apps that ship shared-schema additions. Functionally inert today because the platform has no migration ledger (see the cloud-data-server doc's "Why no migrations" section).

The manifest is the entire contract between an app and the platform on the cloud side. Apps do not ship Pulumi code, do not declare IAM policies, and do not touch DSQL DDL — the orchestrator generates all of that from the fields above.

## Registering: how apps become known

There is no central registry of "available" cloud apps. App registration is **filesystem discovery from the admin's workstation**, performed at install time:

- Admin-web's `/api/apps/list` route, and the `cli-install-app` script's `resolveAppDir`, both scan a set of "app parent directories" for any subdirectory containing a `starkeep.manifest.json`. The parent-dir list is `config.appParentDirs` from `~/.starkeep/config.json`, falling back to the sibling `starkeep-apps/` checkout. First match by manifest `id` wins.
- The cloud install flow (`cli-install-app <appId>`) loads the manifest by id, validates it through `appManifestSchema`, builds a bundle by invoking `pnpm bundle` in the app dir (with `STARKEEP_APP_BASE_PATH=/apps/<appId>` and `STARKEEP_BUNDLE_OUT=<tmp>/dist.zip` in the env), and hands manifest + zip to `installApp`.
- The post-install registry write — `registerApp` in `admin-installer/src/registry.ts` — inserts one row into `shared.app_registry` (`app_id`, `version`, `name`, `installed_at`, `updated_at`). The orchestrator runs it as the last step of a successful install; uninstall's `delete_app_registry` step removes the row. The registry connection authenticates to DSQL as the `<stackPrefix>_installer` PG role, mapped from the admin-app IAM role by the IAM-to-PG grant set up at schema-init time — so writes share the same federated session that drove the install. Admin-web's Apps page queries this table via `POST /api/apps/cloud/list`, which means "is this app installed?" is a single DSQL row read rather than a sweep of AWS resources.

Built-in apps follow a parallel path: `cloud-data-server`'s install wrapper has no manifest discovery (it uses a hard-coded Pulumi program), and `starkeep-drive`'s manifest ships inside the installer package at `builtin-apps/starkeep-drive/manifest.json` and is loaded by file path. Neither participates in the workstation-scan flow.

## Installing a third-party cloud app

An app install is one HTTPS request from the admin UI to admin-web's `POST /api/apps/<appId>/cloud-install`, which spawns a `pnpm --filter @starkeep/admin-installer cli:install-app <appId>` subprocess and streams its stdout/stderr back over Server-Sent Events. The admin's freshly-minted STS credentials (obtained by signing in to Cognito and assuming the admin-app role in their AWS account) are passed in as environment variables. The same `cli:install-app` script runs unchanged when invoked directly from a terminal.

Inside the subprocess, the orchestrator (`installApp` in `admin-installer/src/orchestrator.ts`) runs a per-step state machine. The role chain is the same for every step in this section: admin credentials → manager role → step-specific role (DDL, infra, or the app role itself).

The ordered steps:

1. **`create_iam_role`** (as Manager). Mints `<stackPrefix>-app-<appId>-role` with one of three permissions boundaries:
   - the **User-Data-Owner** boundary if `fileAccessAll: true` (Drive only),
   - the **foundational** boundary if `brokerPower: true` (cloud-data-server only),
   - otherwise the per-app boundary.

   The role's inline runtime policy is built from `fileAccess` + `appSpecificSyncable` to cap S3 prefixes (`shared/<category>/...` for granted categories, `apps/<appId>/...` for app-private) and DSQL connect (`sts:DbConnect` on the app's PG role).
2. **`attach_temp_install_ddl_policy`** (as Manager). Attaches `<stackPrefix>-temp-install-ddl-<appId>` to the `install-ddl-role`, granting the DSQL admin verbs needed to run this app's DDL.
3. **`run_dsql_ddl`** (as `install-ddl-role`). Connects to DSQL as the `admin` PG role with a `DbConnectAdmin` token and runs the per-app DDL:
   - Probe-then-`CREATE ROLE LOGIN` for the app's PG role.
   - `GRANT "<pg-role>" TO admin` — required because DSQL `admin` is not a true Postgres superuser, so `CREATE SCHEMA ... AUTHORIZATION <role>` only works if the calling session can `SET ROLE` to the target.
   - Probe-then-`AWS IAM GRANT "<pg-role>" TO '<app-role-arn>'` — the DSQL-side IAM-to-PG mapping; without it, runtime `DbConnect` fails with FATAL 28000 no matter what PG-level grants exist.
   - Create the app's private schema `app_<id>` and grant the app role ALL on it (plus `ALTER DEFAULT PRIVILEGES` so future tables in that schema inherit the grant).
   - Grant `USAGE` on `shared`, `SELECT` on `shared.records`, and add `INSERT/UPDATE/DELETE` on `shared.records` if any extension is writable.
   - Per category implied by the grants, grant `SELECT` (and `INSERT/UPDATE` if writable or `metadataWrite`) on `shared.record_<category>_metadata`. `other` has no metadata table and is skipped.
   - Upsert one row per declared extension into `shared.access_grants(app_id, type_id, access, metadata_write)` — the broker reads these per request. Drive (fileAccessAll) writes zero grant rows; its authority is granted at runtime by app id in the access enforcer.
   - For each `appSpecificSyncable.tables` entry, `CREATE TABLE IF NOT EXISTS app_<id>.<table>` with the declared columns plus the reserved `updated_at TEXT NOT NULL` / `deleted_at TEXT` sync columns, an `idx_<schema>_<table>_updated_at` index, and `SELECT/INSERT/UPDATE/DELETE` to the app role. If `appSpecificSyncable.files`, the framework-owned `image_records` (FILE_RECORDS_TABLE) bookkeeping table is created under the same schema with the same shape and grants.
   - If any of the above ran, upsert one row into `shared.app_syncable_namespaces(app_id, tables_json, files_enabled)` so the pull path knows which tables to enumerate.
4. **`detach_temp_install_ddl_policy`** (as Manager). Symmetric to step 2 — the broad DSQL admin verbs are gone the moment the DDL transaction ends successfully.
5. **`put_s3_keep_file`** (as the app role). Writes a marker object under `apps/<appId>/.keep`. The point is to confirm the runtime S3 path works under the freshly-minted credentials before any user-data interaction is attempted.
6. **`attach_temp_install_infra_policy`** (as Manager). Skipped if the manifest has no `zipBuffer` and `compute.enabled: false`. Attaches the per-app temp policy to `install-infra-role` granting the Lambda / API Gateway / artifacts-bucket verbs needed for this app's Pulumi up.
7. **`upload_bundle`** (as `install-infra-role`). Puts `dist.zip` at `apps/<appId>/latest/dist.zip` in the artifacts bucket. Skipped if no `zipBuffer`.
8. **`install_compute_stack`** (as `install-infra-role`). Runs an inline Pulumi program built from the manifest (`buildPulumiProgram`):
   - For each `handlers[i]`: one CloudWatch log group `/aws/lambda/<fnName>`, one `aws.lambda.Function` (Node 22, exec role = the app role, code = `s3://<artifacts>/apps/<appId>/latest/dist.zip` with `sourceCodeHash` set so Pulumi detects code changes), one `aws.lambda.Permission` so APIGW can invoke it, one `aws.apigatewayv2.Integration` (AWS_PROXY, payload format v2), and one `aws.apigatewayv2.Route` per route entry.
   - Every route is **prefix-rewritten** before being submitted: `"GET /foo"` becomes `"GET /apps/<appId>/foo"`, `"GET /"` collapses to `"GET /apps/<appId>"` (APIGW v2 rejects empty path segments), and `$default` is passed through.
   - The first sub-segment after `/apps/<appId>/` is checked against the reserved set `{data, files, sync, health}`; a literal collision is a hard install failure. `{proxy+}` is allowed and is shadowed at request time by the broker's more-specific reserved routes.
   - Lambda env always gets `STARKEEP_APP_ID`, `STARKEEP_STACK_PREFIX`, `STARKEEP_DSQL_HOSTNAME`, `STARKEEP_FILES_BUCKET`; any `env` keys the manifest left as empty strings (e.g. `STARKEEP_API_GATEWAY_URL`, `STARKEEP_USER_POOL_ID`, `STARKEEP_USER_POOL_CLIENT_ID`, `STARKEEP_IDENTITY_POOL_ID`) are filled by the installer from `~/.starkeep/config.json`.
   - Routes with `auth: "jwt"` (the default) attach the gateway's existing Cognito JWT authorizer; `auth: "public"` skips it entirely.
9. **`detach_temp_install_infra_policy`** (as Manager). Symmetric to step 6.
10. **`register_app`** — inserts one row into `shared.app_registry` keyed by app id (see "Registering" for what the row contains and how admin-web consumes it).

A few orchestrator-wide properties matter functionally:

- **Pulumi state and CLI are admin-owned, not platform-owned.** State is kept in `s3://<stackPrefix>-pulumi-state-<account>-<region>/` (Pulumi backend), the config passphrase is in SSM at `/<stackPrefix>/pulumi/passphrase`. The Pulumi CLI is installed on demand into `~/.starkeep/pulumi/` the first time any cloud install runs and reused on every subsequent invocation.
- **IAM propagation is the consistent long tail.** Both DSQL `DbConnectAdmin` and S3 `ListBucket`/`GetAccelerateConfiguration` are pre-probed with `retryOnAccessDenied` budgets of ~5 minutes. Without them, the very first DDL statement or the very first Pulumi state-backend read fails with an opaque error inside a subprocess.
- **Idempotency is by existence checks, plus a durable step ledger.** Each step is naturally idempotent — Pulumi handles its own resource state, DDL probes `pg_roles` and `sys.iam_pg_role_mappings` before mutating, S3 `put_s3_keep_file` is a no-op-on-rewrite — and on top of that the orchestrator wraps every step in `runStep`, which writes `pending` / `done` / `failed` rows into `shared.app_install_steps` (PK `(app_id, operation, step)`) via the same registry connection used for `shared.app_registry`. On retry, completed steps are skipped: `getCompletedSteps` reads the `done` rows for the (appId, operation) pair before the orchestrator starts walking the state machine. A re-run after a mid-install failure resumes from the failed step rather than redoing the earlier ones.

## App identity and the ceiling on what an app can do

Once installed, an app runs as exactly one principal in the cloud: its IAM role `<stackPrefix>-app-<appId>-role`. Everything that role can do at runtime is the *intersection* of its inline policy, its permissions boundary, the bucket policy on the files bucket, the DSQL IAM-to-PG mapping, and the per-extension grants in `shared.access_grants`. These layers don't overlap accidentally — each is set by a specific install step above, and each constrains a different surface:

- **Inline runtime policy** — built from `fileAccess` and `appSpecificSyncable`. Caps S3 access to the prefixes the app actually needs (`shared/<category>/<shard>/<hash>` for granted categories, `apps/<appId>/...` for app-private). Grants `sts:DbConnect` on `<pg-role>`.
- **Permissions boundary** — selected from one of three (per-app / foundational / User-Data-Owner) by the magic-string checks in `createAppRole`. The boundary is the ceiling regardless of inline policy: a future runtime-policy bug cannot exceed it. (Cross-app isolation on the files bucket is additionally enforced by the bucket policy's `${aws:PrincipalTag/starkeep:appId}` check.)
- **DSQL IAM-to-PG mapping** — the `AWS IAM GRANT` step. Without this row, runtime `DbConnect` fails with FATAL 28000 even if the IAM policy permits the API call. With it, the app can connect to DSQL as `<pg-role>`.
- **PG grants** — the per-app schema is owned by the app role; `shared.records` is `SELECT`-able and conditionally writable; per-category metadata tables are `SELECT`/conditionally `INSERT/UPDATE`-able.
- **`shared.access_grants` rows** — the app-layer extension-level check the broker enforces per request. This is finer-grained than the IAM boundary, which caps at the category level only.

For an app's purposes, the practical consequence of this layering is that **what an app can do in the cloud is exactly what it declared in its manifest**. An app cannot widen its file-extension grants at runtime, cannot reach another app's S3 prefix or DSQL schema, cannot call broker endpoints on behalf of a different `appId`, and cannot reach AWS services not implied by its manifest. The deep "why" of the IAM/PG layering belongs to `cloud-server-auth` and the bootstrap docs; what matters from the app POV is that the manifest *is* the policy.

## Cloud compute

Cloud apps that opt into `compute.enabled` ship a `dist.zip` bundle and run as Lambdas behind the shared API Gateway. The functional shape of an app handler:

- **Routing.** Each handler claims one or more `routes` of the form `"<METHOD> <path>"`. The installer prefixes each with `/apps/<appId>` before submitting to API Gateway. The reserved sub-paths `data`, `files`, `sync`, `health` are denied at install time on literal collisions; `{proxy+}` is the typical catch-all and is silently shadowed by the broker's more-specific routes at request time.
- **Auth.** `auth: "jwt"` wires the route to the gateway's Cognito JWT authorizer; the Lambda sees an authenticated event whose `Authorization` header carries the same JWT the browser presented. `auth: "public"` skips the authorizer and lets unauthenticated traffic reach the handler — used by static-asset handlers that need to serve the bare URL.
- **Environment.** Every handler is launched with `STARKEEP_APP_ID`, `STARKEEP_STACK_PREFIX`, `STARKEEP_DSQL_HOSTNAME`, `STARKEEP_FILES_BUCKET` so it can find the platform without configuration. Any additional `env` keys with empty-string values in the manifest are filled by the installer from `~/.starkeep/config.json` (currently: gateway URL, user pool id, user pool client id, identity pool id). This pattern means apps declare which platform variables they want without coupling to handler or app names.
- **Runtime identity.** The Lambda exec role is the same app IAM role; in-Lambda AWS SDK calls run under that role and are scoped exactly the same as a browser call to the broker would be. The shared API Gateway, broker, and per-app Lambda all share the same principal-tag-driven authorization story.
- **Data access pattern.** The expected (and seen in `photos`) pattern is for the Lambda to forward the inbound `Authorization` header to the cloud-data-server's `/apps/<appId>/...` endpoints and let the broker enforce records/files access. The Lambda's own role technically permits direct DSQL and S3 access for what its manifest declares, but the broker is the recommended single path because (a) the access-enforcer's per-extension check is finer than the IAM boundary, and (b) it leaves a single auditable surface.

Static / web-asset handlers fit the same shape. The Photos manifest's `static` handler (Next.js + OpenNext) is just another Lambda with `auth: "public"` and `routes: ["GET /", "GET /{proxy+}"]`, no different at the install layer from the resize-handler — the only thing that varies is the bundle contents.

## Relation to shared data

A cloud app's view of shared data is exactly what its `fileAccess` (or `fileAccessAll`) declared — converted into:

- **Per-extension entries in `shared.access_grants`** that the broker consults on every read/write of `shared.records`.
- **Category-level GRANTs on `shared.record_<category>_metadata`** that mirror the broker's category checks at the database layer.
- **S3 ceiling on `shared/<category>/...`** prefixes via the permissions boundary, enforced by the bucket policy.

An app interacts with shared data **only through the broker** — `POST /apps/<appId>/data/records`, `POST /apps/<appId>/files/presign`, etc. — and the broker decides per request whether the call is permitted. Cross-app reads (an app seeing a record written by another app) are allowed when the *other* app's record's type sits in *this* app's grants; that is the central design point of shared data, and it shows up here as "the broker gates on the caller's grants, not the writer's".

Two specifics worth calling out from the app POV:

- **Shared records carry an immutable `origin_app_id`** that points to the app that registered them. An app uninstall does not remove shared records it produced; they keep pointing at the now-gone app id. Whether any current app can read them depends on whether *some* installed app still has the matching extension in its grants.
- **Drive is the only writer of shared records that the platform "trusts wholesale".** Other apps see shared records only as readers/writers gated by their grants; Drive's role is the User-Data-Owner channel that originates shared records into the cloud. The mechanics live with `data-sync` and the cloud-data-server doc; for cloud apps it means "the records you read in the cloud almost certainly came from Drive".

## Relation to app-specific data

An app's app-specific data namespace in the cloud is `app_<id>.*` in DSQL plus `apps/<appId>/...` in S3. Concretely:

- **DSQL.** Each declared `appSpecificSyncable.tables` entry becomes a real table under the app's private schema, accessible only to the app's PG role. The reserved `updated_at` / `deleted_at` columns are inline HLC timestamps the sync runtime maintains.
- **Object storage.** Setting `appSpecificSyncable.files: true` opens the `apps/<appId>/syncable/` prefix (and creates the framework-owned `image_records` row table that the sync runtime uses to associate file rows with their bytes). Apps with row-only app-specific data leave the flag false; their `app_<id>` schema still has whatever they declared but no S3 sync prefix.
- **Visibility.** No other app can see this data — not Drive, not the cloud-data-server beyond its broker role. Cross-app isolation is enforced by the IAM boundary on S3, the PG role on DSQL, and the broker's app-id gating on every route.

The general "what app-specific data is" story belongs to the `app-specific-data` topic; from cloud-apps' POV, the manifest's `appSpecificSyncable` is exactly what materializes in the cloud at install time and disappears at uninstall.

## Sync from the cloud app POV

A cloud app participates in sync as a *peer*, not as a router. The platform exposes one endpoint per app: `POST /apps/<appId>/sync/exchange`. The request body declares a per-nodeId watermark and any records / app-syncable rows the caller wants to push; the response carries records / rows the caller hasn't seen yet plus a `hasMore` flag.

What a cloud app "sees" through this surface:

- For **app-specific data**, only its own `app_<id>.*` tables — the pull path looks them up in `shared.app_syncable_namespaces` (the row installer wrote at DDL time) and enumerates the registered tables, including the framework-owned `image_records` table when `appSpecificSyncable.files` was set.
- For **shared data**, only records whose type is in the caller's grants. The grant set is the same `shared.access_grants` rows the broker consults for per-request authorization.

The mechanics of how the broker assembles a response, how watermarks advance, and how files-sync rows pair with their content blobs live with `data-sync` and `cloud-server-sync`; from the cloud-app POV the surface is one HTTP endpoint and what it returns is exactly what the app's manifest entitles it to.

A cloud app's Lambda usually doesn't *call* `/sync/exchange` itself — sync is driven from the local data server outward. But a cloud-only Lambda that needs a snapshot of app data does it through the same endpoint as the local server would: hit `/apps/<appId>/sync/exchange` under the same JWT and consume what comes back.

## Photos as a concrete example

The Photos sample app exercises a representative slice of the surface:

- **Manifest shape.** Two compute handlers — `api` (the resize Lambda) and `static` (the OpenNext-built Next.js server) — plus a `fileAccess` entry granting `readwrite + metadataWrite` for the raster image extensions (`jpg, jpeg, png, gif, webp, heic, heif, avif, bmp, tiff, tif`), plus an `appSpecificSyncable` with one `image_enriched` table (per-photo caption/title/date override) and `files: true`.
- **Web tier.** The `static` handler runs the OpenNext build of `photos-web` with `auth: "public"` on `GET /` and `GET /{proxy+}`. The Next.js server inside is configured by the installer with `STARKEEP_API_GATEWAY_URL`, user-pool ids, and identity-pool id; it then drives all data ops through the broker over HTTP under the user's JWT. There is no embedded SDK in this handler — it is a true thin client.
- **Compute tier (`resize-handler`).** Triggered by `POST /apps/photos/api/resize` with `auth: "jwt"`. The handler **forwards the inbound `Authorization` header on every call to the broker** — fetching the source record, requesting a presigned URL for the original bytes, presigning a PUT for the resized bytes, registering the thumbnail record under the source's id as `parentId`, and writing dimensions into `image` metadata. The resize Lambda does no direct DSQL or S3 calls; everything rides the broker.
- **Thumbnails are shared records the app writes by convention.** The thumbnail bytes are *shared data*, not app-private. They're content-addressed under `shared/image/<shard>/<hash>` and registered with `origin_app_id = photos`. The `parentId` field links them to the source record; the broker's dedup-by-`(parentId, contentHash)` rule prevents duplicate thumbnails for the same original. The platform's interpretation of "derived image bytes" is the broker's, not a special category — they're just shared image records with a parent pointer.
- **What gets installed.** A foundational + per-app permissions boundary; one app IAM role; the `photos` PG role with grants on `shared.records`, `shared.record_image_metadata`, and the app's own schema; the `app_photos.image_enriched` table and the `app_photos.image_records` framework table; access-grant rows for the eleven image extensions; the resize Lambda at `POST /apps/photos/api/resize` (JWT-auth); the static Lambda at `GET /apps/photos` and `GET /apps/photos/{proxy+}` (public).

Photos is more interesting as a *shape* than as application logic — it shows that an app can blend a JWT-auth compute handler, a public static handler, shared-record reads/writes, app-specific data (sync-enabled), and a presigned-URL upload flow without writing anything beyond the manifest and the handler code.

## Uninstalling a cloud app

Uninstall is the symmetric inverse of install (`uninstallApp`), executed by the same orchestrator with steps gated on the manifest:

1. **Tear down compute.** If `compute.enabled`, attach the temp-uninstall-infra policy, run `pulumi destroy` on the per-app stack (removes all Lambdas, log groups, integrations, routes for the app in one call, plus `workspace.removeStack` to drop the stack from Pulumi state), delete `apps/<appId>/latest/dist.zip` from the artifacts bucket, detach.
2. **Delete app's S3 objects** (as the app role). Under its own permissions boundary, the app role can only delete `apps/<appId>/...`; shared-prefix blobs are untouched. The app's content under the `apps/` namespace disappears here.
3. **Reverse the DDL** (as `install-ddl-role`). Revoke `ALL` on `shared.records` and on each per-category metadata table the app had grants on, revoke `USAGE ON SCHEMA shared` (otherwise `DROP ROLE` trips PG 2BP01), delete the app's `shared.access_grants` rows and `shared.app_syncable_namespaces` row, `DROP SCHEMA app_<id> CASCADE` (taking every app-specific table with it), `AWS IAM REVOKE` the IAM-to-PG mapping (probe first; revoking an absent mapping errors), `DROP ROLE` the PG role.
4. **Clear the registry.** `delete_app_registry` deletes the app's row from `shared.app_registry` and its step-ledger rows from `shared.app_install_steps`, so once uninstall completes the cloud has no record that the app was ever installed. (`shared.access_grants` rows are revoked separately during `run_dsql_uninstall_ddl`.)
5. **Delete the IAM role** (as Manager). All inline policies are stripped first, then the role itself goes.

What survives an uninstall:

- **Shared records the app produced.** The `shared.records` and metadata-table rows the app `origin_app_id`-stamped continue to exist and remain readable/writable by any other app whose grants cover the type. The S3 blobs at `shared/<category>/...` likewise stay.
- **Tombstones.** Any soft-deleted records the app produced stay tombstoned; the tombstones do not turn into hard deletes.

What disappears:

- Everything app-private: the IAM role, the PG role, the IAM-to-PG mapping, the `app_<id>` schema and all its tables, all `apps/<appId>/...` S3 keys, the per-app Lambdas, log groups, integrations, and routes.
- The Pulumi stack record for the app.

The store grows asymmetrically: cloud-side install + uninstall of the same app many times will leave behind the shared records each install produced. That's intentional from the shared-data design's POV (records persist across apps); whether it's actually "intentional, will be GC'd later" or "intentional, never delete" is a question the cloud-data-server doc already flags as unresolved.

## Open questions

- **Static handler bundle.** The Photos manifest declares a `static` handler at `index.handler` but the only handler code in the photos repo is `resize-handler.ts`. The `static` Lambda's contents come from the OpenNext build, packaged by the app's `pnpm bundle`. The convention "the manifest names a handler entry point that the bundle provides" is implicit; first-time app developers may not realize the bundle is their responsibility to assemble correctly.
- **Cloud install of a *non-builtin* app outside `starkeep-apps/`.** The configured `appParentDirs` is supposed to support this, but there is no in-tree user-app today to confirm the discovery path works end-to-end on a sibling checkout. The script's `expandHome` and per-dir scan suggests it should; not exercised.

---

# Part 2 — Review and evaluation

## Missing behaviors

_(no remaining items)_

## Behavior inconsistent with purpose

- **`install_compute_stack` step name implies it skips when `compute.enabled: false`, but the *only* check is on `zipBuffer || ir.compute.enabled`.** A future app shape that uploads a bundle for some other reason but has no compute would still attach/detach the temp-install-infra policy. Today no caller does this — `cli-install-app` only builds a bundle when the manifest has compute — but the gate's wording in the orchestrator is loose enough that any change in caller shape could exercise it.

## Behavioral bugs

- **No app-level concurrency guard.** Nothing prevents two `cli-install-app <same-id>` invocations from running side by side against the same DSQL cluster and Pulumi state bucket. The DSQL DDL probes are not transactional across statements, the Pulumi state lock would protect the compute stack but not the temp-policy attach/detach dance, and the registry has no row to lock against. Practically the admin-web SSE endpoint serializes through `runningChild`, so the UI path is single-flight, but a terminal invocation alongside a UI invocation is not. The cloud-data-server doc's parallel claim that "the orchestrator is serialized per app" is true for the UI but not enforced at the platform layer.
- **Reserved-subpath check operates only on `path` literals, not `{proxy+}` patterns that *could* shadow reserved routes.** If a manifest declares `GET /{proxy+}` plus `GET /data/foo`, the install-time check would reject the second route (the literal collision) but not flag that the first wildcard would silently never match `/data/...`. APIGW v2 specificity makes this actually safe (the broker's more-specific reserved routes win), but the install-time error message says the literal route is "reserved for the cloud-data-server and cannot be claimed by an app handler" — which is true *and* the wildcard pattern is also unable to claim those paths at runtime. Worth surfacing in the error so app developers understand which reserved paths are actually reachable.

## Potential gaps

- **No path for shared-schema additions by an app.** The manifest carries a `migrations` array intended to resolve to `.sql` files alongside the manifest, but nothing in the orchestrator reads it; `initializeSharedSchema` runs the platform's hard-coded DDL only. As a consequence an app cannot ship a new shared-record category or a new metadata column even in the "pure addition" shape that the no-migration-ledger model would technically tolerate. Whether this is a real gap depends on whether apps are *expected* to extend shared schema — the design intent is unclear from the code, but the field is in the schema, so something was envisioned.
- **No version pinning across install runs.** `installApp` accepts `version` and the registry stub logs it, but nothing stores it. A re-install of an app at a different `version` produces no record of the change. Roll-backs and "what version is currently installed?" queries have no answer in-band.
