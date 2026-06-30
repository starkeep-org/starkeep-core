# Starkeep — Data, Roles, & Permissions Overview

This document describes the system-level stance on roles, permissions, and trust boundaries in Starkeep's cloud deployment. It is intentionally high-level: it covers *who can do what, where the lines are drawn, and why* — but not the specific IAM actions, PG grants, or policy JSON. Those live in code and in the package-level READMEs.

---

## Two classes of user data

Starkeep operates on two classes of data: "Shared data" is your content (photos, documents, etc) and it's "shared" in the sense that it can be accessed and operated on by multiple apps. "App-specific data" is other app-bound data that is operated on by specific apps, but which is also synced through the Starkeep system. These They are owned by different parties, touched by different identities, and carry different attribution guarantees — so the trust model only makes sense once they are separated.

- **Shared data** is the *user's* content (photos, documents): typed against a platform-owned registry and stored in the single `shared.records` table plus the `shared/<category>/*` object-storage prefix. It is **cross-app and platform-owned** — multiple apps can hold grants on the same type, items outlive the uninstall of any app that touched them, and no app *owns* shared data. An app is a tenant with declared, narrow access: it reaches only the categories/types its manifest was granted.

- **App-specific data** is an *app's* own private state (a photo caption, a tag taxonomy, layout preferences): stored in the app's namespaced schema (`app_<appId>.*`) and filespace (`apps/<appId>/syncable/*`). It is **per-app and app-owned** — invisible to every other app, and torn down when the app is uninstalled at a location. It never interoperates across apps.

These are handled differently at the identity layer, and that difference is the source of most of the nuance below:

| | Shared data | App-specific data |
|---|---|---|
| **Owner** | the user (platform-managed) | the app |
| **Who may touch it** | any app with a grant on the type | only the owning app |
| **Runtime read/write identity** (per-request `/data/*`) | the **calling app's** per-app role, assumed per request by the broker | the **calling app's** per-app role |
| **Sync write identity** (cloud side) | the single **Starkeep Drive** (User-Data-Owner) role, on one always-on channel | the app's **own** per-app role, on the app's own channel — only while the app is cloud-installed |
| **Attribution of authorship** | IAM-enforced on the runtime path; on the sync path, carried by the immutable `origin_app_id` data attribute | IAM-enforced — the row lives in the app's own schema/prefix |
| **Survives uninstall** | yes | no (at that location) |

Two consequences are worth stating up front, because the principles below lean on them:

- **Shared data has two distinct cloud write paths with different identity models.** A direct, per-request write — an app POSTing a record on `/data/*` — runs under the *calling app's* per-app role and is therefore IAM-attributable to that app. Background **sync** of shared records instead flows through the single Starkeep Drive channel under `app-starkeep-drive-role`; there, per-app authorship is preserved as the immutable `origin_app_id` attribute (set once at local creation), *not* proven by the writing IAM principal. Routing all shared sync through one always-on Drive identity is deliberate: shared data always has an authorized cloud writer regardless of which apps happen to be installed, and a record's origin app need not be cloud-installed for its data to sync.

- **For shared data, the enforced property is *confinement to granted types*, not sole-identity ownership.** Because many apps legitimately operate on the same items, "one owner per byte" is not the guarantee. What the system guarantees is that an app can only read or write the types its manifest declares — checked before a sync write ever leaves the device (the local-data-server's `appCanWrite` check) and bounded again in the cloud by IAM (a per-app role's category-scoped grants on the runtime path; Drive's `shared/*` ceiling on the sync path). App-specific data, by contrast, *is* sole-identity owned: it lives in the app's own schema and prefix, reachable by no other role.

---

## Stance

Three principles drive every choice below.

1. **User data stays confined to the identities authorized for it.** A buggy or hostile app cannot reach data outside its grants — neither another app's app-specific data, nor shared types it was not granted — including via the human admin's own session. How this is *guaranteed* differs by data class (see above): app-specific data is sole-identity owned (it lives in the app's own schema/prefix, reachable only by the app's role), while shared data is **type-confined** at every layer, with authorship attributed by IAM on the runtime path and by the `origin_app_id` attribute on the sync path. This is the load-bearing security property; everything else exists to make it true.
2. **Powerful permissions are centralized, bounded, and ephemeral.** No identity holds standing power broader than what its job requires at steady state. Dangerous capabilities (DB admin, IAM mint, foundational provisioning) live on dedicated identities that the rest of the system delegates to for a specific purpose and short duration.
3. **Authorization is layered, as nested ceilings.** IAM, Postgres roles + GRANTs, and an application-layer check on the shared records table each constrain access, and any single layer being missed or bypassed is bounded by the next. They are deliberately *not* three copies of one rule: IAM S3 scoping and PG metadata-table GRANTs are **category-granular** (per `<category>`), while the application-layer check on `shared.records` is **type-granular** (per `<category>/<format>` id — the exact set the manifest declared). The coarser layers are the outer ceiling; the application layer makes the exact cut that DSQL's lack of row-level security would otherwise leave open.

A consequence of (1) and (2): the human admin user is not a superuser. The admin app facilitates deployment and install/uninstall; it has no standing access to *shared* user data. Its standing grants are limited to driving deployment (Cognito, assume Manager), reading the billing/cost-report bucket, its own `apps/admin/*` app-private prefix, and `dsql:DbConnect` — which maps it to the `${stackPrefix}_installer` Postgres role used to drive the app registry and install-step ledger, a role that holds no grants on `shared.records`. To touch app or shared data, work flows through a chain of role assumptions that each carries the originating app's identity.

---

## The foundational building blocks

These are the named identities and policies the rest of the system composes from. All are created once, by the bootstrap, and live for the lifetime of the deployment.

### Identities

- **Admin app role.** The federated entry point. The human user logs in via Cognito and assumes this role. It has the operational permissions needed to drive deployment and install/uninstall: talk to Cognito, assume Manager, read/write its own `apps/admin/*` files prefix, read the billing/cost-report bucket, manage the Pulumi state-encryption passphrase parameter, and `dsql:DbConnect` (mapping to the `${stackPrefix}_installer` Postgres role, which can reach the registry and install-step ledger but holds no grants on `shared.records`). It has **no** standing access to shared user data.
- **Manager role.** The delegation hub. Manager can mint and revoke per-app IAM roles (bounded by the per-app permissions boundary), attach and detach temporary policies on the dedicated install-time roles during install/uninstall, and assume into the per-app roles, the install-ddl role, and the install-infra role. Its only standing non-IAM capability is managing each app's HMAC credential: it writes (and at uninstall deletes) the per-app signing secret as an SSM SecureString under `/${stackPrefix}/app-creds/*` (write/delete only — Manager never *reads* the secret). It has no standing user-data-plane power: no S3, no DSQL connect, no Lambda, no API Gateway. Even during install, the wide provisioning policies are attached to *target* roles, never to Manager.
- **Install-DDL role.** The only identity in the system that can connect to DSQL as PG admin. It has no standing permissions; Manager attaches a small temporary policy granting DB admin around each install or uninstall and detaches it immediately after. This keeps the most dangerous database capability centralized on a single, IAM-bounded role that exists solely to run install/uninstall DDL. Apps being installed never receive DB admin, even briefly.
- **Install-Infra role.** The only identity that performs install-time AWS provisioning for per-app compute stacks (Lambda admin, log groups, API Gateway integrations/routes, Pulumi state writes, `iam:PassRole` to per-app roles). It has no standing permissions; Manager attaches a per-install temporary policy scoped to a single app's resources around each install or uninstall and detaches it immediately after. This keeps install-time AWS power centralized and ephemeral, so the per-app role's *permanent* ceiling never has to carry verbs it only needs for seconds.
- **Cloud-data-server role.** The runtime identity of the data broker (see below). Created by Manager during cloud-data-server deployment, bounded by the foundational permissions boundary (not the regular per-app one), and carries the broker capability of assuming any per-app role.
- **Per-app roles** (`...-app-<appId>-role`). One per installed app, minted by Manager at install time. Each is bounded by the per-app permissions boundary and tagged with its app id. The app's Lambda(s) run as this role. The cloud-data-server brokers data calls *as* this role by assuming it directly.
- **User-Data-Owner role.** The standing cloud-write identity for *all shared-record sync*, owned by the built-in **Starkeep Drive** app (IAM/app id `starkeep-drive`). It is **not** created at bootstrap: bootstrap reserves only its permissions *boundary* (a managed policy — no awkward empty-trust role), and the `starkeep-drive` app id is reserved in installer code so no third-party app can claim it. The role itself (`...-app-starkeep-drive-role`) is minted by `installDrive` with that boundary and a real trust policy naming the cloud-data-server role, mirroring how cloud-data-server's role is minted with the foundational boundary.

### Permissions boundaries

A permissions boundary is the *ceiling* on what an identity can do, regardless of what policies are attached to it. Starkeep uses five:

- **Per-app permissions boundary.** Caps every per-app role at exactly its *runtime* job. Scopes S3 to the app's own prefixes (driven by the role's `starkeep:appId` tag), permits reads/writes under the shared-data prefix, allows DSQL connect (not admin), and denies all IAM mutation. It does **not** carry install-time AWS verbs (Lambda/Logs/API Gateway admin, Pulumi state writes, PassRole) — those live on install-infra. This is what makes a compromised app, or a buggy temp policy, structurally unable to escape its lane *or* to perform infrastructure operations.
- **Foundational permissions boundary.** A wider ceiling used only by the cloud-data-server role. Permits the foundational provisioning actions (DSQL cluster admin, S3 bucket admin on the well-known files and billing bucket name patterns, the cost-and-usage-report (CUR) definition API, Lambda/API-Gateway admin scoped to cloud-data-server's own resources) that the regular per-app boundary intentionally forbids. A magic-string check in the installer routes only the cloud-data-server app id to this boundary, so a third-party app cannot opt into it.
- **User-Data-Owner permissions boundary.** A wider-than-per-app ceiling used only by the Starkeep Drive role (`starkeep-drive`). Permits `dsql:DbConnect` (not admin) and S3 read/write/list on the files bucket under the shared-data prefix (`shared/*`) — the layer-2 hard floor for shared-record custody — and nothing else: no Lambda/API Gateway, no per-app schema, no DSQL cluster admin, no IAM mutation. A magic-string check in the installer routes only the `starkeep-drive` app id to this boundary, so a third-party app cannot opt into the cross-cutting `shared/*` ceiling.
- **Install-DDL permissions boundary.** A very narrow ceiling for the install-ddl role: essentially DSQL admin connect plus a defense-in-depth deny on IAM mutations. The install-ddl role cannot do anything else, ever, by construction.
- **Install-Infra permissions boundary.** A narrow ceiling for the install-infra role: the AWS provisioning verbs needed to stand up and tear down a per-app compute stack (Lambda admin, log groups, API Gateway integrations/routes, Pulumi state I/O, PassRole onto per-app roles), plus a defense-in-depth deny on IAM mutations. Per-install scoping to a specific app id is enforced by the temp policy on top, not by the boundary.

### Supporting resources

- **Cognito user pool + identity pool.** Federated login; the identity pool is what maps a logged-in user to the admin-app role.
- **Pulumi state bucket.** Per-app infrastructure (Lambdas, API Gateway integrations, routes) is provisioned with Pulumi; state lives in a dedicated S3 bucket, encrypted with a passphrase stored as an SSM SecureString.
- **Artifacts bucket.** Holds each app's compiled Lambda bundle (`apps/<appId>/latest/dist.zip`); install-infra uploads here during install and clears the prefix on uninstall. Never holds user data.
- **Pulumi state-encryption passphrase (SSM SecureString).** Not created at bootstrap — CloudFormation cannot create SecureString parameters. The admin-installer mints it (create-if-missing, so it stays stable once any Pulumi state exists) on the first cloud-data-server install.
- **Billing/cost-report bucket.** Receives the AWS cost-and-usage report; provisioned as part of the cloud-data-server foundational install, not at bootstrap.

---

## The three setup phases

Starkeep stands up in three distinct phases. Each phase has a different security posture, and the boundaries above are what make the transitions safe.

### Phase 1 — Bootstrap (CloudFormation)

A single CloudFormation stack runs in the user's AWS account and creates: the Cognito pools, the admin-app role, the Manager role, the install-ddl role, the install-infra role, all five permissions boundaries (including the User-Data-Owner permissions boundary), the Pulumi state bucket, and the artifacts bucket. The Pulumi state-encryption passphrase is **not** created here — CloudFormation cannot create SecureString SSM parameters, so the admin-installer mints it (create-if-missing) on the first cloud-data-server install. The cloud-data-server's IAM role, the Starkeep Drive (User-Data-Owner) role, the billing bucket, and the data-plane resources do **not** exist yet — Drive's role is minted later by `installDrive`. The User-Data-Owner *boundary* exists after bootstrap; the *role* does not.

After this phase, the user can log in and assume the admin-app role. Nothing else in the system has any power, because nothing else exists.

### Phase 2 — Cloud-data-server deployment

The cloud-data-server is treated as a built-in app, but its permissions story is different from third-party apps in two important ways:

1. **Its capability ceiling is set upfront, in the bootstrap, as the foundational permissions boundary.** That boundary is what permits foundational provisioning (creating the DSQL cluster, the files bucket, the protocol-core Lambda, the API Gateway). It does not have to be invented or granted at deploy time.
2. **It does not bring its own manifest in the third-party sense.** It ships with starkeep-core and is deployed by the admin app using the installer plumbing — Manager mints `...-app-cloud-data-server-role` with the foundational boundary, attaches a temporary install policy (wider than per-app temp-install because foundational resources need to be created), runs the cloud-data-server's Pulumi program to create the DSQL cluster, the files bucket, the protocol-core Lambda function, and the shared API Gateway, then detaches the temp policy.

After this phase, the data plane exists. The cloud-data-server's runtime identity has the broker capability — it can assume any `...-app-*` role — but it has no direct access to shared data through its own credentials. Its standing policy is intentionally narrow.

### Phase 3 — App install (per app, repeatable)

Third-party (and additional first-party) apps install via the standard installer pipeline. Each install is an orchestrated sequence of idempotent steps; the orchestrator persists step status so a partial failure can be resumed. A key property of the sequence is that **the two install-time temp policies are never attached at the same time**: each is a tight bracket around exactly the step that needs it, attached just before and detached immediately after, so the wide grants exist for the minimum possible window.

1. **Mirror the signing credential.** Manager writes the app's HMAC signing secret to its SSM SecureString (`/${stackPrefix}/app-creds/<appId>`); the cloud-data-server verifier reads it to authenticate the app's signed requests.
2. **Mint.** Manager creates the app's per-app role with the per-app (runtime-only) permissions boundary and the `starkeep:appId` tag. From this moment on, every action attributed to the app at runtime is bounded by the per-app boundary. The role is not granted install-time AWS verbs even temporarily.
3. **DDL as install-ddl (DB-admin bracket).** Manager attaches a temp policy on the *install-ddl role* (DB admin), then a role chain (admin → Manager → install-ddl) connects to DSQL as PG admin and runs the per-app DDL: create the per-app PG role, create the app-private schema, grant the correct read/write/metadata permissions on shared tables based on what the app's manifest declares. Manager detaches the temp DDL policy as soon as the DDL completes — before any infrastructure provisioning begins. The app itself never holds DB admin. (One subtlety: `CREATE SCHEMA … AUTHORIZATION <app-pg-role>` requires the creating session to be able to `SET ROLE` to that target, so install-ddl runs `GRANT "<app-pg-role>" TO admin`. This makes admin a member *of* the app role, not the other way around — the app role gains no privileges from it, and only install-ddl can reach admin, so the membership is exercised only during install/uninstall. See the comment in `packages/admin-installer/src/dsql-ddl.ts` for the mechanics.)
4. **Seed the app's storage prefix.** Under the freshly minted per-app role (admin → Manager → app role), the orchestrator writes the `apps/<appId>/.keep` marker — exercising the per-app role's own narrow runtime grants, with no temp policy attached.
5. **Provision as install-infra (infra bracket).** For apps with compute, Manager attaches a temp policy on the *install-infra role* (scoped to this app's Lambda name pattern, its log groups, its Pulumi state file, the artifacts-bucket prefix, and `PassRole` onto its own per-app role). A role chain (admin → Manager → install-infra) uploads the app bundle and runs the app's Pulumi program to create its Lambda(s), log group(s), API Gateway integrations, and routes; the program passes the per-app role to Lambda as the function's execution role. Manager detaches the temp infra policy when provisioning completes. (Compute-less apps — e.g. Starkeep Drive — skip this stage entirely.)
6. **Register.** The app is recorded in the registry along with its access grants. Both install-time roles are back to zero standing permissions; the per-app role retains only its narrow runtime policy.

Uninstall is the symmetric flow, again bracketing each temp policy tightly: Manager attaches a temp uninstall policy on install-infra and runs Pulumi destroy as install-infra, then detaches it; files-bucket prefixes are cleared under the app's own role; Manager attaches a temp DDL policy on install-ddl, revokes grants and drops the PG role and schema as install-ddl, then detaches it; the registry entry is removed; the per-app IAM role is deleted; and the app's SSM signing credential is deleted. Shared records persist for other apps that still have grants.

---

## How data access actually flows at runtime

Once an app is installed, an end-user request that needs to touch shared data flows like this:

1. The client calls the shared API Gateway with a Cognito JWT (identifies the user) and an app identification on the request (path or header, identifies the app).
2. The cloud-data-server Lambda authorizes the user via the JWT authorizer, identifies the calling app, and assumes the per-app role directly for the duration of the request (`...-app-<callerAppId>-role`). The per-app role's trust policy names the cloud-data-server role as a principal, so this is a single hop with no Manager in the chain.
3. Under those assumed credentials, the cloud-data-server builds the DSQL and S3 adapters and runs the data operation. DSQL maps the assumed IAM identity to the per-app PG role; S3 calls are bounded by the per-app permissions boundary to the app's allowed prefixes.

Two consequences are worth calling out:

- **Cloud-data-server is a broker, not a data owner.** Its own credentials never read or write shared data. On the **runtime per-request data path** (reads/writes on `/data/*`), every shared byte is attributable to the per-app role that the broker assumed for that specific request. (The **sync path** is different — see below.)
- **Application-layer enforcement is required for per-type filtering.** All shared records live in a single table (DSQL has no row-level security), so the protocol-core layer reads the caller's grants and applies type-level filters on reads and writes before any query is issued. This is the type-granular cut that the coarser layers leave open: PG GRANTs and the per-app S3 ceiling are category-granular; the application layer handles per-type-in-`shared.records` access.

The same single-hop assume serves **app-specific** runtime operations, but those target the app's *own* schema (`app_<appId>.*`) and filespace (`apps/<appId>/syncable/*`) rather than `shared.*`. No cross-app visibility arises, and no application-layer type filter is needed — the per-app PG role and permissions boundary already make the app's own namespace the only thing it can reach.

Shared-record **sync** does **not** re-assume per-app roles. It flows through the single always-on **Starkeep Drive (User-Data-Owner)** channel: the local-data-server runs one Drive sync engine that ships all shared records, and the cloud-data-server serves that channel under `app-starkeep-drive-role`. Shared writes are therefore **type-confined locally by the originating app's grants before ship** (the local `appCanWrite` check, layer 1) and **bounded in the cloud by Drive's IAM grant** on `shared/*` (layer 2); origin attribution is preserved immutably in `origin_app_id`. There is no per-record role re-assumption and no "origin app uninstalled → rejected" path: a record's origin app need not be cloud-installed for its shared data to sync (that is the whole point of routing shared sync through Drive). Per-app channels carry only that app's *app-specific* rows and matter only when the app is cloud-installed.

---

## The local data server

The local data server runs outside AWS and holds no AWS credentials. It mediates the local SDK's access to local SQLite + filesystem using the same SDK code paths the cloud uses, so a manifest grant that's wrong (or missing) produces the same denial in dev as in production. It also runs the **layer-1** per-app type check (`appCanWrite` against the local grants) *before* any record is handed to a sync channel — so a record an app may not write never reaches the cloud in the first place, fully offline.

For shared data, the local server's only cloud interaction is the **Starkeep Drive channel**, which authenticates as `starkeep-drive`. There is no per-record role re-assumption on the cloud side: the cloud-side write identity for shared data is **always Drive**. The local server still holds no AWS credentials — it talks to the shared API as the Drive channel, and the cloud-data-server assumes `app-starkeep-drive-role` to perform the write, bounded by Drive's IAM grant (layer 2).

---

## Why this layout, in one paragraph

The admin user, the platform, and the apps each get exactly the power their job requires and no more. The three most dangerous install-time capabilities — minting IAM roles, connecting to DSQL as DB admin, and provisioning per-app AWS compute infrastructure — are isolated on three different dedicated identities (Manager, install-ddl, install-infra) that have no other powers and are reached only through role chaining. The per-app role's permanent ceiling matches its runtime job exactly, with no install-time verbs sitting on it for the lifetime of the app. The data broker (cloud-data-server) never holds shared-data permissions of its own; it borrows them per-request from the originating app via a direct, single-hop assume. The permissions boundary system means that even if a temp policy has a bug, no role can exceed the ceiling set at bootstrap. And the same SDK code paths run locally and in the cloud, so authorization mistakes surface in the same shape at dev time as in production.
