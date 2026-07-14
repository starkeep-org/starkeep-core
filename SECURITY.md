# Starkeep cloud — Threat Model & Security Assessment (2026-06-30)

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/starkeep-org/starkeep-core/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within a few days. Starkeep is pre-production and
maintained by a small team, so please allow reasonable time for a fix before
public disclosure.

The threat model below is a deliberately candid account of the current posture,
including what is *not* yet mitigated. A report that restates a limitation
already documented here is useful to us as prioritization signal, but is not
treated as a vulnerability report.

## Project status

Starkeep is pre-production software.

---

## Security assessment overview

> **Scope.** The cloud-side security posture only: the cloud data server
> (broker, DSQL, files bucket, API Gateway), cloud apps and their install /
> uninstall lifecycle, Cognito + IAM bootstrap, and the cloud sync path. The
> local data server, the local app surface, and the on-device sync engine are
> **out of scope** except where they meet the cloud (the Drive channel, the
> shared HMAC secret). Drawn from `starkeep-core` and the `starkeep-apps/photos`
> sample app.
>
> **Verified against code, not just docs.** Source refs: `starkeep-core @
> 2a2c23d`, `starkeep-apps @ 5061ec4`. The assessments below describe the live
> code: the gateway places no Cognito JWT authorizer on the reserved data-plane
> routes (HMAC is the sole identity check there), and the HMAC signature binds
> method, path, and a timestamp.
>
> **How to read the assessments.** Each threat carries an honest posture label:
> **Strong** (defended in depth, no material residual risk in the single-account
> model), **Adequate** (defended, with bounded residual risk worth knowing),
> **Partial** (real protection but with a named gap), **Deferred by design**
> (deliberately deferred as not-yet-needed at the current scale), or **Out of
> scope / accepted** (the design accepts this and says so). The goal is to
> describe reality, not to flatter it.

---

# Part 1 — Framing

## The single-account trust boundary

Starkeep is **single-account, single-tenant**. The entire deployment lives in
the customer's own AWS account; there is no Starkeep SaaS control plane, no
cross-account assume role, and no IAM user. The customer's AWS account *is* the
outer trust boundary: anyone with account-root or sufficient IAM-console power
in that account is outside the model's protection and can read everything. The
threat models below all assume the account itself is intact and reason about
what can go wrong *inside* it — a misbehaving app, a forged request, an exposed
endpoint — not about an attacker who already owns the account.

## The managed-runtime stance (no servers to patch, no network to isolate)

Self-hosters reasonably expect to put a service behind a VPC, Tailscale, or a
similar network-isolation layer. That is the standard mitigation when the thing
you run is a long-lived server whose OS and language runtime *you* must patch,
and where an unpatched zero-day in that stack is a real path in. Starkeep's cloud
deliberately does not have that shape, so it draws the boundary differently.

Starkeep runs **only on AWS-managed serverless primitives** — Lambda (broker and
app handlers), Aurora DSQL, S3, API Gateway, Cognito. It runs **no EC2, no
self-operated containers, and no long-lived servers of any kind**. Under the AWS shared-responsibility model, AWS is responsible for the entire
infrastructure-and-runtime layer. The Lambda execution environment is built
and continuously re-patched by AWS, and DSQL's host, storage, and network
security are AWS-operated, providing the same security guarantees that large enterprise companies rely on. There is consequently no operating system for Starkeep
(or its customer) to patch, no SSH surface, and no listening daemon reachable
outside the managed gateway — and therefore no "unpatched runtime/OS zero-day"
attack path of the kind VPC/Tailscale exists to mitigate.

What this stance does **not** outsource is Starkeep's own platform code — the
broker, the access enforcer, the HMAC verifier, the install lifecycle, and the
IAM/permission design. That is precisely the surface the rest of this document
assesses (T1–T8, T11). The division is clean: AWS owns the security of the
infrastructure and runtime *under* the code; Starkeep owns the security of the
code and its authorization model *on top* of it. Choosing serverless over
EC2-style servers is itself a security decision — it trades away a large,
self-managed attack surface (a patchable OS and an internet-reachable host) for a
small one (request-scoped functions behind a managed gateway). This is why the
threats below reason about forged requests, app confinement, and grant scope
rather than about host hardening or a network perimeter: by design there is no
host to harden and no perimeter to draw.

## Assets worth protecting

- **Shared user data** — the user's photos/documents in `shared.records` + the
  `shared/<category>/*` S3 prefix. Cross-app, platform-owned, outlives any app.
- **App-specific data** — each app's private rows (`app_<id>.*`) and files
  (`apps/<appId>/syncable/*`). Sole-owned by the app.
- **The AWS account / infrastructure** — the ability to mint IAM roles, connect
  to DSQL as admin, or provision compute. Far more dangerous than any single
  data item if subverted.
- **The admin identity** — the Cognito login that bootstraps everything.
- **Platform secrets** — per-app HMAC secrets, the Pulumi state-encryption
  passphrase.

## Actors

| Actor | Trust | Can hold |
|---|---|---|
| Human admin | trusted operator | Cognito login → admin-app role (no standing data-plane power) |
| Installed app | **partially trusted tenant** | one per-app IAM role + PG role + HMAC secret, capped to its manifest |
| Internet caller | untrusted | the public API Gateway hostname; presigned-URL holders |
| Starkeep Drive | trusted built-in | the only `shared/*` cloud writer (User-Data-Owner) |
| Broker (cloud-data-server) | trusted-but-bounded | assume-any-app-role; no standing data permissions |

The load-bearing security property, per `data-roles-and-permissions.md`, is
**(1) user data stays confined to the identities authorized for it**, supported
by **(2) powerful permissions are centralized, bounded, and ephemeral** and
**(3) authorization is layered as nested ceilings**. The threats below are
organized as "what would have to break for property (1) to fail," plus the
infrastructure and availability threats that sit around it.

---

# Part 2 — Threat models

## T1 — A malicious or buggy installed app

**Threat.** An app, once installed, runs arbitrary code in its Lambda under its
own IAM role. It tries to read or write data outside its declared grants — other
apps' app-specific data, shared types it wasn't granted, or the AWS
infrastructure itself.

**Stance.** This is the threat the architecture is built around, and it is
defended in **four independent layers**, each set by a distinct install step and
each constraining a different surface:

1. **Permissions boundary** — every per-app role is born under the *per-app*
   boundary (`createAppRole`), which scopes S3 to the app's own prefixes (driven
   by the `starkeep:appId` principal tag), permits `dsql:DbConnect` (never
   `DbConnectAdmin`), and **denies all IAM mutation**. The boundary is a hard
   ceiling: a future inline-policy bug cannot exceed it. An app cannot opt into
   the wider *foundational* or *User-Data-Owner* boundary — magic-string checks
   route only `cloud-data-server` and `starkeep-drive` to those, and the
   manifest validator refuses `fileAccessAll`/`brokerPower` on any other id.
2. **DSQL IAM-to-PG mapping + PG GRANTs** — the app's PG role owns only its own
   `app_<id>` schema and gets category-granular GRANTs on `shared.records` /
   `shared.record_<category>_metadata`. No mapping row → `DbConnect` fails
   `FATAL 28000` regardless of IAM.
3. **S3 bucket policy** — denies cross-app prefix access via a
   `${aws:PrincipalTag/starkeep:appId}` expansion, independent of IAM.
4. **Application-layer type check** — because DSQL has **no row-level security**
   and `shared.records` is one flat table, the broker reads the caller's
   `shared.access_grants` rows per request and gates every read/write through
   `canRead`/`canWrite`/`canReadCategory`/`canWriteCategory`
   (`access-enforcer.ts`). This is the *type-granular* cut (per
   `<category>/<format>`) that the coarser category-granular layers above leave
   open.

The net property: **what an app can do in the cloud is exactly what its manifest
declared.** It cannot widen grants at runtime, reach another app's prefix or
schema, or perform any infrastructure operation (the per-app boundary carries no
Lambda/API-Gateway/PassRole verbs at all).

**Assessment — Strong.** Defense in depth is real here and the layers are not
redundant copies (IAM/PG are category-granular; the app layer is type-granular).
Two honest caveats:

- **A grant is a grant.** Confinement protects against escaping the manifest, not
  against the manifest itself. An app granted `readwrite` on `image/*` can read
  and *overwrite or tombstone* every user image any app ever wrote — that is the
  intended shared-data model, not a bug, but it means **the install-time grant
  decision is the actual security boundary for shared data**, and there is no
  per-item or per-origin-app restriction once the grant is held. The human admin
  is the only review gate (see T8).
- **The app-layer check is load-bearing because DSQL has no RLS.** If a future
  `shared.records` code path forgot to call the enforcer, layers 1–3 would *not*
  catch a same-category-but-wrong-type access (they're category-granular). The
  single shared module (`protocol-primitives/access`) used both locally and in
  the cloud mitigates this, but it remains the thinnest layer.

## T2 — App-identity forgery and request replay

**Threat.** A caller forges or replays a request to act as an app it is not, or
replays a captured legitimate request.

**Stance.** Every `/apps/{appId}/*` request is **HMAC-SHA256 signed** with the
per-app secret and verified by the broker before any STS-assume, DSQL, or S3
work (`validateAppHmac`, `api-handler.ts`). The verifier:

- Requires `X-Starkeep-App-{Id,Sig,Ts}` headers; **the header app id must equal
  the app id in the URL path** — so a caller holding app A's secret cannot drive
  app B's routes.
- **Binds method, canonical path, and a timestamp** into the signed string
  (`${appId}:${METHOD}:${canonicalPath}:${tsMs}:` ++ body), and rejects a
  timestamp outside a **±5-minute** freshness window (`APP_SIG_MAX_SKEW_MS`).
- Compares with `timingSafeEqual`.
- Loads the secret from SSM SecureString (`/${prefix}/app-creds/${appId}`),
  decryptable only via a KMS grant gated on `kms:ViaService=ssm.*`.

Forgery requires the secret; cross-endpoint replay is blocked by the
method/path binding; indefinite replay is blocked by the freshness window.

**Assessment — Adequate.** The remaining residual risks are real but bounded:

- **Within-window replay.** There is no nonce or once-use enforcement, so a
  captured request can be replayed for up to ±5 minutes. Over TLS to the same
  endpoint this is a narrow window, but it is not zero.
- **The secret is widely distributed and symmetric.** The same per-app secret
  lives in cloud SSM, the local creds file (`~/.starkeep/app-creds/${appId}.json`),
  the local registry's `hmac_secret` column, and is fetched into the app's own
  Lambda env at runtime. Anyone who can read any of those copies can impersonate
  the app.
- **No in-place rotation** (todo 27) and **no cache invalidation on
  uninstall/reinstall**: the broker caches each secret for 5 minutes
  (`hmacSecretCache`), so a quick reinstall that flips the SSM value leaves warm
  Lambdas accepting the old secret until the cache expires (todo 16).

## T3 — Cross-app data access (isolation)

**Threat.** App A reaches app B's *app-specific* data, or reads/writes shared
data it has no grant for.

**Stance.** App-specific data is **sole-identity owned**: it lives in
`app_<id>.*` (reachable only by the app's PG role) and `apps/<appId>/syncable/*`
(capped by the per-app boundary + bucket policy + the broker's app-id gating on
every route). No other app — not even Drive or the broker's own credentials —
can see it. The object-key builder additionally rejects path traversal (`..`)
and slashes in the app id (`object-keys.ts`), and `parseObjectKey` rejects
`apps/<other-app>/...` keys before any AWS call. Cross-app shared reads *are*
allowed — but only when the *reader's* grants cover the type, which is the
intended shared-data design, not a leak.

**Assessment — Strong** for app-specific isolation (three enforcement layers,
none of which the app controls). For shared data, "isolation" is intentionally
weaker by design — see the T1 caveat: shared data is type-confined, not
app-private.

## T4 — Unauthenticated internet caller

**Threat.** Anyone on the internet hits the public API Gateway, a `public` app
route, or a presigned URL.

**Stance & honest reality.**

- **Reserved data-plane routes** (`/apps/{appId}/{data,files,sync,app-data}/*`
  and `/apps/{appId}/health`) carry **no gateway authorizer** — the HMAC
  verifier (T2) is the sole identity check. Without a valid signature these
  routes 401 before doing any work. `GET /health` and `OPTIONS /{proxy+}` are
  intentionally unauthenticated liveness/CORS probes.
- **Per-app routes** declare `auth: "jwt"` (wired to the gateway's Cognito JWT
  authorizer — authenticates the human at the edge) or `auth: "public"` (no
  authorizer; unauthenticated traffic reaches the Lambda). The Photos `static`
  handler uses `public` to serve the web UI.
- **Presigned URLs** let browsers/local server hit S3 directly (bypassing the
  gateway body limit). They are time-bound but **bearer**: anyone with the URL
  can use it within its validity.
- The files bucket has a **permissive CORS configuration** to make
  browser-direct presigned uploads work.
- There is intentionally no VPC/Tailscale-style network-isolation layer in
  front of any of this. Without a
  self-managed host or runtime behind the gateway to shield, the perimeter
  self-hosters build with those tools has no analogue here: the managed gateway
  plus the HMAC/JWT identity checks *are* the boundary. The
  unpatched-runtime/OS attack path those tools guard against does not exist in
  this architecture.

**Assessment — Adequate, with named gaps.**

- A `public` route is a deliberate hole the *app* opens; the platform's job ends
  at "the route reaches the Lambda unauthenticated, as declared." An app that
  puts data-touching logic on a `public` route without its own auth is a real
  risk, but it is the app author's responsibility, not the platform's.
- **Gateway throttle + Lambda reserved concurrency bound volumetric abuse:** a
  stage-wide request throttle caps the rate reaching the Lambda across all
  routes, and reserved concurrency caps worst-case spend. There is no
  per-app/per-route quota or WAF — unauthenticated routes (`/health`,
  `public` app routes) and the HMAC-gated routes (which still do an SSM read +
  signature check per request before 401) remain reachable, but the cost blast
  radius is capped → see T10.
- Permissive CORS on the files bucket is a pragmatic necessity for the
  presigned-upload model; it does not by itself grant access (the presigned URL
  or IAM still gates the operation), but it widens the browser-reachable surface
  and is worth a deliberate review before any multi-user posture.

## T5 — Compromise of the broker (cloud-data-server) code

**Threat.** A bug or RCE in the broker Lambda lets an attacker run arbitrary
code under the broker's identity.

**Stance.** The broker is deliberately **powerless in its own name**. Its
runtime role (`...-app-cloud-data-server-role`, under the *foundational*
boundary) has exactly one standing data-plane capability: `sts:AssumeRole` on
`<prefix>-app-*`, plus the SSM/KMS read needed to load app secrets. It holds
*no* standing DSQL connect, *no* S3 data access, *no* IAM mutation. Every data
operation runs under a freshly-assumed *per-app* role for one request.

**Assessment — Adequate, with an honest ceiling.** Compromised broker code is
bounded by what it can assume — but it can assume **any** per-app role and can
read **every** app's HMAC secret (`ssm:GetParameter` on `/app-creds/*`). So a
fully compromised broker can impersonate every installed app and therefore reach
every grant any app holds — i.e., effectively all shared data and all
app-specific data of installed apps. It still **cannot** mint IAM roles, connect
to DSQL as admin, or provision infra (the foundational boundary denies IAM
mutation and carries no install-time DDL/compute verbs). So the blast radius is
"all user data of installed apps," not "the AWS account." That is the
intended and reasonable trade-off for a single broker, but it should be named
plainly: **the broker is the single most valuable code target in the system.**

## T6 — Compromise of the powerful install-time identities

**Threat.** An attacker subverts Manager, install-ddl, or install-infra — the
three identities that hold the genuinely dangerous capabilities (mint IAM roles,
DB admin, provision compute).

**Stance.** These capabilities are **isolated, bounded, and ephemeral** by
design:

- **Manager** can mint/revoke per-app roles (only with one of three allowed
  boundaries, enforced by an `ArnLike` condition in `manager-policy.ts`), attach/
  detach temp policies on the two install roles, and assume them. It holds
  **zero standing data-plane power** — no S3, no DSQL, no Lambda. Its only
  non-IAM standing power is writing/deleting (never *reading*) per-app HMAC
  secrets.
- **install-ddl** is the *only* identity that can ever `dsql:DbConnectAdmin`;
  **install-infra** is the *only* one that can provision per-app compute. Both
  have **no standing permissions** — Manager attaches a tightly-scoped temp
  policy around exactly the step that needs it and detaches immediately. The two
  temp policies are **never attached simultaneously**, and never to Manager.
- Each is capped by its own narrow permissions boundary with a defense-in-depth
  IAM-mutation deny.

**Assessment — Strong.** This is the strongest part of the model: the most
dangerous verbs never sit on a standing, internet-reachable identity. The
honest caveats are (a) these identities are reachable only via the admin →
Manager role chain, so they inherit the admin account's exposure (T7); and (b) a
compromise *during* an in-flight install — while a temp policy is attached — has
a wider momentary window, but that window is seconds and requires already
controlling the install-ddl/infra session.

## T7 — Compromise of the admin (Cognito) identity

**Threat.** An attacker obtains the human admin's Cognito credentials.

**Stance.** There is **no IAM user and no long-lived access key** — the human
logs in to a Cognito user pool (`ADMIN_CREATE_USER` only,
`ALLOW_USER_PASSWORD_AUTH`) and the identity pool exchanges that for temporary
STS creds in the admin-app role via `AssumeRoleWithWebIdentity`. The admin-app
role's trust policy accepts *only* Cognito identities from the same stack's
identity pool. Crucially, **the admin is not a superuser**: it has no standing
access to shared user data. Its powers are Cognito user management, its own
`apps/admin/*` prefix, read on the billing bucket, the Pulumi passphrase
parameter, `dsql:DbConnect` as the `${prefix}_installer` PG role (registry +
install-ledger only — no `shared.records` grants), and `AssumeRole` to Manager.

**Assessment — Adequate.** Honest reality of what a stolen admin login yields:
the attacker can **install/uninstall apps and redeploy infrastructure** (via
Manager → install roles), and could install a malicious app with broad grants to
then read user data — so admin compromise *indirectly* reaches all data. What it
does **not** give is direct, standing shared-data access or account-root power.
Residual concerns: password-auth is enabled (no enforced MFA visible in the
bootstrap template — worth confirming/hardening), and the admin session is the
root of the whole delegation chain, so it deserves MFA and short session
lifetimes in any real deployment.

## T8 — Malicious app supply chain

**Threat.** A malicious or compromised app (its manifest or its bundle code)
gets installed.

**Stance & honest reality.** App **discovery is filesystem-based** from the
admin's workstation: admin-web scans `config.appParentDirs` (falling back to the
sibling `starkeep-apps/` checkout) for any dir containing a
`starkeep.manifest.json`; first match by id wins. The bundle is built by running
`pnpm bundle` **in the app directory** on the admin's machine and the resulting
`dist.zip` is shipped to the app's Lambda. The manifest is schema-validated, app
ids are namespace-checked (reserved ids rejected, `fileAccessAll`/`brokerPower`
gated), and the install grants exactly what the manifest declares.

**Assessment — Partial / accepted.** The platform validates the
*shape* of the manifest and confines the app to its declared grants (T1), but:

- There is **no code signing, no bundle provenance, and no review gate** beyond
  the human deciding to install. Whatever code is in the app directory runs in
  the cloud under the app's role.
- `pnpm bundle` runs arbitrary install-time scripts **on the admin workstation**
  with the admin's environment — a malicious app's build script executes locally
  before anything is even deployed. This is a real local-execution surface.
- The manifest's requested grants are **self-declared**; nothing scores or flags
  an over-broad request (e.g. `readwrite` on all image types). The admin is the
  sole judge.

For the current single-operator, trusted-app-source model this is consistent
with the project's stance, but it is the weakest link for any future
"install third-party apps you didn't write" scenario and should be called out
as such.

## T9 — Data at rest, in transit, and tenant isolation

**Threat.** Data is exposed at rest, in transit, or across tenants.

**Stance.** In transit: all external traffic is HTTPS (API Gateway), and
S3 presigned access is over TLS. At rest: S3 and DSQL are AWS-managed stores;
Pulumi state is encrypted with an SSM-stored passphrase (T11). The files bucket
**asserts its data-protection posture explicitly** in the install program
(`cloud-data-server-program.ts`): SSE-S3 (AES256) server-side encryption,
versioning enabled, and a full public-access block, plus the DSQL cluster
carries deletion protection and the bucket keeps the default destroy guard
(no `forceDestroy`). These are IAM actions the *foundational* permissions
boundary grants. Tenant isolation is **not a concern** — the deployment is
single-tenant in the customer's own account.

This data-protection posture is applied to **real installs only**. The cloud e2e suite
provisions *ephemeral* infrastructure that deliberately skips it (no versioning
/SSE/public-access-block, no deletion protection, `forceDestroy` on so repeated
teardown isn't wedged by leftover objects). Critically, that carve-out is
**fail-safe by construction**: ephemerality is signalled by an explicit
`--ephemeral` CLI flag (`isEphemeralInstall`), *not* an environment variable —
because the real-user install path (admin-web) spawns the CLI with an inherited
`process.env`, an env-based signal could leak in and silently downgrade a real
account's data protection. A fixed argv cannot be injected that way, so a real
install is structurally incapable of being treated as ephemeral. Unit tests
lock in both the resource posture and the flag's fail-safe defaulting.

**Assessment — Adequate (CMK + SecureTransport-deny deferred).**
Encryption-at-rest and the surrounding data-protection posture are
*policy-asserted* rather than default-relied-upon. Two deliberate, named
residuals remain:

- **AWS-managed keys, not a customer-managed KMS key (CMK).** SSE-S3 uses
  AWS-owned keys. A CMK was consciously deferred: the foundational permissions
  boundary grants only `kms:Decrypt` gated on `kms:ViaService=ssm.*`, so a CMK
  would require widening that boundary *and* granting the broker/app roles KMS
  encrypt/decrypt to read and write objects — a larger change than the
  purely-additive S3 config, not a one-line addition.
- **No `aws:SecureTransport` deny** on the bucket policy yet — transit is HTTPS
  in practice (presigned URLs, gateway) but not yet *policy-enforced* against a
  plaintext request.

## T10 — Availability, denial of service, and cost amplification

**Threat.** An attacker (or a runaway app) drives unbounded cost or degrades
availability.

**Stance & honest reality.** The serverless model (Lambda + DSQL + S3,
pay-per-use) means volumetric abuse translates **directly into the customer's
AWS bill** rather than into a hard outage, and the unauthenticated `/health`
and `public` routes are internet-reachable. Two zero-fixed-cost guardrails
bound the blast radius (`cloud-data-server-program.ts`):

- **Stage-wide request throttle** on the shared APIGW v2 `$default` stage
  (`defaultRouteSettings`: 50 rps steady-state, 100 burst). Applies to every
  route — the unauthenticated `/health`/`public` surface as well as the
  HMAC-gated data plane — so it caps the *request rate* reaching the Lambda
  regardless of which surface is hit.
- **Lambda reserved concurrency** (`reservedConcurrentExecutions: 20`) on the
  broker — the hard *dollar ceiling*: even if the throttle were mis-tuned, the
  broker can never run more than this many copies at once, bounding parallel
  DSQL connections and S3 ops, and thus worst-case spend-per-second. Legitimate
  bursts past the cap get 429'd.

Both limits are code constants for now; making them admin-configurable is
deferred (todo 45 / doc 60). Still **absent**: per-app/per-route usage quotas
(one app's leaked HMAC secret can consume the whole deployment's throttle
budget) and a WAF (no IP/bot-level filtering) — both judged unnecessary at
single-operator scale, and a WAF was explicitly excluded as it carries a fixed
monthly cost. HMAC-gated routes still do an SSM read + signature check per
request before they can 401, so hostile traffic up to the throttle ceiling is
not free, just bounded.

Separately, storage grows **monotonically**: tombstoned shared records never
have their S3 blobs collected, and there is no `parent_id` repair pass (todos
15, blob-GC) — so disk usage only ever increases under normal use. This axis
remains unmitigated.

**Assessment — Partial.** The cost-amplification axis is meaningfully bounded —
throttle caps request rate, reserved concurrency caps worst-case spend — keeping
the realistic "unbounded bill from internet traffic" failure mode off the table
at zero fixed cost. The remaining gaps are narrower: no per-app quota (cross-app
budget exhaustion), and unbounded storage growth (the more durable concern).

## T11 — Secret and infrastructure-state exposure

**Threat.** Platform secrets or infra state leak: per-app HMAC secrets, the
Pulumi state-encryption passphrase, the Pulumi state bucket.

**Stance.** HMAC secrets are SSM SecureStrings under `/${prefix}/app-creds/*`,
KMS-encrypted, readable only by the owning app's role (scoped `GetParameter` +
`ViaService`-gated `Decrypt`) and the broker. Manager can write/delete but
**never read** them. The Pulumi passphrase is an SSM SecureString minted
**create-if-missing** by the installer (CloudFormation can't make SecureStrings)
and is **deliberately never rotated** — Pulumi derives state-bucket encryption
from it, so rotation after any `pulumi up` would brick every later
up/destroy. State and artifacts buckets are versioned, account-private.

**Assessment — Adequate, with two honest notes.**

- **The passphrase can never be rotated** in the current design — an accepted
  constraint, but it means a one-time leak of that value (plus state-bucket
  read) compromises Pulumi state confidentiality permanently for that
  deployment, with no recovery short of a full teardown.
- HMAC-secret distribution breadth is restated from T2: the *cloud* side is
  well-scoped, but the same secret existing on the local workstation in plaintext
  files widens the real attack surface beyond what the cloud IAM scoping
  suggests.

---

# Part 3 — Posture summary & cross-cutting gaps

| # | Threat | Posture |
|---|---|---|
| T1 | Malicious/buggy installed app (confinement) | **Strong** |
| T2 | App-identity forgery & replay (HMAC) | **Adequate** |
| T3 | Cross-app isolation (app-specific) | **Strong** |
| T4 | Unauthenticated internet caller | **Adequate** (gaps: public routes, no per-app quota, CORS; stage throttle in place) |
| T5 | Broker code compromise | **Adequate** (blast radius = all user data, not the account) |
| T6 | Powerful install-time identities | **Strong** |
| T7 | Admin / Cognito compromise | **Adequate** (MFA worth confirming) |
| T8 | Malicious app supply chain | **Partial / accepted** |
| T9 | Data at rest / in transit | **Adequate** (files-bucket SSE/versioning/PAB + DSQL deletion-protect asserted; CMK + SecureTransport-deny deferred) |
| T10 | DoS & cost amplification | **Partial** (throttle + concurrency cap; storage growth remains) |
| T11 | Secret & infra-state exposure | **Adequate** |

**The system's genuine strengths.** Least-privilege is real and structural, not
aspirational: no IAM user, no long-lived keys, an admin who is not a superuser,
the three most dangerous capabilities isolated on dedicated ephemeral identities,
permissions boundaries as hard ceilings, and a broker that holds no standing
data-plane power. Confinement of an app to its manifest is enforced in four
independent layers. This is a well-thought-out trust architecture.

**The honest soft spots, in priority order.**

1. **Cost-DoS bounded, but storage growth is not** (T10) — a stage throttle
   + Lambda reserved concurrency cap the request-rate and worst-case-spend blast
   radius, keeping the runaway-bill failure mode off the table. The residual gaps
   are no per-app quota (one app can consume the shared throttle budget) and
   unbounded storage growth (tombstoned blobs never GC'd) — the latter is the
   more durable internet-facing concern.
2. **Shared-data grants are the real boundary, and they're admin-judgment-only**
   (T1, T8) — a granted app can touch *all* user data of its categories; nothing
   reviews or scores grant requests, and app code/bundles have no provenance.
3. **The broker is a single high-value target** (T5) — compromise reaches all
   installed apps' data (though not the account).
4. **HMAC secret breadth & lifecycle** (T2, T11) — symmetric secret copied to
   several places, no rotation, stale-cache window on reinstall.
5. **Encryption-at-rest is policy-asserted, with CMK + SecureTransport-deny
   deferred** (T9) — the files bucket explicitly asserts SSE-S3 / versioning /
   public-access-block and DSQL carries deletion protection (real installs only;
   the e2e carve-out is fail-safe via an explicit `--ephemeral` flag, never an
   inherited env var). What's left is the step up to a customer-managed KMS key
   (deferred — it needs IAM-boundary widening) and an `aws:SecureTransport` deny
   to make HTTPS policy-enforced rather than merely conventional.

None of these contradict the project's stated stance; several are explicit
deferrals of not-yet-needed work. The intent here is that a reader knows exactly
where the lines are drawn and what is and isn't guaranteed today.

---

## Source material

- `data-roles-and-permissions.md`, `system-design.md` (core design + trust
  stance)
- Functional reviews: cloud-data-server (2026-06-05/10), cloud-apps
  (2026-06-05/10), cloud-overview-and-bootstrap (2026-06-04)
- Live code: `packages/admin-installer/builtin-apps/cloud-data-server/src/{api-handler,access-enforcer}.ts`,
  `packages/admin-installer/src/builtin-programs/cloud-data-server-program.ts`,
  `packages/protocol-primitives/src/storage/object-keys.ts`
- Data-at-rest protection (T9): files-bucket SSE/versioning/PAB +
  DSQL deletion-protection + `forceDestroy` in
  `packages/admin-installer/src/builtin-programs/cloud-data-server-program.ts`;
  fail-safe ephemeral gating via `isEphemeralInstall` in
  `packages/admin-installer/src/builtin-installs.ts` (CLI flag wired in
  `scripts/cli-install-cloud-data-server.ts`, e2e in `e2e-aws/src/journey.test.ts`);
  tests in `packages/admin-installer/__tests__/cloud-data-server-hardening.test.ts`
- Related open items: todos 15, 16, 27
- AWS shared-responsibility references (managed-runtime stance):
  - Lambda runtime management & patching —
    https://docs.aws.amazon.com/lambda/latest/dg/runtime-management-shared.html
  - Aurora DSQL security —
    https://docs.aws.amazon.com/aurora-dsql/latest/userguide/security.html
