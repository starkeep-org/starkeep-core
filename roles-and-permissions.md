# Starkeep — Roles & Permissions Overview

This document describes the system-level stance on roles, permissions, and trust boundaries in Starkeep's cloud deployment. It is intentionally high-level: it covers *who can do what, where the lines are drawn, and why* — but not the specific IAM actions, PG grants, or policy JSON. Those live in code and in the package-level READMEs.

---

## Stance

Three principles drive every choice below.

1. **Every byte of user data is attributable to exactly one app identity.** A buggy or hostile app cannot read or corrupt another app's records — including via the human admin's own session. This is the load-bearing security property; everything else exists to make it true.

   *Scoped caveat for shared data.* This holds verbatim for **app-private** data. For **shared** data, the *write identity* in the cloud is the single User-Data-Owner (Starkeep Drive) identity, not the originating app: all shared-record sync flows through Drive's one always-on channel. Per-app authorship is still preserved, but as an **immutable `origin_app_id` data attribute** (set once at local creation) rather than proven by the writing IAM principal — i.e. for shared data, authorship is *self-asserted in `origin_app_id`*, not identity-enforced. Per-app type confinement for shared writes is enforced **locally before sync** (the local-data-server's `appCanWrite` check, layer 1) and **bounded in the cloud** by Drive's IAM grant on `shared/*` (layer 2). See the data-flow section and "the local data server" below.
2. **Powerful permissions are centralized, bounded, and ephemeral.** No identity holds standing data-plane power broader than what its job requires at steady state. Dangerous capabilities (DB admin, IAM mint, foundational provisioning) live on dedicated identities that the rest of the system delegates to for a specific purpose and short duration.
3. **Authorization is layered.** IAM, Postgres roles + GRANTs, and an application-layer check on the shared records table all enforce the same rules. Any single layer being missed or bypassed is bounded by the next.

A consequence of (1) and (2): the human admin user is not a superuser. The admin app facilitates deployment and install/uninstall; it does not see user data. To touch data, work flows through a chain of role assumptions that each carries the originating app's identity.

---

## The foundational building blocks

These are the named identities and policies the rest of the system composes from. All are created once, by the bootstrap, and live for the lifetime of the deployment.

### Identities

- **Admin app role.** The federated entry point. The human user logs in via Cognito and assumes this role. It has the operational permissions needed to drive deployment and install/uninstall (talk to Cognito, kick off the cloud-data-server deploy, assume Manager). It has **no** standing access to shared user data.
- **Manager role.** The delegation hub. Manager can mint and revoke per-app IAM roles (bounded by the per-app permissions boundary), attach and detach temporary policies on the dedicated install-time roles during install/uninstall, and assume into the per-app roles, the install-ddl role, and the install-infra role. Manager itself has **zero** standing data-plane power: no S3, no DSQL connect, no Lambda, no API Gateway. Even during install, the wide policies are attached to *target* roles, never to Manager.
- **Install-DDL role.** The only identity in the system that can connect to DSQL as PG admin. It has no standing permissions; Manager attaches a small temporary policy granting DB admin around each install or uninstall and detaches it immediately after. This keeps the most dangerous database capability centralized on a single, IAM-bounded role that exists solely to run install/uninstall DDL. Apps being installed never receive DB admin, even briefly.
- **Install-Infra role.** The only identity that performs install-time AWS provisioning for per-app compute stacks (Lambda admin, log groups, API Gateway integrations/routes, Pulumi state writes, `iam:PassRole` to per-app roles). It has no standing permissions; Manager attaches a per-install temporary policy scoped to a single app's resources around each install or uninstall and detaches it immediately after. This keeps install-time AWS power centralized and ephemeral, so the per-app role's *permanent* ceiling never has to carry verbs it only needs for seconds.
- **Cloud-data-server role.** The runtime identity of the data broker (see below). Created by Manager during cloud-data-server deployment, bounded by the foundational permissions boundary (not the regular per-app one), and carries the broker capability of assuming any per-app role.
- **Per-app roles** (`...-app-<appId>-role`). One per installed app, minted by Manager at install time. Each is bounded by the per-app permissions boundary and tagged with its app id. The app's Lambda(s) run as this role. The cloud-data-server brokers data calls *as* this role by assuming it directly.
- **User-Data-Owner role.** The standing cloud-write identity for *all shared-record sync*, owned by the built-in **Starkeep Drive** app (IAM/app id `starkeep-drive`). It is **not** created at bootstrap: bootstrap reserves only its permissions *boundary* (a managed policy — no awkward empty-trust role), and the `starkeep-drive` app id is reserved in installer code so no third-party app can claim it. The role itself (`...-app-starkeep-drive-role`) is minted by `installDrive` with that boundary and a real trust policy naming the cloud-data-server role, mirroring how cloud-data-server's role is minted with the foundational boundary.

### Permissions boundaries

A permissions boundary is the *ceiling* on what an identity can do, regardless of what policies are attached to it. Starkeep uses five:

- **Per-app permissions boundary.** Caps every per-app role at exactly its *runtime* job. Scopes S3 to the app's own prefixes (driven by the role's `starkeep:appId` tag), permits reads/writes under the shared-data prefix, allows DSQL connect (not admin), and denies all IAM mutation. It does **not** carry install-time AWS verbs (Lambda/Logs/API Gateway admin, Pulumi state writes, PassRole) — those live on install-infra. This is what makes a compromised app, or a buggy temp policy, structurally unable to escape its lane *or* to perform infrastructure operations.
- **Foundational permissions boundary.** A wider ceiling used only by the cloud-data-server role. Permits the foundational provisioning actions (DSQL cluster admin, S3 bucket admin on the well-known bucket name patterns, Lambda/API-Gateway admin scoped to cloud-data-server's own resources) that the regular per-app boundary intentionally forbids. A magic-string check in the installer routes only the cloud-data-server app id to this boundary, so a third-party app cannot opt into it.
- **User-Data-Owner permissions boundary.** A wider-than-per-app ceiling used only by the Starkeep Drive role (`starkeep-drive`). Permits `dsql:DbConnect` (not admin) and S3 read/write/list on the files bucket under the shared-data prefix (`shared/*`) — the layer-2 hard floor for shared-record custody — and nothing else: no Lambda/API Gateway, no per-app schema, no DSQL cluster admin, no IAM mutation. A magic-string check in the installer routes only the `starkeep-drive` app id to this boundary, so a third-party app cannot opt into the cross-cutting `shared/*` ceiling.
- **Install-DDL permissions boundary.** A very narrow ceiling for the install-ddl role: essentially DSQL admin connect plus a defense-in-depth deny on IAM mutations. The install-ddl role cannot do anything else, ever, by construction.
- **Install-Infra permissions boundary.** A narrow ceiling for the install-infra role: the AWS provisioning verbs needed to stand up and tear down a per-app compute stack (Lambda admin, log groups, API Gateway integrations/routes, Pulumi state I/O, PassRole onto per-app roles), plus a defense-in-depth deny on IAM mutations. Per-install scoping to a specific app id is enforced by the temp policy on top, not by the boundary.

### Supporting resources

- **Cognito user pool + identity pool.** Federated login; the identity pool is what maps a logged-in user to the admin-app role.
- **Pulumi state bucket + SSM passphrase.** Per-app infrastructure (Lambdas, API Gateway integrations, routes) is provisioned with Pulumi; state lives in a dedicated S3 bucket encrypted with a passphrase stored in SSM.

---

## The three setup phases

Starkeep stands up in three distinct phases. Each phase has a different security posture, and the boundaries above are what make the transitions safe.

### Phase 1 — Bootstrap (CloudFormation)

A single CloudFormation stack runs in the user's AWS account and creates everything in the previous section: the Cognito pools, the admin-app role, the Manager role, the install-ddl role, the install-infra role, all five permissions boundaries (including the User-Data-Owner permissions boundary), the Pulumi state bucket, and the SSM passphrase. The cloud-data-server's IAM role, the Starkeep Drive (User-Data-Owner) role, and the data-plane resources do **not** exist yet — Drive's role is minted later by `installDrive`. The User-Data-Owner *boundary* exists after bootstrap; the *role* does not.

After this phase, the user can log in and assume the admin-app role. Nothing else in the system has any power, because nothing else exists.

### Phase 2 — Cloud-data-server deployment

The cloud-data-server is treated as a built-in app, but its permissions story is different from third-party apps in two important ways:

1. **Its capability ceiling is set upfront, in the bootstrap, as the foundational permissions boundary.** That boundary is what permits foundational provisioning (creating the DSQL cluster, the files bucket, the protocol-core Lambda, the API Gateway). It does not have to be invented or granted at deploy time.
2. **It does not bring its own manifest in the third-party sense.** It ships with starkeep-core and is deployed by the admin app using the installer plumbing — Manager mints `...-app-cloud-data-server-role` with the foundational boundary, attaches a temporary install policy (wider than per-app temp-install because foundational resources need to be created), runs the cloud-data-server's Pulumi program to create the DSQL cluster, the files bucket, the protocol-core Lambda function, and the shared API Gateway, then detaches the temp policy.

After this phase, the data plane exists. The cloud-data-server's runtime identity has the broker capability — it can assume any `...-app-*` role — but it has no direct access to shared data through its own credentials. Its standing policy is intentionally narrow.

### Phase 3 — App install (per app, repeatable)

Third-party (and additional first-party) apps install via the standard installer pipeline. Each install is an orchestrated sequence with five conceptual stages; the orchestrator persists step status so a partial failure can be resumed.

1. **Mint.** Manager creates the app's per-app role with the per-app (runtime-only) permissions boundary and the `starkeep:appId` tag. From this moment on, every action attributed to the app at runtime is bounded by the per-app boundary. The role is not granted install-time AWS verbs even temporarily.
2. **Grant temporarily.** Manager attaches two temp policies, both on dedicated install-time roles (never on the app's own role): one on the *install-ddl role* (DB admin, just for the duration of DDL), and one on the *install-infra role* (scoped to this app's Lambda name pattern, its log groups, its Pulumi state file, and `PassRole` onto its own per-app role).
3. **DDL as install-ddl, with the right grants for this app.** A role chain (admin → Manager → install-ddl) connects to DSQL as PG admin and runs the per-app DDL: create the per-app PG role, create the app-private schema, grant the correct read/write/metadata permissions on shared tables based on what the app's manifest declares. The app itself never holds DB admin.
4. **Provision as install-infra.** A role chain (admin → Manager → install-infra) runs the app's Pulumi program to create its Lambda(s), log group(s), API Gateway integrations, and routes. Install-infra's temp policy scopes the run to exactly this app id, and the program passes the freshly minted per-app role to Lambda as the function's execution role. Install-time AWS power is exercised by the install-infra identity and only for the duration of this step.
5. **Detach and register.** Manager detaches both temp policies. The install-ddl and install-infra roles return to having no standing permissions; the per-app role retains only its narrow runtime policy. The app is recorded in the registry along with its access grants.

Uninstall is the symmetric flow: Manager attaches a temp uninstall policy on install-infra and a temp DDL policy on install-ddl; Pulumi destroy runs as install-infra; DDL revokes and drops the PG role and schema as install-ddl; S3 prefixes are cleared; temp policies are detached; the per-app IAM role is deleted; the registry entry is removed. Shared records persist for other apps that still have grants.

---

## How data access actually flows at runtime

Once an app is installed, an end-user request that needs to touch shared data flows like this:

1. The client calls the shared API Gateway with a Cognito JWT (identifies the user) and an app identification on the request (path or header, identifies the app).
2. The cloud-data-server Lambda authorizes the user via the JWT authorizer, identifies the calling app, and assumes the per-app role directly for the duration of the request (`...-app-<callerAppId>-role`). The per-app role's trust policy names the cloud-data-server role as a principal, so this is a single hop with no Manager in the chain.
3. Under those assumed credentials, the cloud-data-server builds the DSQL and S3 adapters and runs the data operation. DSQL maps the assumed IAM identity to the per-app PG role; S3 calls are bounded by the per-app permissions boundary to the app's allowed prefixes.

Two consequences are worth calling out:

- **Cloud-data-server is a broker, not a data owner.** Its own credentials never read or write shared data. On the **runtime per-request data path** (reads/writes on `/data/*`), every shared byte is attributable to the per-app role that the broker assumed for that specific request. (The **sync path** is different — see below.)
- **Application-layer enforcement is required for per-type filtering.** All shared records live in a single table (DSQL has no row-level security), so the protocol-core layer reads the caller's grants and applies type-level filters on reads and writes before any query is issued. PG GRANTs handle per-metadata-table access; the application layer handles per-type-in-`shared.records` access.

Shared-record **sync** does **not** re-assume per-app roles. It flows through the single always-on **Starkeep Drive (User-Data-Owner)** channel: the local-data-server runs one Drive sync engine that ships all shared records, and the cloud-data-server serves that channel under `app-starkeep-drive-role`. Shared writes are therefore **type-confined locally by the originating app's grants before ship** (the local `appCanWrite` check, layer 1) and **bounded in the cloud by Drive's IAM grant** on `shared/*` (layer 2); origin attribution is preserved immutably in `origin_app_id`. There is no per-record role re-assumption and no "origin app uninstalled → rejected" path: a record's origin app need not be cloud-installed for its shared data to sync (that is the whole point of routing shared sync through Drive). Per-app channels carry only that app's *app-specific* rows and matter only when the app is cloud-installed.

---

## The local data server

The local data server runs outside AWS and holds no AWS credentials. It mediates the local SDK's access to local SQLite + filesystem using the same SDK code paths the cloud uses, so a manifest grant that's wrong (or missing) produces the same denial in dev as in production. It also runs the **layer-1** per-app type check (`appCanWrite` against the local grants) *before* any record is handed to a sync channel — so a record an app may not write never reaches the cloud in the first place, fully offline.

For shared data, the local server's only cloud interaction is the **Starkeep Drive channel**, which authenticates as `starkeep-drive`. There is no per-record role re-assumption on the cloud side: the cloud-side write identity for shared data is **always Drive**. The local server still holds no AWS credentials — it talks to the shared API as the Drive channel, and the cloud-data-server assumes `app-starkeep-drive-role` to perform the write, bounded by Drive's IAM grant (layer 2).

---

## Why this layout, in one paragraph

The admin user, the platform, and the apps each get exactly the power their job requires and no more. The three most dangerous install-time capabilities — minting IAM roles, connecting to DSQL as DB admin, and provisioning per-app AWS compute infrastructure — are isolated on three different dedicated identities (Manager, install-ddl, install-infra) that have no other powers and are reached only through role chaining. The per-app role's permanent ceiling matches its runtime job exactly, with no install-time verbs sitting on it for the lifetime of the app. The data broker (cloud-data-server) never holds shared-data permissions of its own; it borrows them per-request from the originating app via a direct, single-hop assume. The permissions boundary system means that even if a temp policy has a bug, no role can exceed the ceiling set at bootstrap. And the same SDK code paths run locally and in the cloud, so authorization mistakes surface in the same shape at dev time as in production.
