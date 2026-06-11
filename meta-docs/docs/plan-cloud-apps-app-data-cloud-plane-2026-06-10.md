# Plan: Cloud-side app-data plane (handoff)

Companion to `todo-cloud-apps-app-data-cloud-plane-2026-06-10.md`. Written
to be picked up cold by a new session.

## Goal

Make this end-to-end work in cloud-mode Starkeep:

> The cloud-served photos app at `/api/photos/captions/[id]` reads and
> writes captions through the cloud data server, just like the local
> photos app does through the local data server.

Today (2026-06-10) this 503s because (a) the cloud data server had no
`/app-data/*` routes, and (b) cloud-served apps have no way to obtain
the credentials they'd use to call those routes.

(a) was implemented in the prior session. (b) is the remaining work and
is the bulk of this plan.

## Trust model decision (already made)

**Style B:** each cloud-installed app has its own per-app credential.
That credential identifies the *app*, not any end user. The photos app's
Lambda fetches it at startup and signs every outbound call to the cloud
data server with it. The cloud data server verifies the signature.

We do *not* forward the end-user's JWT down to the data server. Apps are
the trust principals at the data plane; end-user identity is the app's
business.

## What's already in place (do not redo)

In `packages/admin-installer/builtin-apps/cloud-data-server/`:

- `package.json` — added `@starkeep/shared-space-api` workspace dep.
- `src/api-handler.ts` — added lazy `getAppSyncableSource` and
  `getAppSpecificView`, refactored `/sync/exchange` to share the source,
  added `/app-data/db/<table>` (GET/POST/PATCH/DELETE) and
  `/app-data/files/<key>` (PUT/GET/DELETE) routes. PUT has a 20 MB cap.
  GET files calls `storage.getSignedUrl` directly (bypasses the factory's
  sync `fileUrl`) with `expiresIn` clamped to remaining STS session
  lifetime minus a 30s buffer via `clampPresignExpiresIn`.

`pnpm install` + `tsc --noEmit` clean as of handoff.

**Important caveat:** the new routes currently have **no caller-identity
check**. They trust the appId in the URL path. Step 2 below closes that
hole — and once it does, the `/sync/exchange` and `/data/*` routes
should be brought under the same verifier (they share the same gap).

## The three pieces

### 1. Per-app secret provisioning (installer)

**Where it lives:** AWS Secrets Manager, one secret per
cloud-installed app. Name pattern
`${stackPrefix}/app-creds/${appId}` (mirrors how `iam.ts` names
per-app roles). Value is a JSON blob: `{ appId, hmacSecret }` — same
shape as the local `~/.starkeep/app-creds/${appId}.json` file so any
future shared parsing code can stay symmetric.

**Who creates it:** the admin-installer pipeline, at the point in cloud
install where a new app's per-app IAM role + DSQL grants are set up.
Look for the install path that exercises `iam.ts` and the per-app role
trust policy; the secret creation goes alongside.

**IAM scoping:**
- Per-app role gets `secretsmanager:GetSecretValue` on its own secret
  only (`Resource: arn:...:secret:${stackPrefix}/app-creds/${appId}-*`).
- Cloud-data-server Lambda role gets read on `${stackPrefix}/app-creds/*`
  (it needs to verify any app's signature).

**Uninstall:** the existing uninstall path that tears down the per-app
role should also delete the secret. See the existing teardown bootstrap
script and uninstall flow — there's a memory note that bootstrap
teardown handles non-CFN resources, the same pattern applies here.

### 2. Verifier in the cloud data server

Two changes to `cloud-data-server/src/api-handler.ts`:

a. **Fetch the expected secret for the path's appId.** Add a cached
   loader (per warm-Lambda-instance, TTL ~5 min) keyed by `appId` that
   reads from Secrets Manager via the CDS Lambda's role. Cache shape
   mirrors `credentialCache` already in the file (line 75).

b. **HMAC verification before any per-app work.** Add `validateAppHmac`
   inline, before the `getAppCreds(appId, ...)` call at handler line
   ~387. Reuse the exact wire format `signedFetch` uses
   (`packages/app-client/src/sign.ts`): inputs are `appId` and raw body
   bytes; HMAC-SHA256 over `${appId}:` ++ body; header pair
   `X-Starkeep-App-Id` + `X-Starkeep-App-Sig`. For GET/HEAD the body is
   the empty string (also in sign.ts).

   On failure return 401. The header's `X-Starkeep-App-Id` must match
   the appId parsed from the URL path; reject if not.

Apply the verifier to **all** `/apps/{appId}/...` routes, including
the pre-existing `/data/*` and `/sync/exchange`. They've been operating
on path-trust alone; closing the new door without closing those would
be incoherent. (Note: the local sync supervisor today calls cloud with
a Bearer header, not HMAC — see "Sync supervisor migration" below for
how to handle the transition.)

### 3. Cloud-aware app client

Two changes in `packages/app-client/`:

a. **`credentials.ts` — cloud mode.** Add an env-driven branch:

   - If `STARKEEP_APP_CLIENT_MODE=cloud`:
     - Read `STARKEEP_CLOUD_DATA_BASE` (e.g.
       `https://abc123.execute-api.us-east-1.amazonaws.com`).
     - Read the secret from Secrets Manager using the app's own IAM
       role (the Lambda exec role for the cloud-served app), name
       `${STACK_PREFIX}/app-creds/${appId}`. Cache per process.
     - Return `{ appId, hmacSecret, dataServerUrl:
       \`${base}/apps/${appId}\` }`.
   - Else (local): existing filesystem path unchanged.

   New runtime dep: `@aws-sdk/client-secrets-manager` (only loaded
   under cloud mode — guard the import).

b. **`sign.ts` — no change needed.** The HMAC handshake is the same in
   both modes. `signedFetch` keeps working.

Captions route stays unchanged.

## Sync supervisor migration

The local sync supervisor today calls cloud `/apps/{appId}/sync/exchange`
with a Bearer header (`sync-supervisor.ts` ~line 192, via
`getAuthHeader`). Once the cloud verifier is HMAC-only this breaks.

Two paths — pick one as part of step 2:

- **Switch the supervisor to HMAC too.** It already has access to the
  per-app credentials locally (they live in the same
  `~/.starkeep/app-creds/${appId}.json` files), so it can sign with the
  same secret the cloud verifier expects. Cleanest end-state.
- **Keep both verifiers temporarily.** Accept either a valid HMAC *or*
  a valid Bearer JWT during a transition. Simpler to ship, leaves
  cleanup debt.

Recommended: do the HMAC switch in the same PR. The local creds file
and the Secrets Manager secret are written from the same source (the
installer should put the same value in both at cloud-install time), so
the supervisor and the cloud handler will agree.

## Test plan

- **Cloud-handler unit:** assert that without a valid sig the new
  routes 401; with one they do the same thing the local routes do.
  Look at existing tests around `/sync/exchange` for the in-memory
  DSQL/S3 fake pattern.
- **Installer unit:** secret created on install, deleted on uninstall.
- **End-to-end:** cloud-built photos app, set `STARKEEP_APP_CLIENT_MODE=cloud`
  and `STARKEEP_CLOUD_DATA_BASE` on the Lambda, GET/PUT/DELETE
  `/api/photos/captions/[id]`. Expect the same JSON shapes the local
  build returns.

## Order of work

1. Step 1 (installer + Secrets Manager). Verify by hand that an
   install creates a readable secret with the right IAM grants.
2. Step 3b first (no, sign.ts unchanged) — skip.
3. Step 3a (`credentials.ts` cloud mode), so a cloud Lambda *can*
   sign calls, even though nothing is verifying yet.
4. Step 2 (verifier in CDS), including the sync supervisor HMAC
   migration.
5. End-to-end caption test in cloud.

## Files touched (expected)

- `packages/admin-installer/...` — installer secret create/delete +
  IAM grant changes (find via `iam.ts` and the per-app role setup).
- `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`
  — verifier block, secret cache.
- `packages/admin-installer/builtin-apps/cloud-data-server/package.json`
  — add `@aws-sdk/client-secrets-manager`.
- `packages/app-client/src/credentials.ts` — cloud-mode branch.
- `packages/app-client/package.json` — optional dep
  `@aws-sdk/client-secrets-manager` (or peer).
- `apps/local-data-server/sync-supervisor.ts` — swap Bearer →
  HMAC (or keep both during transition).
- `scripts/teardown-bootstrap.sh` if Secrets Manager cleanup belongs
  there alongside the other non-CFN teardown (memory note flags this).
- Captions route unchanged.

## Open questions to confirm before starting

1. Is Secrets Manager the right home, or does this project already use
   SSM Parameter Store SecureString for similar per-app secrets? (Worth
   one grep — there's a memory note about a bootstrap script handling
   SSM SecureString.)
2. The local supervisor migration — happen in the same PR, or staged?
3. Should `STACK_PREFIX` be discoverable by the cloud-served app
   Lambda, or do we pass the full secret name in as an env var so the
   app doesn't need to know the prefix? (Probably the latter — pass
   `STARKEEP_APP_CREDS_SECRET_ARN` directly.)
