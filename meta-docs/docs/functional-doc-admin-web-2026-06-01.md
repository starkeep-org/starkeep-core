# Functional documentation — admin-web (2026-06-01)

**Topic scope:** the `admin-web` subtree of the starkeep codebase-manager index (parent + `build-run-local`, `cloud-app-controls`, `cloud-auth`, `cloud-setup`, `local-server-controls`).

**Audience:** new contributors to starkeep who need to understand what admin-web is, what its supporting packages do, and how they fit together.

**Modules covered in Part 1:** `apps/admin-web`, `packages/admin-core`, `packages/admin-installer`, `packages/admin-manifest`.

> **Note (2026-06-01):** This doc originally covered `packages/admin-providers` and `packages/admin-shared` as well; both were dead code from an earlier hosted-control-plane idea and were deleted during review processing. The corresponding Part 1 sections below have been removed. `packages/admin-gateway` was also indexed under admin-web at draft time but had already been deleted from the repo; index entry has been removed.

---

# Part 1 — Current state

## Overview

admin-web is starkeep's control plane: a small Next.js app (`apps/admin-web`) that an operator runs locally to bootstrap a starkeep cloud account, install apps into it, and inspect ongoing state. The README sums it up as "the command center for Starkeep" — it guides the user through the full setup process and provides ongoing visibility into local and cloud state.

The UI is thin; the substance lives in a cluster of supporting libraries:

- **`admin-core`** — backend domain helpers used by admin-web (bootstrap CloudFormation template generation, IAM permission boundaries, IAM-statement-to-YAML rendering for inline policies).
- **`admin-installer`** — the install/uninstall orchestrator. Owns the state machine that turns "user clicked install" into a running app on AWS (IAM role lifecycle, DSQL DDL, Pulumi compute stack, local SQLite registry).
- **`admin-manifest`** — Zod schemas + validation for the `manifest.json` that every starkeep app ships. Consumed by admin-installer.

Dependency wiring at the package-manifest level: `admin-web` depends only on `admin-core`. `admin-installer` depends on `admin-manifest` and on packages from other topics (notably `@starkeep/shared-space-api`, `@starkeep/core`, storage adapters). `admin-manifest` and `admin-core` are leaves of the admin subtree.

Cloud calls from admin-web happen through one of three routes: (1) directly from the browser via AWS JS SDK clients (Cognito sign-in, S3 reads for cost reports), (2) from admin-web's own Next.js API routes (e.g. CloudFormation cross-account plan/apply), or (3) by spawning a pnpm CLI subprocess that runs `admin-installer` locally — admin-web passes through AWS credentials it obtained via Cognito sign-in + assumption of the bootstrap-created `admin-app` IAM role in the operator's AWS account.

## apps/admin-web

**Implied purpose.** The single user-facing entry point for starkeep administration. Walks a new user through bootstrapping their cloud account, then becomes the day-to-day surface for inspecting local + cloud state and installing/uninstalling apps.

**User-facing behavior.**

- **Dashboard (`app/(shell)/page.tsx`)** — Shows local data-server status (online/offline, watch directories, synced file counts, record-type counts) and cloud infrastructure status. Polls the local data-server on `127.0.0.1:9820/health`.
- **Cloud Setup Wizard (`app/cloud-setup/page.tsx`, `src/components/CloudSetupWizard.tsx`)** — A 5-step flow: (1) enter the outputs of the user-launched CloudFormation bootstrap stack, (2) confirm the stack outputs were read correctly, (3) create a Cognito user, (4) sign in to verify credentials, (5) deploy IAM + cloud-data-server infrastructure. Each step persists its slice of state to `~/.starkeep/config.json` so the wizard can resume across reloads.
- **Settings (`app/(shell)/settings/page.tsx`)** — Import/export `~/.starkeep/config.json`, redeploy infrastructure, reset the wizard to a blank state.
- **Apps (`app/(shell)/apps/page.tsx`)** — Lists installed local and cloud apps in two tabs, allows installing new apps, uninstalling, and the special "cloud-install" flows for built-in apps (Starkeep Drive, Cloud Data Server).
- **Permissions** — Surfaces IAM statement groups (SST, Aurora DSQL, S3, Lambda, API Gateway, CodeBuild) and lets the operator create/update/delete permission stacks.
- **Toasts and a streaming "command output" modal (`CommandOutput.tsx`, `CommandOutputModal.tsx`)** are the common feedback surface for long-running operations.

**Internal behavior.**

- **Local persistence is `~/.starkeep/config.json`**, mediated by `app/api/config/route.ts`. On first read, if `appParentDirs` is empty, the route seeds it with a default of `~/starkeep-apps/`. `region` and `s3Region` are deliberately *not* persisted — they're derived from `userPoolId` on each read.
- **Cognito session lives in `localStorage`** (`src/lib/cognito-auth.ts`): id token, refresh token, and identity-pool IAM credentials. Tokens are refreshed inline on next fetch when expiry is detected.
- **Cross-account AWS calls** assume a delegated role in the user's account via STS and then drive CloudFormation through `src/lib/cloud-client.ts`. Capabilities `CAPABILITY_IAM` and `CAPABILITY_NAMED_IAM` are passed unconditionally.
- **Cost projection (`src/lib/cost-usage-report.ts`)** reads AWS CUR (Cost and Usage Report) S3 data via assumed identity-pool credentials and aggregates monthly to project spend.
- **Daemon/CLI lifecycle** (`src/lib/exec-commands.ts`, `app/api/exec/*`) lets the UI spawn and stream output from CLI processes — used to start/stop the local data-server daemon.
- **Graceful local-server fallback** — if `127.0.0.1:9820` doesn't respond, the dashboard shows a degraded state but does not block the rest of the UI.

## packages/admin-core

**Implied purpose.** Backend domain helpers used by admin-web (and by the install pipeline transitively): how the bootstrap CloudFormation template is generated, what the IAM permission boundaries for the bootstrap-created roles look like, and how IAM statement JSON is rendered into the YAML shape CloudFormation inline policies expect.

**User-facing behavior.** None directly. The bootstrap-template helpers produce the CloudFormation console URLs the wizard sends the user to.

**Internal behavior.**

- **`src/template-generator.ts`** — Generates the CloudFormation template for a static web-app stack (S3 + CloudFront with the SPA-style 403/404 → `/index.html` mappings). The template is a hardcoded string; only the bucket name and environment are parameterized.
- **`src/iam-utils.ts`** — `renderStatementsYaml()` serializes JSON IAM statements into the YAML shape CloudFormation inline policies expect.
- **`src/bootstrap/`** — A family of permission-boundary and policy-statement bundles:
  - `bootstrap-template.ts` — `generateBootstrapTemplate()` + the CloudFormation console URLs (create-stack URL, outputs URL).
  - `manager-policy.ts` — the cross-account "manager" role's policy (CloudFormation, DSQL, S3, Lambda, API Gateway, CodeBuild, IAM).
  - `admin-app-policy.ts` — the `admin-app` IAM role's execution policy. (The admin-app role is a federated entry point that operators assume via Cognito sign-in to perform administrative actions in their AWS account; it is not a Lambda.)
  - `permissions-boundary.ts` — per-app permission boundary ceilings (file-category limits, no cross-app access).
  - `foundational-permissions-boundary.ts` — wider boundary for the cloud-data-server (foundational shared resources).
  - `user-data-owner-permissions-boundary.ts` — boundary for Starkeep Drive's shared-data write role.
  - `install-ddl-boundary.ts`, `install-infra-boundary.ts` — temporary boundaries attached during install and detached afterward.

No code in `admin-core/src/` makes AWS calls itself; it generates the strings and shapes that callers send.

## packages/admin-installer

**Implied purpose.** Turn the high-level instruction "install (or uninstall) this app" into the concrete steps needed in AWS and in the local SQLite registry — and do it idempotently so a partially failed install can be retried.

**User-facing behavior.** No direct UI. Run as a pnpm CLI subprocess that admin-web spawns from its API routes (`apps/admin-web/app/api/.../install/route.ts` calls `pnpm --filter @starkeep/admin-installer cli:install-*`); also runnable directly from `packages/admin-installer/scripts/cli-install-*.ts` for development. The local-data-server (`apps/local-data-server/server.ts`) also imports `installLocal` / `uninstallLocal` for the local-side install path.

**Internal behavior.**

- **Cloud orchestrator (`src/orchestrator.ts`)** — A linear state machine for `installApp` / `uninstallApp`. Each step is recorded as `pending` in the `shared_app_install_steps` DSQL ledger before executing and marked `done` after success. On retry, completed steps are skipped. The step sequence (roughly): create app IAM role → attach temp infra policy → upload bundle to S3 → run Pulumi compute stack → run DDL → register app row → create access-grant policies → detach temp policies → cleanup-on-failure handlers.
- **Local installer (`src/local/installer.ts`)** — Same idempotency model (shared step ledger) but for the local side: validates the manifest, mints or reuses an HMAC secret, writes a registry row, creates access grants, creates syncable tables, and registers the syncable namespace.
- **Built-in installs (`src/builtin-installs.ts`)** — Special-cased wrappers for `installCloudDataServer`, `installDrive`, `uninstallDrive`. The cloud-data-server Pulumi program is hardcoded (`buildCloudDataServerProgram`) because it provisions foundational resources (DSQL cluster, shared bucket, API Gateway) that the per-app Pulumi shape doesn't cover. Built-in installs use existence checks instead of the step ledger because the ledger table itself is created by the schema-init they run. (See the header comment on `orchestrator.ts` for the same explanation from the orchestrator's side.)
- **IAM (`src/iam.ts`)** — `createAppRole` creates `<stackPrefix>-app-<appId>` with a trust policy for the admin-app role + Cognito JWT. Magic string checks for the reserved IDs `cloud-data-server` (FOUNDATIONAL_APP_ID) and `starkeep-drive` (USER_DATA_OWNER_APP_ID) decide which permission boundary to attach. `attachTempInstallInfraPolicy` and `attachTempInstallDdlPolicy` add the temporary policies that Pulumi and the schema-init step need; both are detached after their phase completes.
- **DSQL (`src/dsql-ddl.ts`, `src/dsql-schema-init.ts`)** — `initializeSharedSchema()` creates the foundational tables (`shared_app_registry`, `shared_app_install_steps`, `shared_access_grants`, `shared_sync_log`, `shared_syncable_tables`, etc.). `runAppInstallDdl()` runs the app's `.sql` migrations and creates its declared syncable tables. Both run as `installerPgUser`, a temporary DSQL role with limited permissions that is deleted after install.
- **Pulumi (`src/compute-stack.ts`, `src/pulumi-program.ts`)** — `pulumiUpInline` runs Pulumi with an inline JSON program (no on-disk Pulumi project). For per-app installs the program is built from the manifest's infra requirements; for cloud-data-server it's the hardcoded program.
- **Session (`src/session.ts`)** — `roleChain()` chains STS AssumeRole hops from the caller's credentials through the manager role into the target role for each operation.
- **Retry (`src/retry-on-access-denied.ts`)** — Wraps AWS calls that may hit IAM eventual-consistency lag (policy attach → effective access can take seconds) and retries on `AccessDenied`.

## packages/admin-manifest

**Implied purpose.** Define and validate the contract that every starkeep app's `manifest.json` must satisfy. Provide types that downstream consumers (primarily `admin-installer`) can rely on without duplicating shape definitions.

**User-facing behavior.** Indirect — app developers write manifests that conform to these schemas. Validation failures surface to the operator as `ManifestValidationError` from the installer.

**Internal behavior.**

- **Schemas (`src/schemas/`)** — Zod schemas for the top-level `appManifest` and its parts: `appTier` (official / verified / community), `appTarget` (local / cloud), `fileAccess` (extension grants + rationale), `sharedResourceRequirement`, `appComputeHandler` (Lambda handler config), `syncableTable` / `syncableTableColumn` (DB schema definitions), `appSpecificSyncable` (syncable tables + reserved file storage opt-in), `infraRequirements` (everything an app declares it needs in cloud), `permissionEntry` (typed grants over types / collections / wildcards).
- **Reserved-permission flags** — `fileAccessAll` (every extension) is rejected unless the app's `id` is `starkeep-drive`; `brokerPower` (sts:AssumeRole into other roles) is rejected unless `id` is `cloud-data-server`. Both checks happen in `validateManifest` (`src/validate.ts:68-87`); the same magic-string IDs are also used in `admin-installer/iam.ts` to decide which permission boundary to attach.
- **Constraints** — extension strings are lowercase alphanumeric; syncable column names are snake_case and cannot be `updated_at` / `deleted_at` (reserved by sync runtime); column types restricted to `text`, `integer`, `real`, `blob`, `boolean`.
- **Validation (`src/validate.ts`)** — `validateManifest()` parses against the schema, applies the reserved-flag checks above, and returns either errors or a typed `AppManifest`.

## Cross-module behaviors

**Cloud setup, end-to-end.** The user opens admin-web → the Cloud Setup Wizard renders → admin-web calls `admin-core.generateBootstrapTemplate()` to produce a CloudFormation template + a console-launch URL → the user opens that URL in the AWS console and launches the bootstrap stack themselves (cross-account: the stack runs in *the user's* AWS account) → the user copies the stack outputs back into the wizard → admin-web persists them in `~/.starkeep/config.json` → the wizard creates a Cognito user via `cognito-auth.ts` → user signs in (id token + refresh token + identity-pool IAM creds land in localStorage) → admin-web triggers the cloud-data-server install. The install runs through `admin-installer.installCloudDataServer`, which initializes the shared DSQL schema and provisions the foundational resources via Pulumi.

**App install, end-to-end.** Operator clicks Install on the Apps page → admin-web's API route spawns a pnpm CLI subprocess: `pnpm --filter @starkeep/admin-installer cli:install-app <appId>` → admin-web passes Cognito-issued credentials (the operator's session, having assumed the `admin-app` IAM role in their AWS account) through to the subprocess → the CLI runs `admin-installer.installApp` with the manifest; `admin-manifest.validateManifest` runs first; on success the orchestrator state machine runs each step, recording ledger entries so a retry skips completed work → on success the app row is registered in DSQL and the running app is reachable through API Gateway.

**Config as single source of truth.** `~/.starkeep/config.json` is the only persistent local state admin-web owns. It holds bootstrap stack outputs, Cognito IDs, deployed stack names, the app-parent-dirs list, and the wizard's last-completed step. Region values are computed from `userPoolId` and never written. Sign-in artifacts live in localStorage, not the config file.

**Idempotency model.** Both cloud-side `installApp` and local-side `installLocal` use the same DSQL table `shared_app_install_steps` as a per-(app, run) ledger. Built-in installs (cloud-data-server, drive) bootstrap that table themselves and so use existence checks (does the role exist? is the policy attached?) for their own idempotency — the two patterns sit side-by-side in the package.

## Open questions

- **`KNOWN_EXTENSIONS` in admin-manifest** — the canonical list of file extensions that `fileAccess` entries can name appears to be inferred from `@starkeep/shared-space-api`. Whether there's a published list a manifest author can read, or whether validation rejection messages enumerate the valid set, isn't visible from this scope.

---

# Part 2 — Review and evaluation

> All review comments from the original draft were processed and fully resolved on 2026-06-01. Outcomes folded into the codebase (deletions of dead admin-providers and admin-shared packages, removal of vestigial `checkTypeConflicts` stub, corrected stale "admin-app Lambda" framing in `orchestrator.ts`) and into Part 1 above (admin-installer call-flow, admin-manifest validation accuracy). Two original findings turned out to be incorrect on re-reading the code (region-derivation already had explanatory comments; reserved-flag enforcement already happened at the manifest layer) and were dismissed with no action.

