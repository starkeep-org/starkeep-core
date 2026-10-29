# Starkeep cloud: threat model and security assessment

Revised 2026-10-29. First written 2026-06-30.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/starkeep-org/starkeep-core/security/advisories/new)
rather than in a public issue.

We aim to acknowledge reports within a few days. Starkeep is pre-production software, and a small team maintains it, so please allow reasonable time for a fix before public disclosure.

The threat model below describes the current posture candidly, including what is not yet mitigated. A report that restates a limitation documented here helps us prioritize, but we do not treat it as a vulnerability report.

## Project status

Starkeep is pre-production software.

---

## Security assessment overview

> **Scope.** This document covers the cloud side: the cloud data server (the broker, DSQL, the files bucket, API Gateway and CloudFront), cloud apps and their install and uninstall lifecycle, the Cognito and IAM bootstrap, sign-in for cloud apps, computers and phones, and the cloud sync path. The local data server, local apps and the on-device sync engine are out of scope, except where they meet the cloud: the Drive channel, the per-app HMAC secret and a computer's sign-in.
>
> **Verified against code.** Source refs: `starkeep-core @ bb29742d`, `starkeep-apps @ d2cae44`. The assessments describe that code.
>
> **How to read the assessments.** Each threat carries a posture label:
>
> - **Strong:** defended in depth, with no material residual risk.
> - **Adequate:** defended, with a bounded residual risk worth knowing.
> - **Partial:** real protection, with a named gap.
> - **Deferred by design:** deliberately left for later, because the current scale does not need it.
> - **Out of scope / accepted:** the design accepts the risk and says so.
>
> The labels describe reality, not aspiration.

---

# Part 1: framing

## The account trust boundary

A Starkeep deployment lives entirely in its operator's own AWS account. There is no Starkeep SaaS control plane, no cross-account role and no IAM user. The AWS account is the outer trust boundary. Anyone with root access, or with enough IAM console power in that account, stands outside the model's protection and can read everything. The threats below assume the account itself is intact. They reason about failures inside the account, such as a misbehaving app, a forged request, a stolen device or an exposed endpoint.

One deployment serves several people. The operator creates an account for each person, and each account in the `starkeep-users` group holds a library of its own. The model treats the people on one deployment as mutually distrustful: no person may reach another person's records, rows or files. Nothing is shared between people today. User-sharing between members of one deployment is planned and not implemented.

## The managed-runtime stance

Self-hosters often put a service behind a VPC, Tailscale or a similar network layer. That mitigation fits a long-lived server whose operating system and language runtime the operator must patch, because an unpatched zero-day in that stack is a real way in. Starkeep's cloud does not have that shape, so it draws the boundary differently.

Starkeep runs only on AWS-managed serverless services: Lambda, Aurora DSQL, S3, API Gateway, CloudFront and Cognito. It runs no EC2 instances, no self-operated containers and no long-lived servers. Under the AWS shared-responsibility model, AWS builds and patches the Lambda execution environment and operates the security of DSQL's hosts, storage and network. Starkeep therefore has no operating system to patch, no SSH surface and no listening daemon outside the managed gateway. The unpatched-runtime attack path that a VPC or Tailscale guards against does not exist here.

The stance does not outsource Starkeep's own platform code: the broker, the access enforcer, the signature and token checks, the install lifecycle and the IAM design. The rest of this document assesses that code. AWS owns the security of the infrastructure under the code, and Starkeep owns the security of the code and its authorization model on top.

## Assets worth protecting

- **Shared user data.** Each person's photos and documents, in `shared.records` and under the `shared/<userId>/<category>/*` prefix in S3. Shared data is cross-app and platform-owned, and it outlives any app.
- **App-specific data.** Each app's private rows in `app_<appId>.*` and files under `apps/<appId>/<userId>/syncable/*`. Only the owning app reaches it.
- **The AWS account and its infrastructure.** The power to mint IAM roles, connect to DSQL as admin or provision compute. A subverted infrastructure power is far more dangerous than any single data item.
- **Accounts and sessions.** The admin's Cognito sign-in, and every person's sessions on computers, phones and cloud apps.
- **Platform secrets.** The per-app HMAC secrets, the Pulumi state passphrase and the CloudFront URL-signing key.

## Actors

| Actor                      | Trust                        | Holds                                                                                                  |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Admin                      | trusted operator             | A Cognito sign-in in `starkeep-admins`, which yields the admin-app role. No standing data-plane power. |
| Member                     | trusted for own library only | A Cognito account in `starkeep-users`. Reaches only the member's own library. No AWS credentials.      |
| Signed-in computer         | trusted for one library      | A device-client refresh token and ID token for one account, kept by the local data server.             |
| Mobile app on a phone      | partially trusted tenant     | A mobile-apps token for one account, plus a hardware key attested to one app.                          |
| Installed app              | **partially trusted tenant** | A data role, an execution role, a Postgres role and an HMAC secret, all capped to the app's manifest.  |
| Internet caller            | untrusted                    | The public CloudFront and API Gateway addresses, and any signed URL the caller obtains.                |
| Starkeep Drive             | trusted built-in             | The data role that writes all shared-record sync (the User-Data-Owner).                                |
| Broker (cloud data server) | trusted but bounded          | The power to assume any app's data role. No standing data permissions of its own.                      |

The load-bearing property, as `data-roles-and-permissions.md` states it, is **(1) user data stays confined to the identities authorized for it**. Two properties support it: **(2) powerful permissions are centralized, bounded and ephemeral**, and **(3) authorization is layered as nested ceilings**. The threats below ask what would have to break for property (1) to fail, and then cover the infrastructure and availability threats around it.

---

# Part 2: threat models

## T1: a malicious or buggy installed app

**Threat.** An installed app runs arbitrary code in its Lambda. The app tries to read or write data outside its declared grants: another app's app-specific data, shared types it was not granted, another person's library, or the AWS infrastructure itself.

**Stance.** The architecture is built around this threat. Five independent layers defend against it, each set by a separate install step:

1. **The app's code holds no data power.** A web app's Lambdas run as the app's execution role (`createAppExecRole`). The role reaches the app's logs, its own HMAC secret and its own sibling functions, and holds no S3, no DSQL and no `sts:AssumeRole`. The app's data role holds the app's grants, and only the broker can assume it. App code therefore reaches data only through the broker, which applies the manifest's grants on every call. The install-time `PassRole` names the execution role alone, so an install cannot hand the data role to a Lambda.
2. **Permissions boundary.** Every app role is born under the per-app boundary. The boundary scopes S3 to the app's own prefix, through the `starkeep:appId` principal tag, and to the shared prefix, both narrowed to the user named by the session's `starkeep:userId` tag. The boundary permits `dsql:DbConnect` and never `DbConnectAdmin`, and it denies all IAM mutation. An app cannot opt into the wider foundational or User-Data-Owner boundary: installer checks route only `cloud-data-server` and `starkeep-drive` to those boundaries, and the manifest validator refuses `fileAccessAll` and `brokerPower` on any other app id.
3. **DSQL IAM-to-Postgres mapping and grants.** The app's Postgres role owns only its own `app_<appId>` schema and receives category-granular grants on `shared.records` and the metadata tables. A role with no mapping row fails `DbConnect` regardless of IAM.
4. **S3 bucket policy.** A `DenyCrossAppPrefixAccess` statement refuses access under `apps/*` to any principal whose `starkeep:appId` tag names another app, independent of IAM.
5. **Application-layer checks.** DSQL has no row-level security, and `shared.records` is one table. The broker therefore reads the caller's grants on every request and gates each read and write through `canRead`, `canWrite`, `canReadCategory` and `canWriteCategory` (`access-enforcer.ts`). This layer makes the type-granular cut, per `<category>/<format>`, that the category-granular layers leave open. The same layer makes the cut between people in the database (see T9).

The net property: an app in the cloud can do exactly what its manifest declared. The app cannot widen its grants at runtime, reach another app's prefix or schema, reach another person's library, or perform any infrastructure operation.

**Assessment: Strong.** The layers are not copies of one rule: IAM and Postgres are category-granular, and the application layer is type-granular. Three caveats remain:

- **A grant is a grant.** Confinement stops an app from escaping its manifest. Confinement does not limit the manifest itself. An app granted `readwrite` on images can read, overwrite or tombstone every image in a person's library, whichever app wrote it. That is the intended shared-data model, and it makes the install-time grant decision the real security boundary for shared data. The admin is the only review gate (see T8).
- **The application layer is load-bearing.** A future code path on `shared.records` that skipped the enforcer would leak a same-category, wrong-type record, because the coarser layers would not catch it. One shared module, `protocol-primitives/access`, serves both data servers, which narrows the risk. The layer remains the thinnest.
- **Shared reads skip the IAM ceiling.** The broker serves shared file bytes through CloudFront signed URLs, and the signing key is not category-scoped. On that path, the application-layer check is the only per-category and per-user cut. One chokepoint, `signSharedCloudFrontUrl`, re-checks every key's namespace, user segment and category against the caller just before signing. The CloudFront distribution serves only `shared/*`, so the worst case of a bug is a leak within shared data, never of private app files. `data-roles-and-permissions.md` covers the trade.

## T2: app-identity forgery and request replay

**Threat.** A caller forges a request to act as an app it is not, or replays a captured legitimate request.

**Stance.** An app's server signs every `/apps/{appId}/*` request with HMAC-SHA256 and the app's secret. The broker verifies the signature before any role assumption, DSQL query or S3 call (`validateAppHmac` in `api-handler.ts`). The verifier:

- requires the `X-Starkeep-App-Id`, `X-Starkeep-App-Sig` and `X-Starkeep-App-Ts` headers, and requires the header's app id to match the app id in the path, so a holder of app A's secret cannot drive app B's routes;
- binds the method, the canonical path and a timestamp into the signed string (`${appId}:${METHOD}:${canonicalPath}:${tsMs}:` followed by the body), and rejects a timestamp more than five minutes from the server's clock (`APP_SIG_MAX_SKEW_MS`);
- compares signatures in constant time;
- loads the secret from an SSM SecureString at `/${prefix}/app-creds/${appId}`, which only a KMS grant conditioned on `kms:ViaService=ssm.*` decrypts.

A valid app signature no longer suffices. Every data call also needs the end user's ID token from the cloud-apps client (see T4), so a stolen app secret alone reaches no one's library.

**Assessment: Adequate.** The residual risks are bounded:

- **Replay within the window.** No nonce prevents reuse, so a captured request replays for up to five minutes. TLS makes capture hard, but the window is not zero. The same window applies to a mobile app's key signature (see T12).
- **The secret is symmetric and has several copies.** The same secret lives in SSM, in the local data server's registry (`hmac_secret` in `data.db`) and in `~/.starkeep/app-creds/<appId>.json`. The app's Lambda reads the SSM copy at runtime. Anyone who reads any copy can sign as the app, though not as any person.
- **No in-place rotation** (todo 13), and **a stale cache after a reinstall** (todo 7). The broker caches each secret for five minutes, so a quick reinstall leaves warm Lambdas accepting the old secret until the cache expires.

## T3: cross-app data access

**Threat.** App A reaches app B's app-specific data, or reads or writes shared data it has no grant for.

**Stance.** App-specific data has one owner. The rows live in `app_<appId>.*`, which only the app's Postgres role reaches. The files live under `apps/<appId>/<userId>/syncable/*`, which the per-app boundary, the bucket policy and the broker's app-id checks on every route all confine. No other app, and neither Drive nor the broker's own credentials, can see it. The object-key builder rejects path traversal and slashes in an app id (`object-keys.ts`), and `parseObjectKey` rejects another app's keys before any AWS call. Cross-app shared reads are allowed only when the reader's grants cover the type, which is the intended shared-data design.

A phone's app reaches its own private rows on its own channel, under its own data role, and the broker refuses every other app's channel to that phone (see T12).

**Assessment: Strong** for app-specific data, with three enforcement layers that no app controls. Shared data is type-confined rather than app-private by design, as T1 explains.

## T4: an unauthenticated internet caller

**Threat.** Anyone on the internet calls the public API Gateway, the CloudFront distribution or a signed URL.

**Stance.** The broker authenticates both the calling app and the end user on every data call, with no route exemptions:

- **The data plane requires a named user.** An app's signed request must carry an ID token from the cloud-apps client. A signed-in computer presents a device-client ID token. A mobile app presents a mobile-apps token and a signature by its attested key. The broker verifies each token against the user pool's keys and its client, checks that the account belongs to `starkeep-users`, and acts for that user alone. Before 2026-08-23, nothing on the data path checked the end user, and an internal postmortem records that exposure.
- **App routes declare their own gate.** Each route in an app's manifest declares `auth: "jwt"`, `"session"` or `"public"`. A `jwt` route sits behind the gateway's Cognito JWT authorizer. A `session` route sits behind the platform's session authorizer, which verifies the `sk_token` cookie, and the route's `publicPaths` list names the paths that skip the authorizer, such as Photos' shell and sign-in page. A `public` route reaches the Lambda unauthenticated. Both authorizers accept only cloud-apps tokens.
- **CloudFront sends a signed-out browser to sign-in.** A CloudFront function redirects any page load without `sk_token` to the app's sign-in page. CloudFront is an optimization layer and not a security boundary. The gateway stays directly reachable, so every check above runs at the gateway or in the handler.
- **Signed URLs are bearer tokens.** CloudFront signed URLs serve shared file bytes, and S3 presigned URLs serve uploads and app-private files. Both expire, and anyone holding one can use it until then.
- **The files bucket allows cross-origin requests**, so browsers can upload directly through presigned URLs.
- **No VPC or Tailscale layer sits in front of the gateway.** The architecture has no self-managed host behind the gateway to shield, so the managed gateway and the identity checks form the boundary.

**Assessment: Adequate, with named gaps.**

- A `public` route is a deliberate opening that the app declares. An app that puts data-touching logic on a `public` route without its own check exposes its users, though the broker still refuses a data call without a user token.
- A stage-wide gateway throttle bounds volumetric abuse. Reserved Lambda concurrency is disabled today (see T10). Neither a per-app or per-route quota nor a WAF exists.
- The bucket's permissive cross-origin rule grants no access by itself, because a signed URL or IAM still gates each operation. The rule widens the surface a browser can reach, and it deserves review.

## T5: compromise of the broker's code

**Threat.** A bug or remote-code-execution flaw in the broker Lambda lets an attacker run code under the broker's identity.

**Stance.** The broker holds no data power in its own name. Its role, `...-app-cloud-data-server-role` under the foundational boundary, holds `sts:AssumeRole` on `<prefix>-app-*` roles, the SSM and KMS reads needed to load app secrets and the CloudFront signing key, and write access to one SSM path for attested mobile keys. The role holds no standing DSQL connection, no S3 data access and no IAM mutation. Every data operation runs under a freshly assumed app data role for one request.

**Assessment: Adequate, with a ceiling worth naming.** A compromised broker can assume any app's data role and read every app's secret, and the broker's own code makes the cut between people in the database. A fully compromised broker therefore reaches every library of every person, through any installed app's grants. The broker still cannot mint IAM roles, connect to DSQL as admin or provision infrastructure, so the blast radius is all user data and not the AWS account. **The broker is the most valuable code target in the system.**

## T6: compromise of the install-time identities

**Threat.** An attacker subverts Manager, install-ddl or install-infra, the three identities that hold the dangerous capabilities: minting IAM roles, Postgres admin and provisioning compute.

**Stance.** The design isolates, bounds and expires these capabilities:

- **Manager** mints and revokes app roles, but only under one of three allowed boundaries, which an `ArnLike` condition in `manager-policy.ts` enforces. Manager attaches and detaches temporary policies on the two install roles and assumes them. Manager holds no standing data-plane power: no S3, no DSQL and no Lambda. Its only standing non-IAM powers are writing and deleting, never reading, per-app HMAC secrets, and reading and writing the platform's own non-secret parameters, such as the deployment's settings.
- **install-ddl** is the only identity that can ever call `dsql:DbConnectAdmin`, and **install-infra** is the only identity that can provision per-app compute. Neither holds standing permissions. Manager attaches a narrow temporary policy around exactly the step that needs it and detaches the policy right after. The two temporary policies are never attached at the same time, and never to Manager.
- A narrow permissions boundary with a defense-in-depth IAM-mutation deny caps each identity.

**Assessment: Strong.** The most dangerous verbs never sit on a standing, internet-reachable identity. Two caveats remain. These identities are reachable only through the admin-to-Manager role chain, so they inherit the admin's exposure (T7). And an attacker who already controls an install session during a running install holds a wider grant for the few seconds a temporary policy stays attached.

## T7: compromise of an admin account

**Threat.** An attacker obtains an admin's Cognito credentials.

**Stance.** No IAM user and no long-lived access key exist. An admin signs in to the Cognito user pool through the admin client, and the identity pool exchanges the ID token for temporary credentials in the admin-app role through `AssumeRoleWithWebIdentity`. The identity pool maps only the `starkeep-admins` group to that role, by rule, with `AmbiguousRoleResolution: Deny` and no default role. Any other account receives no AWS credentials, and admin-web refuses it at sign-in. The identity pool trusts only the admin client, so a token from the device, cloud-apps or mobile-apps client reaches no AWS role.

The admin is not a superuser. The admin-app role manages Cognito accounts, reaches its own `apps/admin/*` prefix, reads the billing bucket and the Pulumi passphrase parameter, connects to DSQL as the `${prefix}_installer` role, which holds no grants on `shared.records`, and assumes Manager. Being an admin grants no data: an admin's own library comes from `starkeep-users` membership, like any member's.

**Assessment: Adequate.** A stolen admin sign-in lets the attacker install and uninstall apps and redeploy infrastructure. The attacker could install a malicious app with broad grants and so reach every person's data indirectly. The attacker could also create accounts, change group membership or reset passwords. A stolen admin sign-in does not yield direct, standing data access or account-root power. Residual concerns:

- **No multi-factor authentication.** The pool enforces no MFA, and admin-web signs in with a password (`ALLOW_USER_PASSWORD_AUTH`).
- **A weak password policy.** The pool requires eight characters and no character classes.
- **Long-lived admin refresh tokens.** The admin client issues thirty-day refresh tokens. The admin sign-in roots the whole delegation chain, so it deserves MFA and shorter sessions in any real deployment.

## T8: a malicious app supply chain

**Threat.** A malicious or compromised app, through its manifest or its bundle code, gets installed.

**Stance.** Admin-web discovers apps from the admin's own computer. Admin-web scans the folders in `config.appParentDirs`, seeded with the sibling `starkeep-apps` checkout, for any folder holding a `starkeep.manifest.json`, and the first match for an app id wins. A cloud install builds the app by running `pnpm bundle` in the app's folder on the admin's computer and ships the resulting zip to the app's Lambdas. The installer validates the manifest's schema, checks the app id against reserved ids, gates `fileAccessAll` and `brokerPower`, and grants exactly what the manifest declares. A mobile app's manifest also names the Android package and signing certificates that the broker accepts for attestation (see T12).

**Assessment: Partial / accepted.** The platform validates the manifest's shape and confines the app to its grants (T1). Three gaps remain:

- **No code signing, no bundle provenance and no review gate** exist beyond the admin's decision to install. Whatever code sits in the app's folder runs in the cloud under the app's execution role.
- **`pnpm bundle` runs arbitrary scripts on the admin's computer** with the admin's environment, so a malicious app's build script runs locally before anything deploys.
- **The manifest declares its own grants.** Nothing scores or flags an over-broad request. The admin is the sole judge.

The current model assumes one operator who installs apps from trusted sources. This threat is the weakest link for any future scenario in which people install apps they did not write.

## T9: isolation between people, and data at rest and in transit

**Threat.** One person reaches another person's data on the same deployment, or data is exposed at rest or in transit.

**Stance: isolation between people.** Every owned cloud table leads its primary key with `user_id`, and every object key carries the owner's user segment. The broker takes the user from the verified token's `sub` on every request, and the cut is layered:

- **In the database, the cut is application-layer.** DSQL has no row-level security, and a session tag does not change the Postgres role. One compiler plugin (`storage-aurora-dsql/src/owner-scope.ts`) adds the user's predicate to every read, update and delete of an owned table and stamps every insert with the user. The broker's database client refuses any statement on an owned table that skipped the plugin.
- **In S3, IAM makes the cut.** The broker tags each assumed session with `starkeep:userId`, and the app's role may set that one tag and no other. The permissions boundaries scope every shared and app-private object to the tagged user.
- **On CloudFront signed URLs, the signing chokepoint makes the cut.** `signSharedCloudFrontUrl` compares each key's user segment with the request's user before signing.
- **On sync, the device and mobile branches refuse keys under another user's segment.** A computer's library binds to the first account that signs in. A sign-in as a different account later leaves sync off rather than mixing two libraries.

One exception to per-user tables is deliberate. Every app role may read Drive's bytes watermark table, `_starkeep_byte_coverage`, so the broker can decide whether a shared file has reached S3 before it signs a URL. The table holds one clock value per device per user and no content, and the owner-scope plugin confines the read to the request's user.

**Stance: at rest and in transit.** All external traffic uses HTTPS, through CloudFront and API Gateway, and every signed URL uses TLS. The install program (`cloud-data-server-program.ts`) sets the files bucket's protection explicitly: SSE-S3 (AES-256) encryption, versioning and a full public-access block. The DSQL cluster carries deletion protection, and the bucket keeps the default destroy guard. CloudFront reaches the bucket through origin access control, and the bucket policy admits the distribution only to `shared/*`.

The cloud end-to-end suite provisions disposable infrastructure that skips this protection, so repeated teardowns do not stall. An explicit `--ephemeral` CLI flag (`isEphemeralInstall`) signals the carve-out, never an environment variable. Admin-web starts the installer with an inherited environment, so an environment signal could leak into a real install and silently weaken its protection. A fixed argument cannot leak that way, and unit tests lock in both the protection and the flag's safe default.

**Assessment: Adequate.**

- **The database cut between people lives in one plugin.** IAM backs the cut in S3, but nothing backs it in DSQL. The tripwire in the broker's database client catches a statement that skips the plugin, and a bug inside the plugin would not be caught by any other layer.
- **AWS-owned keys, not a customer-managed KMS key.** A customer-managed key was deferred, because it requires widening the foundational boundary and granting the broker and app roles KMS encrypt and decrypt.
- **No `aws:SecureTransport` deny** exists on the bucket policy, so HTTPS is the practice but not a policy-enforced rule.

## T10: availability, denial of service and cost amplification

**Threat.** An attacker or a runaway app drives unbounded cost or degrades availability.

**Stance.** The serverless model charges per use, so volumetric abuse turns into the operator's AWS bill rather than into an outage. The unauthenticated surfaces, such as `/health`, `public` routes and sign-in pages, are reachable from the internet. One zero-fixed-cost guardrail bounds the request rate: a stage-wide throttle on the shared API Gateway stage (`defaultRouteSettings`, 50 requests per second steady and 100 burst). The throttle covers every route.

Reserved Lambda concurrency on the broker is **disabled**. A new AWS account allows ten concurrent Lambda executions in total, and AWS refuses any reservation that leaves fewer than ten unreserved, so a reservation breaks the install on a default account. The account-wide limit of ten caps parallel spend for now, and also throttles legitimate use: one cloud app page load can exceed it.

Storage grows without bound. Tombstoned shared records keep their S3 files, and no job collects them or repairs `parent_id` links (todo 6).

**Assessment: Partial.** The throttle caps the request rate, which keeps an unbounded bill from internet traffic unlikely. Four gaps remain:

- No broker-specific concurrency cap exists until the account limit rises and reserved concurrency returns (todo 45).
- No per-app quota exists, so one app with a leaked secret can use up the whole throttle budget (todo 44).
- Attested mobile keys accumulate without a cap, so one member can exhaust the account's SSM parameter quota (todo 73).
- Storage only grows.

## T11: secret and infrastructure-state exposure

**Threat.** Platform secrets or infrastructure state leak: per-app HMAC secrets, the Pulumi passphrase or state, or the CloudFront signing key.

**Stance.** HMAC secrets are SSM SecureStrings under `/${prefix}/app-creds/*`. Each app's execution role and the broker can read them, and Manager can write and delete them but never read them. The Pulumi passphrase is an SSM SecureString that the installer creates once, because CloudFormation cannot create SecureStrings. The passphrase is never rotated, because Pulumi derives its state encryption from it and a rotation after any deploy would break every later deploy. The CloudFront signing key is an SSM SecureString that only the broker's role can read, so an app cannot sign URLs itself. The state and artifacts buckets are versioned and private to the account. Attested mobile keys under `/${prefix}/platform/mobile-keys/*` hold public keys only.

**Assessment: Adequate, with two notes.**

- **The passphrase can never rotate.** A one-time leak of the passphrase, together with read access to the state bucket, exposes Pulumi state permanently for that deployment, with no recovery short of a full teardown.
- **HMAC secrets have local copies.** The cloud side scopes the secrets well, but the plaintext copies on the admin's computer (see T2) widen the real surface beyond what the cloud scoping suggests.

## T12: stolen or misused device and mobile credentials

**Threat.** An attacker obtains a computer's or a phone's sign-in, or a hostile app on a phone tries to act beyond its grants.

**Stance: computers.** A computer signs in through the device client, with the account's email and password entered in admin-web's "This machine" form. Only platform code sees the password: admin-web passes the password to the local data server, which calls Cognito. The local data server keeps the session in `~/.starkeep/device-session.json` with mode 0600. The device client issues fifteen-minute ID tokens and ten-year refresh tokens, and it has no OAuth flow. The broker admits a device token on the device-token branch only, and only for an account in `starkeep-users`. The branch allows the short list of routes that a computer's sync calls, refuses writes to the platform's own files, and confines every key to the account's own user segment. The broker refuses a device token on every other branch.

**Stance: phones.** A mobile app signs in on Cognito's managed login page in the system browser, through the mobile-apps client with PKCE, and never sees the password. After each sign-in, the app creates a hardware Keystore key and registers it with an Android Key Attestation chain. The broker verifies the chain against Google's pinned roots and revocation list, requires a hardware-backed key, a locked bootloader and a verified or self-signed boot state, and maps the attested package and signing certificates to exactly one registered app. Every later request carries the token and a signature by that key. The broker then applies the attested app's own grants on Drive's channel, never Drive's full scope, and admits the app's own private channel and no other app's.

**Revocation is per account.** An admin's "Sign out all devices" or "Disable" ends every refresh token the account holds. A computer's sign-out revokes its own refresh token. No single device's session can be revoked alone. The fifteen-minute ID token bounds how long a disabled or removed account keeps syncing.

**Assessment: Adequate.**

- **A stolen computer holds a long-lived refresh token.** The attacker syncs the account's whole library until an admin signs the account out everywhere. The route allowlist keeps the attacker away from record deletion through the record routes, but the attacker can push changes through sync.
- **A mobile app's identity is only as strong as its signing key.** Photos Mobile is signed with Expo's public debug keystore today, so anyone can build an APK that attests as Photos (todo 72). Attestation still proves genuine hardware.
- **A hostile app can still ask for a password.** Nothing stops an app from drawing its own sign-in form. A typed password signs in through the device client with a computer's scope. Closing the path needs a device client that accepts no password.
- **Attested keys accumulate.** Nothing deletes old keys. A key without a live token reaches nothing (see T10 for the quota risk).

## T13: cloud apps sharing one origin

**Threat.** Script running on one cloud app's pages acts inside another cloud app on the same deployment.

**Stance.** Every cloud app serves from the platform's one CloudFront domain, under `/apps/<appId>/`. The broker's sign-in routes (`/auth/start`, `/auth/callback`, `/auth/sign-out`) set each app's `sk_session` and `sk_token` cookies as `HttpOnly` at that app's path only, so no script reads a token. The callback re-checks the app and return path, because any app's script on the shared origin can write the sign-in state cookie.

**Assessment: Partial / accepted.** A cookie path is not a security boundary within one origin. Script on app A's page can send requests to app B's paths, and the browser attaches app B's cookies, so app A's script can act as the signed-in person inside app B. Every app on the deployment is one the admin chose to install (T8), which bounds the risk today. One origin per app closes the gap, and that work is deferred.

---

# Part 3: posture summary and cross-cutting gaps

| #   | Threat                                          | Posture                                                                                           |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| T1  | Malicious or buggy installed app                | **Strong**                                                                                        |
| T2  | App-identity forgery and replay                 | **Adequate** (five-minute replay window, symmetric secret copies, no rotation)                    |
| T3  | Cross-app isolation                             | **Strong**                                                                                        |
| T4  | Unauthenticated internet caller                 | **Adequate** (public routes, no per-app quota, permissive bucket CORS)                            |
| T5  | Broker code compromise                          | **Adequate** (blast radius: all user data, not the account)                                       |
| T6  | Install-time identities                         | **Strong**                                                                                        |
| T7  | Admin account compromise                        | **Adequate** (no MFA, weak password policy)                                                       |
| T8  | Malicious app supply chain                      | **Partial / accepted**                                                                            |
| T9  | Isolation between people; at rest, in transit   | **Adequate** (database cut in one plugin; customer-managed key and SecureTransport deny deferred) |
| T10 | Denial of service and cost amplification        | **Partial** (throttle only; reserved concurrency disabled; storage and key growth)                |
| T11 | Secret and infrastructure-state exposure        | **Adequate**                                                                                      |
| T12 | Stolen or misused device and mobile credentials | **Adequate** (long-lived refresh tokens, debug-keystore signing, password path)                   |
| T13 | Cloud apps sharing one origin                   | **Partial / accepted**                                                                            |

**Strengths.** Least privilege is structural. No IAM user and no long-lived access key exist. The admin is not a superuser. App code runs under a role with no data power. The three most dangerous capabilities sit on dedicated, ephemeral identities. Permissions boundaries act as hard ceilings, and the broker holds no standing data power. Five independent layers confine an app to its manifest. The broker checks both the calling app and the end user on every data call, and every request acts for one person's library.

**Soft spots, in priority order.**

1. **Shared-data grants are the real boundary, and only the admin judges them** (T1, T8). A granted app can touch all of a person's data in its categories, nothing reviews grant requests, and app bundles have no provenance.
2. **The broker is the single high-value target** (T5). A compromise reaches every person's data, though not the account. The broker's code also makes the database cut between people (T9).
3. **Sign-in strength** (T7, T12). No MFA, a weak password policy, ten-year device refresh tokens, per-account revocation only, and a debug-signed mobile app.
4. **Cost and growth** (T10). Only the stage throttle bounds the request rate, and storage and attested keys grow without bound.
5. **The shared origin** (T13). Any installed cloud app's script can act inside another cloud app.
6. **HMAC secret breadth and lifecycle** (T2, T11). The symmetric secret has several copies, no rotation and a stale-cache window on reinstall.
7. **Encryption at rest relies on AWS-owned keys**, and HTTPS is not policy-enforced (T9).

None of these contradict the project's stated stance, and several are explicit deferrals of work not yet needed. A reader should know where the lines are drawn and what is and is not guaranteed today.

---

## Source material

- `data-roles-and-permissions.md` and `system-design.md`, for the design and the trust stance.
- Live code:
  - the broker: `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`, `access-enforcer.ts`, `session-authorizer.ts`, `sign-in-routes.ts`, `verify-user-token.ts`, `mobile-keys.ts`, `mobile-attestation.ts` and `byte-presence.ts`;
  - the install: `packages/admin-installer/src/orchestrator.ts`, `iam.ts`, `temp-policies.ts` and `builtin-programs/cloud-data-server-program.ts`;
  - the bootstrap: `packages/aws-bootstrap/src/bootstrap/bootstrap-template.ts`;
  - the cut between people: `packages/storage-aurora-dsql/src/owner-scope.ts`;
  - object keys: `packages/protocol-primitives/src/storage/object-keys.ts`.
- The ephemeral carve-out (T9): `isEphemeralInstall` in `packages/admin-installer/src/builtin-installs.ts`, the CLI flag in `packages/admin-installer/scripts/cli-install-cloud-data-server.ts`, and the tests in `packages/admin-installer/__tests__/cloud-data-server-hardening.test.ts`.
- Related open todos: 6, 7, 13, 44, 45, 72 and 73.
- AWS shared-responsibility references:
  - Lambda runtime management: https://docs.aws.amazon.com/lambda/latest/dg/runtime-management-shared.html
  - Aurora DSQL security: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/security.html
