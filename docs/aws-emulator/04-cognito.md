# AWS Emulator, Cognito sign-in flows against an API-created user pool

Issue: AI-682 (epic AI-678, wave 2). Spike: [`spikes/aws-emulator/cognito/`](../../spikes/aws-emulator/cognito/).
Builds on [01-runtime.md](01-runtime.md) (install, TLS trust, credentials) and [02-coverage.md](02-coverage.md)
("Ranked experiments", item 2: the Cognito user-pool API path with a pool created through the API).

**Emulator version used: 1.0.322** (release date 2026.11.10, commit `7753983c6e495ec3612695b1336bf4936fc7b7fd`),
`aws-emulator_1.0.322-1_amd64.deb`. `versions.json` listed 1.0.322 as the newest LTS package on 2026-11-12.
SDKs (what the code under test resolves): `@aws-sdk/client-cognito-identity-provider` 3.1034.0,
`@aws-sdk/client-cognito-identity` 3.1030.0, `@aws-sdk/client-iam` and `client-sts` 3.1030.0,
`@aws-sdk/client-s3` 3.1009.0. Node 24.22.3, `tsx` 4.21.0. Region `us-east-1`.

## Findings

1. **Every resource the bootstrap template declares for Cognito was created through the API, and no property
   was rejected or dropped.** `CreateUserPool` with all of the template's properties (`UserPoolTier: ESSENTIALS`,
   admin-create-only with the invite template, email username and auto-verify, immutable required `email`,
   `COGNITO_DEFAULT`, the 8-character password policy with no `Require*`, both tags), both app clients, both
   groups, the domain (`ManagedLoginVersion: 2`), the identity pool, an IAM role with the template's trust policy,
   and `SetIdentityPoolRoles` with `Roles: {}` plus the `cognito:groups Contains starkeep-admins` rule. Every
   property read back as set (`DescribeUserPool`, `ListTagsForResource`, `DescribeUserPoolClient` ×2,
   `DescribeUserPoolDomain`, `DescribeIdentityPool`, `GetIdentityPoolRoles`). The pool id has the AWS shape
   `us-east-1_<9 hex>`, so `regionFromUserPoolId` works.
2. **`NEW_PASSWORD_REQUIRED` cannot be answered: `RespondToAuthChallenge` returns HTTP 501.** `USER_PASSWORD_AUTH`
   with the temporary password correctly returns the `NEW_PASSWORD_REQUIRED` challenge and a session on all three
   code paths, but answering it fails with `NotImplemented: operation RespondToAuthChallenge with
ChallengeName=NEW_PASSWORD_REQUIRED is scaffolded but not implemented in this emulator` (HTTP 501), for the SDK
   paths (admin-web, installer) and the device client's raw `fetch` alike. This is the first-sign-in step of every
   admin-created account. The workaround is the one `e2e-aws/src/admin-user.ts` already uses:
   `AdminSetUserPassword Permanent: true`, after which the user is `CONFIRMED` and signs in without a challenge.
3. **Everything else on the sign-in paths works through the real code.** After the workaround: admin-web
   `initiateAuth` and `refreshTokens`, installer `cognitoPasswordAuthTokens`, and the device client's `signIn`,
   `refresh` and `revoke` all succeed; wrong passwords, unknown users (with `PreventUserExistenceErrors`), revoked
   refresh tokens, globally signed-out users and disabled users are all refused with AWS's
   `NotAuthorizedException` and AWS's messages. The devices client's 15-minute ID token (`exp - iat = 900`,
   `ExpiresIn 900`) and the admin client's 60-minute one are honoured.
4. **Unsigned `InitiateAuth` is accepted.** The SDK (3.1034.0) sends `InitiateAuth` without an `Authorization`
   header (observed after its signing middleware), and the device client posts plain JSON; the emulator accepts both.
5. **`verifyIdToken` returns `null` at `packages/app-client/src/auth/verify.ts:122` (`header.alg !== "RS256"`),
   before any JWKS fetch** (the fetch guard saw no request during the call). Emulator ID tokens are
   `alg ES256`, `iss https://127.0.0.1:9297/<poolId>`. Past line 122 the verifier would also fail on the JWKS
   host (`:43`), the RSA-only key import (`:56`) and the issuer (`:147`). The emulator's JWKS
   (`/<poolId>/.well-known/jwks.json`, also reachable as `<iss>/.well-known/jwks.json`) publishes one EC P-256 key
   whose `kid` matches the token, and the ES256 signature verifies with `crypto.subtle`; an altered payload does not.
6. **The identity pool vends credentials, and they are accepted, and IAM-evaluated by S3.** admin-web
   `getIdentityPoolCredentials` (and the installer's) returns `EMULATOR…` keys (20 chars, not `ASIA…`) with a
   session token and a one-hour expiry. `GetCallerIdentity` with them answers
   `arn:aws:sts::000000000000:assumed-role/<prefix>-app-admin-role/CognitoIdentityCredentials`, the AWS shape.
   An S3 `PutObject` with them is **denied** while the role has no policy (`AccessDenied … because no
identity-based policy allows the s3:PutObject action`), **succeeds** (HTTP 200) once a one-statement
   `s3:PutObject` policy on the bucket is attached, and is denied on a second bucket outside that policy.
   So "vended keys accepted" is a yes, and for S3 this emulator version does scope them to the role
   (contrary to [G-cid-session]; IAM evaluation itself is out of scope here and was not probed further).
7. **Cognito admin calls made with the vended keys are not IAM-evaluated.** Every `users.ts` route (`LIST`,
   `CREATE`, `SET_GROUP`, `RESET_PASSWORD`, `SIGN_OUT_EVERYWHERE`, `SET_ENABLED`) succeeded with those keys
   while the role held no Cognito permission at all (its only policy was the S3 statement above). On AWS each
   would be `AccessDeniedException`. An emulator run cannot catch a missing `cognito-idp:*` grant in
   `admin-app-policy.ts`.
8. **Role mapping works; one wrong-client case is refused with a different error and one call too late.**
   A `starkeep-users`-only member's token is refused by `GetCredentialsForIdentity` with AWS's own message
   (`The ambiguous role mapping rules for: … denied this request.`). A devices-client ID token (the identity pool
   trusts only the admin client) gets an identity id from `GetId` and is refused only by
   `GetCredentialsForIdentity`, with `InvalidIdentityPoolConfigurationException`; AWS refuses it at `GetId` with
   `NotAuthorizedException`. The device token is still refused, which is the property starkeep relies on.
9. **`AdminCreateUser` works exactly as `users.ts` sends it; `MessageAction: SUPPRESS` is not needed.** With
   `DesiredDeliveryMediums: [EMAIL]` and no `MessageAction`, the user is created (`FORCE_CHANGE_PASSWORD`,
   `Username` = the generated `sub`, as AWS does for an email-username pool). No email is sent and nothing about
   one appears in the emulator log.
10. **`packages/app-client/src/auth/cognito.ts:59` hard-codes `https://cognito-idp.<region>.amazonaws.com/`.**
    Its `refreshTokens` tried exactly that URL (stopped by the spike's fetch guard); it has no endpoint option.
11. **ID tokens lack `email_verified`.** AWS includes `"email_verified": true` once the attribute is set; the
    emulator's tokens carry `email`, `cognito:username`, `cognito:groups`, `auth_time`, but not `email_verified`.
    Nothing in starkeep-core reads that claim from a token.
12. **Fast.** 83 steps take 2.2 s of call time; the driver 3.3 s including `tsx` start. The run is dominated by
    the 163 MiB download (35 s end to end in the sandbox, 28 s of it download, verify and unpack).

## Verdict

**Yes, with gaps.** admin-web user management runs on the emulator unchanged: every `users.ts` route handler,
called with the identity-pool credentials of a signed-in admin, created, grouped, reset, signed out, disabled and
re-enabled accounts, and each Cognito-side effect was visible to the next sign-in (a reset password yields
`NEW_PASSWORD_REQUIRED`, a disabled user gets `User is disabled.`, a global sign-out kills the refresh token).
Admin sign-in runs through the real `admin-web`, `admin-installer` and device-client code, unsigned, with refresh,
revocation, the 15-minute device tokens and the identity-pool exchange all working. The gaps a CI job must live
with: the first-sign-in password change (`RespondToAuthChallenge NEW_PASSWORD_REQUIRED`) is a 501, so tests must
set a permanent password first (as `e2e-aws` already does) and cannot cover that branch; tokens are ES256 with an
emulator issuer, so no starkeep verifier (`app-client/src/auth/verify.ts`, cloud-data-server
`verify-user-token.ts`) accepts them without a test seam; `app-client/src/auth/cognito.ts` cannot be pointed at
the emulator; and Cognito admin calls are not IAM-checked, so the admin-app policy's Cognito grants go untested.

## Created resources

All through the SDK (spike clients, emulator credentials), in the template's order. `<prefix>` is random per run
(`spk` + 6 hex). Nothing was rejected, so no fallback retry ran (the driver retries a rejected create without one
optional property at a time to name the culprit; none was needed).

| Template resource                   | API call(s)                                                         | Properties sent (all of the template's)                                                                                                                                                                                                                                                                                                                                                                                         | Read back                                                      | Rejected / dropped                                |
| ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `UserPool`                          | `CreateUserPool`                                                    | `PoolName <prefix>-auth`, `UserPoolTier ESSENTIALS`, `AdminCreateUserConfig` (`AllowAdminCreateUserOnly`, `InviteMessageTemplate` subject + HTML message with `{username}`/`{####}`), `AutoVerifiedAttributes [email]`, `UsernameAttributes [email]`, `Schema` email required/immutable, `EmailConfiguration COGNITO_DEFAULT`, `PasswordPolicy` min 8, four `Require*: false`, `UserPoolTags` `starkeep:managed`, `StackPrefix` | `DescribeUserPool`, `ListTagsForResource`: all equal           | none                                              |
| `UserPoolClient`                    | `CreateUserPoolClient`                                              | `<prefix>-admin`, `GenerateSecret false`, `ALLOW_USER_PASSWORD_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`, `RefreshTokenValidity 30` days, `PreventUserExistenceErrors ENABLED`                                                                                                                                                                                                                                                         | `DescribeUserPoolClient`: all equal, no `ClientSecret`         | none                                              |
| `DeviceUserPoolClient`              | `CreateUserPoolClient`                                              | `<prefix>-devices`, same, plus `IdTokenValidity`/`AccessTokenValidity 15` minutes, `RefreshTokenValidity 3650` days, `EnableTokenRevocation true`                                                                                                                                                                                                                                                                               | `DescribeUserPoolClient`: all equal                            | none                                              |
| `UserPoolDomain`                    | `CreateUserPoolDomain`                                              | `Domain <prefix>-000000000000` (account id from `GetCallerIdentity`), `ManagedLoginVersion 2`                                                                                                                                                                                                                                                                                                                                   | `DescribeUserPoolDomain`: `ACTIVE`, a `…cloudfront.net` name   | none (control plane only; Hosted UI out of scope) |
| `IdentityPool`                      | `CreateIdentityPool`                                                | `<prefix>_admin`, `AllowUnauthenticatedIdentities false`, provider `cognito-idp.us-east-1.amazonaws.com/<poolId>` for the admin client, `ServerSideTokenCheck false`                                                                                                                                                                                                                                                            | `DescribeIdentityPool`: all equal                              | none                                              |
| `AdminAppRole`                      | IAM `CreateRole`                                                    | `<prefix>-app-admin-role`, the template's trust policy (`cognito-identity.amazonaws.com`, `aud` = identity pool, `amr` authenticated), three tags. **No permission policy** (IAM evaluation is out of scope); step 5 later adds one `s3:PutObject` statement                                                                                                                                                                    | (ARN used below)                                               | none                                              |
| `IdentityPoolRoleAttachment`        | `SetIdentityPoolRoles`                                              | `Roles: {}`, `RoleMappings` keyed `cognito-idp.us-east-1.amazonaws.com/<poolId>:<adminClientId>`, `Type Rules`, `AmbiguousRoleResolution Deny`, rule `cognito:groups Contains starkeep-admins` → role                                                                                                                                                                                                                           | `GetIdentityPoolRoles`: equal                                  | none                                              |
| `AdminsGroup`, `UsersGroup`         | `CreateGroup` ×2                                                    | `starkeep-admins`, `starkeep-users`                                                                                                                                                                                                                                                                                                                                                                                             | (used by the users)                                            | none                                              |
| `AdminUser` + two group attachments | `AdminCreateUser`, `AdminAddUserToGroup` ×2, `AdminSetUserPassword` | as `apps/admin-web/src/routes/users.ts`: `email`, `email_verified true`, `DesiredDeliveryMediums [EMAIL]`, no `MessageAction`; both groups; `Permanent: false`                                                                                                                                                                                                                                                                  | `AdminGetUser`: `FORCE_CHANGE_PASSWORD`, `email_verified true` | none; `SUPPRESS` not needed                       |

Three more users were created with the same calls (one per code path in step 3, since each answers the challenge
once, and one `starkeep-users`-only member), and one through the `users.ts` `CREATE` route itself.

## Sign-in, per code path (step 3)

Each path signs in a fresh admin-created user (`FORCE_CHANGE_PASSWORD`) with its temporary password. The SDK
clients in admin-web and admin-installer are built with `{ region }` only, so they took the endpoint from
`AWS_ENDPOINT_URL=https://127.0.0.1:9297`; the device client took `endpoint: "https://127.0.0.1:9297/"`, which is
what `STARKEEP_COGNITO_ENDPOINT` sets in `apps/local-data-server/server.ts:770`. Node's `fetch` trusts the
emulator's certificate through the same `NODE_EXTRA_CA_CERTS` as the SDK.

| Code path                                                                                     | `USER_PASSWORD_AUTH` (temporary password)                    | `NEW_PASSWORD_REQUIRED` answer                               | After workaround (`AdminSetUserPassword Permanent: true`)       | `REFRESH_TOKEN_AUTH`                                                                                                | Other                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| admin-web `initiateAuth` / `respondNewPasswordChallenge` / `refreshTokens`                    | ok: `challengeName NEW_PASSWORD_REQUIRED`, session           | **failed**: 501 `NotImplemented` (SDK error)                 | `initiateAuth` → tokens, `expiresIn 3600`; user `CONFIRMED`     | ok: new ID token, refresh token echoed                                                                              | wrong password and unknown user → `NotAuthorizedException: Incorrect username or password.`                                                       |
| installer `cognitoPasswordAuthTokens` (region from the pool id)                               | ok (challenge reached, `promptNewPassword` called)           | **failed**: 501 `NotImplemented`, thrown to caller           | → `{ idToken, refreshToken }`                                   | the installer has no refresh function; its refresh token refreshed via admin-web `refreshTokens`: ok                | `regionFromUserPoolId` → `us-east-1`                                                                                                              |
| device `createCognitoClient({ endpoint })` `signIn` / `setNewPassword` / `refresh` / `revoke` | ok: `kind new-password-required`, session (unsigned `fetch`) | **failed**: `CognitoError` code `NotImplemented`, status 501 | `signIn` → `kind tokens`, `expiresIn 900`, ID `exp - iat = 900` | ok, refresh token echoed                                                                                            | `revoke` ok; refresh after revoke → `NotAuthorizedException: Refresh Token has been revoked` (400); wrong password → 400 `NotAuthorizedException` |
| app-client `auth/cognito.ts` `refreshTokens`                                                  | (not a sign-in path)                                         |                                                              |                                                                 | **cannot be pointed**: sent to `https://cognito-idp.us-east-1.amazonaws.com/` (line 59), stopped by the fetch guard | no endpoint parameter, no env seam                                                                                                                |

## Token verification (step 4)

Decoded facts (identical across runs apart from ids; from the run below):

| Claim / header   | admin-client ID token                                                                                                       | devices-client ID token | admin-client access token             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------- |
| `alg`            | `ES256`                                                                                                                     | `ES256`                 | `ES256`                               |
| `kid`            | one key per pool (e.g. `IMLflFfm4evO…`; another pool on the same emulator got a different one), present in that pool's JWKS | same                    | same                                  |
| `typ`            | `JWT`                                                                                                                       | `JWT`                   |                                       |
| `iss`            | `https://127.0.0.1:9297/<poolId>`                                                                                           | same                    | same                                  |
| `aud`            | the admin client id                                                                                                         | the devices client id   | (`client_id` = admin client)          |
| `token_use`      | `id`                                                                                                                        | `id`                    | `access`                              |
| `cognito:groups` | `["starkeep-admins","starkeep-users"]`                                                                                      | same                    | same                                  |
| `exp - iat`      | 3600 s                                                                                                                      | 900 s                   |                                       |
| other            | `email`, `cognito:username`, `auth_time`, `sub`; **no `email_verified`**                                                    | same                    | `scope aws.cognito.signin.user.admin` |

`verifyIdToken(idToken, { region: "us-east-1", userPoolId, userPoolClientId })` from
`packages/app-client/src/auth/verify.ts` returns **`null`**, and no `fetch` happens during the call. Replaying its
checks in order on the token:

| `verify.ts` line | Check                                                                                 | Emulator token                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 116–121          | three parts, header and payload decode                                                | pass                                                                                                     |
| **122**          | `header.alg !== "RS256"` → `return null`                                              | **fails here: `alg` is `ES256`**                                                                         |
| 43, 126          | JWKS from `https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json` | (not reached) would hit the public host                                                                  |
| 56–63            | keep `kty RSA` keys, import as `RSASSA-PKCS1-v1_5`                                    | (not reached) the emulator key is `kty EC`, `crv P-256`                                                  |
| 147              | `payload.iss === issuerFor(cfg)` (public host)                                        | (not reached) `https://127.0.0.1:9297/<poolId>` ≠ `https://cognito-idp.us-east-1.amazonaws.com/<poolId>` |
| 148–153          | `aud`, `token_use id`, `exp`, `sub`                                                   | (not reached) would pass                                                                                 |

The emulator side is sound: `GET https://127.0.0.1:9297/<poolId>/.well-known/jwks.json` (and the same path under
`iss`) returns one key, `kty EC`, `crv P-256`, `alg ES256`, `use sig`, with the token's `kid`. Imported with
`crypto.subtle.importKey("jwk", …, { name: "ECDSA", namedCurve: "P-256" })` and checked with
`crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSignature, headerDotPayload)`, both ID tokens
verify; the same token with `cognito:groups` altered does not. A verifier with the two changes below would accept
emulator tokens and still reject forged ones.

The cloud data server's verifier, `packages/admin-installer/builtin-apps/cloud-data-server/src/verify-user-token.ts`,
has the same shape (`alg !== "RS256"` at line 148, public-host issuer at line 81, JWKS from the issuer at line 85);
it was not run (it runs in Lambda, out of scope).

## Identity pool and S3 (step 5)

| Step                                                                               | Result                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| admin-web `getIdentityPoolCredentials` (admin ID token after refresh)              | ok: `GetId` + `GetCredentialsForIdentity`; `accessKeyId` `EMULATOR…` (20 chars, AWS: `ASIA…`), 40-char secret, 712-char session token, expires in 60 min                                                                                               |
| installer `getIdentityPoolCredentials`                                             | ok, same shape                                                                                                                                                                                                                                         |
| `GetCallerIdentity` with the vended keys                                           | `arn:aws:sts::000000000000:assumed-role/<prefix>-app-admin-role/CognitoIdentityCredentials` (the AWS shape: a session of the mapped role)                                                                                                              |
| S3 `PutObject` with vended keys, role has no policy                                | refused: `AccessDenied: User: …assumed-role/<prefix>-app-admin-role/CognitoIdentityCredentials is not authorized to perform: s3:PutObject … because no identity-based policy allows the s3:PutObject action` (403)                                     |
| … after `PutRolePolicy` allowing `s3:PutObject` on `arn:aws:s3:::<prefix>-files/*` | **ok, HTTP 200**: the vended keys are accepted as well-formed credentials                                                                                                                                                                              |
| … to `<prefix>-other` (outside the policy)                                         | refused, `AccessDenied` (403)                                                                                                                                                                                                                          |
| S3 `PutObject` with a made-up key pair (control)                                   | refused: `AccessDenied: Sign the request with the emulator credentials` (403)                                                                                                                                                                          |
| member (`starkeep-users` only) via admin-web                                       | refused locally before any call (`NOT_AN_ADMIN`, from `cognito:groups`)                                                                                                                                                                                |
| member token, `GetId` + `GetCredentialsForIdentity` direct                         | `GetCredentialsForIdentity` refused: `NotAuthorizedException: The ambiguous role mapping rules for: cognito-idp.us-east-1.amazonaws.com/<poolId> denied this request.` (AWS's behaviour)                                                               |
| devices-client token, `GetId` + `GetCredentialsForIdentity` direct                 | `GetId` **accepted** (AWS refuses here); `GetCredentialsForIdentity` refused with `InvalidIdentityPoolConfigurationException: Invalid identity pool configuration. Check assigned IAM roles for this pool.` (AWS: `NotAuthorizedException` at `GetId`) |

The `Logins` key the product code builds is `cognito-idp.<region>.amazonaws.com/<poolId>`
(`apps/admin-web/src/lib/cognito-auth.ts:172`, `packages/admin-installer/src/cognito-auth.ts:144`), the public
host, while the token's `iss` is the emulator's. The emulator matches the key against the configured provider name
and does not compare it with `iss`, so no seam is needed on this path.

## Seams

No product code was changed. What a test-only seam would need, per code path:

| Code path                                                                  | Needs a seam? | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| admin-web `lib/cognito-auth.ts`, `routes/users.ts`                         | no            | `AWS_ENDPOINT_URL` (SDK default) + `NODE_EXTRA_CA_CERTS`; `users.ts` reads the pool id from `$STARKEEP_DIR/config.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| admin-installer `cognito-auth.ts`                                          | no            | same                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| protocol-primitives `cognito-client.ts` (local data server)                | no, exists    | `endpoint` option, fed by `STARKEEP_COGNITO_ENDPOINT` (`https://127.0.0.1:<port>/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| app-client `auth/cognito.ts` (`refreshTokens`)                             | **yes**       | an endpoint override for the host at line 59, e.g. an optional `endpoint` on `PoolConfig`, as `createCognitoClient` has                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| app-client `auth/verify.ts` (and cloud-data-server `verify-user-token.ts`) | **yes**       | Either **(a)** issuer/JWKS host override plus ES256 acceptance: derive `issuerFor` (line 47) and `jwksUrl` (line 43) from the same optional `endpoint`, so `iss` must equal `<endpoint>/<poolId>`, and import `kty EC`/`crv P-256` keys as ECDSA and allow `alg ES256` only for a key that is EC (alg checked against the key, never taken from the token alone), enabled only when the override is set; or **(b)** an injected verifier: a test-only way to hand `verifyIdToken` its key lookup and expected issuer. (a) keeps every claim check running against emulator tokens and is the smaller change to review; (b) is simpler but leaves the production key path untested. Either way the override must be impossible to set in a deployed environment (an env var read only under a test flag, or a parameter no production caller passes). |

## Gaps found

- **`RespondToAuthChallenge` `NEW_PASSWORD_REQUIRED` is 501 `NotImplemented`** ([G-cog-mfa] scores the challenge
  state machine 0/15). The first-sign-in branch of all three code paths is untestable; tests must use
  `AdminSetUserPassword Permanent: true`.
- **Tokens are ES256, `iss` is the emulator endpoint** ([G-cog-es256], [G-cog-es256-2]). Every starkeep verifier
  rejects them at its `alg` check.
- **ID tokens omit `email_verified`.** Not read by starkeep-core.
- **Cognito admin APIs are not IAM-evaluated for identity-pool sessions**, while S3 is. A missing or wrong
  `cognito-idp:*` statement in the admin-app policy would pass on the emulator.
- **`GetId` accepts a token from a client the identity pool does not trust**; the refusal comes one call later and
  with `InvalidIdentityPoolConfigurationException` rather than `NotAuthorizedException`.
- **Vended keys are `EMULATOR…`, not `ASIA…`** ([G-cid-unbounded]). Code that inspects the prefix would differ;
  starkeep-core does not.
- **No invitation email.** `AdminCreateUser` without `SUPPRESS` succeeds and sends nothing; the invite template's
  rendering cannot be checked.
- **`UserPoolDomain` is control plane only** (Hosted UI / `oauth2/*` not emulated; out of scope).
- **CloudFormation cannot create any of this** ([G-cfn-cog1], [G-cfn-cog2]); the API path above is the only one.

## What this means for starkeep-core

- A CI job can run admin-web user management and admin sign-in against the emulator today with **no product code
  change**: env (`AWS_ENDPOINT_URL`, `NODE_EXTRA_CA_CERTS`, the emulator's credentials file, `STARKEEP_DIR`) and
  the existing `STARKEEP_COGNITO_ENDPOINT` seam are enough. Its pool setup is about 20 API calls (this spike's
  `pool` and `users` sections) and takes well under a second.
- Test setup must make every test user's password permanent; nothing on the emulator can cover the
  `NEW_PASSWORD_REQUIRED` answer. Keep the existing unit tests (fake fetch / `aws-sdk-client-mock`) for that branch.
- Anything that verifies a token (app-client session routes, the cloud data server) needs the verifier seam above
  before it can run on emulator tokens. That is one product change to two files, and the issue that makes it
  should decide (a) or (b).
- `app-client/src/auth/cognito.ts` needs an endpoint option before an app's cloud session refresh can run on the
  emulator.
- Do not treat a green emulator run as evidence about the admin-app role's Cognito permissions (finding 7). S3
  permissions of Cognito-vended sessions are evaluated in 1.0.322, so an S3 scoping test is possible, but that was
  not the subject here and needs its own check against [G-cid-session].
- For the epic: the bootstrap stack's Cognito outputs can be reproduced by this spike's API calls, so later
  experiments that need a "bootstrapped" deployment can reuse `cognito.mjs`'s `pool` section instead of
  CloudFormation.

## Reproduce

```bash
pnpm install                                   # at the repo root, once
bash spikes/aws-emulator/cognito/run.sh        # about 35 s; prints the summary and the table below
```

Options: `EMULATOR_VERSION` (pinned `1.0.322`, or `latest`), `EMULATOR_INSTALL` (`extract` | `apt`),
`EMULATOR_DATA_PORT` (default 9297). In a worktree whose main checkout is not writable, set
`TURBO_CACHE_DIR=$PWD/.turbo/cache`. See [the spike's README](../../spikes/aws-emulator/cognito/README.md).

## Per-step results

Sandbox run of `bash spikes/aws-emulator/cognito/run.sh`, 2026-11-12, emulator 1.0.322 (install 27.9 s, startup
0.26 s, driver 3.3 s). Outcome: **ok** = succeeded and matched AWS (for a refusal row: refused, as AWS does);
**differs** = succeeded but differs from AWS (or a starkeep seam is missing); **failed** = threw where AWS
succeeds. Rows marked "spike client" or "setup" use the spike's own SDK clients, never in place of a product
function; every other sign-in, verify, identity and route row calls the product function named. Tokens, passwords
and keys appear only as their shape. Summary line: `83 steps, 73 ok, 7 differ from AWS, 3 failed; 2190 ms in calls`.
`fetch()` calls seen by the fetch guard: 8 to `https://127.0.0.1:9297/` (device client), 2 to the emulator JWKS,
1 refused to `https://cognito-idp.us-east-1.amazonaws.com/` (app-client `refreshTokens`); none from `verifyIdToken`.

#### pool

| #   | Step                                                                                                            | Outcome | ms  | Result or exact emulator error                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------- | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | STS GetCallerIdentity (emulator key; account id for the domain prefix)                                          | ok      | 79  | Account 000000000000, Arn arn:aws:iam::000000000000:user/emulator                                                                                                        |
| 2   | CreateUserPool <prefix>-auth (template's properties)                                                            | ok      | 49  | Id us-east-1_3c48426a2, Arn arn:aws:cognito-idp:us-east-1:000000000000:userpool/us-east-1_3c48426a2                                                                      |
| 3   | DescribeUserPool: every template property read back                                                             | ok      | 5   | all match: tier ESSENTIALS, admin-create-only, invite template, email username/auto-verify/immutable+required, COGNITO_DEFAULT, password min 8 no Require\*, tags        |
| 4   | ListTagsForResource (pool ARN)                                                                                  | ok      | 7   | {"StackPrefix":"<prefix>","starkeep:managed":"true"}                                                                                                                     |
| 5   | CreateUserPoolClient <prefix>-admin                                                                             | ok      | 4   | ClientId 1ef7b81bff6c4d4a8f0c32dcc5                                                                                                                                      |
| 6   | CreateUserPoolClient <prefix>-devices                                                                           | ok      | 3   | ClientId dc7cb66c20584c438aa24eada4                                                                                                                                      |
| 7   | DescribeUserPoolClient admin: template properties read back                                                     | ok      | 3   | all match: no secret, ALLOW_USER_PASSWORD_AUTH+ALLOW_REFRESH_TOKEN_AUTH, refresh 30 days, revocation true, PreventUserExistenceErrors ENABLED                            |
| 8   | DescribeUserPoolClient devices: template properties read back                                                   | ok      | 2   | all match: no secret, ALLOW_USER_PASSWORD_AUTH+ALLOW_REFRESH_TOKEN_AUTH, refresh 3650 days, id/access 15/15 minutes, revocation true, PreventUserExistenceErrors ENABLED |
| 9   | CreateGroup starkeep-admins                                                                                     | ok      | 3   | GroupName starkeep-admins                                                                                                                                                |
| 10  | CreateGroup starkeep-users                                                                                      | ok      | 3   | GroupName starkeep-users                                                                                                                                                 |
| 11  | CreateUserPoolDomain <prefix>-<account> (ManagedLoginVersion 2; control plane only)                             | ok      | 2   | ManagedLoginVersion 2, CloudFrontDomain absent                                                                                                                           |
| 12  | DescribeUserPoolDomain                                                                                          | ok      | 2   | Status ACTIVE, CloudFrontDistribution da64c2b0432de4.cloudfront.net                                                                                                      |
| 13  | CreateIdentityPool <prefix>\_admin (provider cognito-idp.us-east-1.amazonaws.com/<poolId> for the admin client) | ok      | 47  | IdentityPoolId us-east-1:f15a9d6e-e46f-409d-870c-69645f4527c7                                                                                                            |
| 14  | DescribeIdentityPool: template properties read back                                                             | ok      | 6   | all match: unauthenticated false, 1 provider, ServerSideTokenCheck false                                                                                                 |
| 15  | IAM CreateRole <prefix>-app-admin-role (template trust policy and tags, no permission policy)                   | ok      | 52  | Arn arn:aws:iam::000000000000:role/<prefix>-app-admin-role                                                                                                               |
| 16  | SetIdentityPoolRoles Roles {} + rule cognito:groups Contains starkeep-admins → role, Deny                       | ok      | 3   | accepted                                                                                                                                                                 |
| 17  | GetIdentityPoolRoles: read back                                                                                 | ok      | 1   | Roles {}, RoleMappings as set                                                                                                                                            |

#### users

| #   | Step                                                                                                           | Outcome | ms  | Result or exact emulator error                                  |
| --- | -------------------------------------------------------------------------------------------------------------- | ------- | --- | --------------------------------------------------------------- |
| 18  | AdminCreateUser admin1 (users.ts input: email, email_verified, DesiredDeliveryMediums EMAIL, no MessageAction) | ok      | 2   | UserStatus FORCE_CHANGE_PASSWORD, Username a generated id (sub) |
| 19  | AdminAddUserToGroup admin1 → starkeep-admins                                                                   | ok      | 1   | added                                                           |
| 20  | AdminAddUserToGroup admin1 → starkeep-users                                                                    | ok      | 1   | added                                                           |
| 21  | AdminSetUserPassword admin1 Permanent false                                                                    | ok      | 2   | set                                                             |
| 22  | AdminGetUser admin1: status and attributes                                                                     | ok      | 1   | UserStatus FORCE_CHANGE_PASSWORD, email_verified true           |
| 23  | create installer (same calls, both groups)                                                                     | ok      | 6   | created, grouped, temporary password set                        |
| 24  | create device (same calls, both groups)                                                                        | ok      | 6   | created, grouped, temporary password set                        |
| 25  | create member (same calls, starkeep-users only)                                                                | ok      | 5   | created, grouped, temporary password set                        |

#### signin

| #   | Step                                                                                                   | Outcome     | ms  | Result or exact emulator error                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------ | ----------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 26  | admin-web initiateAuth (USER_PASSWORD_AUTH, temporary password)                                        | ok          | 56  | challengeName NEW_PASSWORD_REQUIRED, session <64 chars>                                                                                                               |
| 27  | admin-web respondNewPasswordChallenge (NEW_PASSWORD_REQUIRED)                                          | **failed**  | 47  | NotImplemented: operation RespondToAuthChallenge with ChallengeName=NEW_PASSWORD_REQUIRED is scaffolded but not implemented in this emulator; HTTP 501                |
| 28  | workaround: AdminSetUserPassword admin1 Permanent true (spike client)                                  | ok          | 2   | set; user CONFIRMED without answering the challenge                                                                                                                   |
| 29  | admin-web initiateAuth with the new password (after the workaround)                                    | ok          | 45  | idToken <JWT, 800 chars> (alg ES256), accessToken <JWT, 804 chars>, refreshToken <950 chars>, expiresIn 3600, id exp-iat 3600s                                        |
| 30  | admin-web refreshTokens (REFRESH_TOKEN_AUTH)                                                           | ok          | 48  | idToken <JWT, 800 chars> (alg ES256), accessToken <JWT, 804 chars>, refreshToken <950 chars>, expiresIn 3600, id exp-iat 3600s                                        |
| 31  | AdminGetUser admin1 after first sign-in                                                                | ok          | 6   | UserStatus CONFIRMED                                                                                                                                                  |
| 32  | admin-web initiateAuth, wrong password                                                                 | ok          | 56  | refused: NotAuthorizedException: Incorrect username or password.; HTTP 400                                                                                            |
| 33  | admin-web initiateAuth, unknown user (PreventUserExistenceErrors ENABLED)                              | ok          | 55  | refused: NotAuthorizedException: Incorrect username or password.; HTTP 400                                                                                            |
| 34  | SDK InitiateAuth request: is it SigV4-signed? (spike client, same SDK version)                         | ok          | 64  | unsigned (no Authorization header)                                                                                                                                    |
| 35  | installer regionFromUserPoolId(poolId)                                                                 | ok          | 0   | us-east-1                                                                                                                                                             |
| 36  | installer cognitoPasswordAuthTokens (USER_PASSWORD_AUTH → NEW_PASSWORD_REQUIRED via promptNewPassword) | **failed**  | 62  | NotImplemented: operation RespondToAuthChallenge with ChallengeName=NEW_PASSWORD_REQUIRED is scaffolded but not implemented in this emulator; HTTP 501                |
| 37  | workaround: AdminSetUserPassword installer Permanent true (spike client)                               | ok          | 5   | set; user CONFIRMED without answering the challenge                                                                                                                   |
| 38  | installer cognitoPasswordAuthTokens, new password (after the workaround)                               | ok          | 50  | idToken <JWT, 804 chars>, refreshToken <950 chars>                                                                                                                    |
| 39  | installer tokens: REFRESH_TOKEN_AUTH (installer has no refresh; admin-web refreshTokens on its token)  | ok          | 49  | idToken <JWT, 804 chars> (alg ES256), accessToken <JWT, 804 chars>, refreshToken <950 chars>, expiresIn 3600, id exp-iat 3600s                                        |
| 40  | device signIn (unsigned fetch InitiateAuth USER_PASSWORD_AUTH, endpoint seam)                          | ok          | 86  | kind new-password-required, session <64 chars>                                                                                                                        |
| 41  | device setNewPassword (unsigned RespondToAuthChallenge NEW_PASSWORD_REQUIRED)                          | **failed**  | 46  | CognitoError (NotImplemented): operation RespondToAuthChallenge with ChallengeName=NEW_PASSWORD_REQUIRED is scaffolded but not implemented in this emulator; HTTP 501 |
| 42  | workaround: AdminSetUserPassword device Permanent true (spike client)                                  | ok          | 2   | set; user CONFIRMED without answering the challenge                                                                                                                   |
| 43  | device signIn with the new password (after the workaround)                                             | ok          | 2   | idToken <JWT, 800 chars> (alg ES256), accessToken <JWT, 804 chars>, refreshToken <950 chars>, expiresIn 900, id exp-iat 900s                                          |
| 44  | device refresh (unsigned REFRESH_TOKEN_AUTH)                                                           | ok          | 1   | idToken <JWT, 800 chars> (alg ES256), accessToken <JWT, 804 chars>, refreshToken <950 chars>, expiresIn 900, id exp-iat 900s                                          |
| 45  | device idTokenClaims (decoded, unverified)                                                             | ok          | 0   | sub present, email = user, groups starkeep-admins,starkeep-users                                                                                                      |
| 46  | device revoke (unsigned RevokeToken)                                                                   | ok          | 1   | revoked                                                                                                                                                               |
| 47  | device refresh after revoke                                                                            | ok          | 1   | refused: CognitoError (NotAuthorizedException): Refresh Token has been revoked; HTTP 400                                                                              |
| 48  | device signIn, wrong password                                                                          | ok          | 1   | refused: CognitoError (NotAuthorizedException): Incorrect username or password.; HTTP 400                                                                             |
| 49  | app-client refreshTokens (no endpoint option): where does it send?                                     | **differs** | 0   | starkeep seam: no way to point it at the emulator \| https://cognito-idp.us-east-1.amazonaws.com/ (refused by guard)                                                  |

#### verify

| #   | Step                                                                  | Outcome     | ms  | Result or exact emulator error                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------- | ----------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 50  | decode admin-web ID token (admin client, after refresh)               | **differs** | 0   | email_verified (AWS includes it once the attribute is set): got absent, expected true \| alg ES256, kid IMLflFfm4evOskm9V2LXjiYN6Xwh-jw478tMYJIwAUQ, typ JWT, iss https://127.0.0.1:9297/us-east-1_3c48426a2, aud = admin client, token_use id, cognito:groups ["starkeep-admins","starkeep-users"], email present, email_verified undefined, cognito:username present, exp-iat 3600s, auth_time present                                                                                                 |
| 51  | decode device ID token (devices client)                               | **differs** | 0   | email_verified (AWS includes it once the attribute is set): got absent, expected true \| alg ES256, kid IMLflFfm4evOskm9V2LXjiYN6Xwh-jw478tMYJIwAUQ, typ JWT, iss https://127.0.0.1:9297/us-east-1_3c48426a2, aud = devices client, token_use id, cognito:groups ["starkeep-admins","starkeep-users"], email present, email_verified undefined, cognito:username present, exp-iat 900s, auth_time present                                                                                                |
| 52  | decode admin-web access token                                         | ok          | 0   | alg ES256, token_use access, client_id = admin client, iss https://127.0.0.1:9297/us-east-1_3c48426a2, cognito:groups ["starkeep-admins","starkeep-users"], scope aws.cognito.signin.user.admin                                                                                                                                                                                                                                                                                                          |
| 53  | app-client verifyIdToken(emulator ID token)                           | **differs** | 0   | returns null (an AWS-issued token verifies) \| result null; fetches during the call: none (no JWKS fetch)                                                                                                                                                                                                                                                                                                                                                                                                |
| 54  | where verifyIdToken stops: its checks replayed on the token, in order | ok          | 0   | three parts: true \| verify.ts:122 alg === "RS256": false (alg is ES256) → returns null here \| if reached: verify.ts:43 JWKS URL https://cognito-idp.us-east-1.amazonaws.com/<poolId>/.well-known/jwks.json (public host) \| if reached: verify.ts:56 keeps kty RSA only; emulator JWKS has kty EC \| if reached: verify.ts:147 iss === issuerFor(cfg): false (expects https://cognito-idp.us-east-1.amazonaws.com/<poolId>) \| if reached: verify.ts:148 aud === client: true; :149 token_use id: true |
| 55  | GET <endpoint>/<poolId>/.well-known/jwks.json                         | ok          | 4   | kty EC, crv P-256, alg ES256, use sig, kid = token kid                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 56  | GET <iss>/.well-known/jwks.json (the OIDC-conventional URL)           | ok          | 1   | HTTP 200, same document: true                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 57  | crypto.subtle ES256 verify of the admin ID token with the JWKS key    | ok          | 1   | verified: true (ECDSA P-256, SHA-256, raw r\|\|s signature)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 58  | crypto.subtle ES256 verify of the device ID token                     | ok          | 0   | verified: true                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 59  | crypto.subtle ES256 verify, payload altered (control)                 | ok          | 0   | verified: false                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

#### identity

| #   | Step                                                                                                   | Outcome     | ms  | Result or exact emulator error                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------ | ----------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 60  | admin-web getIdentityPoolCredentials (GetId + GetCredentialsForIdentity)                               | **differs** | 53  | AccessKeyId prefix ASIA: got false, expected true \| accessKeyId EMULATOR… (20 chars), secret <40 chars>, sessionToken <712 chars>, expires in 60 min                                                                                                                                                      |
| 61  | installer getIdentityPoolCredentials                                                                   | **differs** | 47  | AccessKeyId prefix ASIA: got false, expected true \| accessKeyId EMULATOR… (20 chars)                                                                                                                                                                                                                      |
| 62  | STS GetCallerIdentity with the vended keys (whose session is it?)                                      | ok          | 45  | Arn arn:aws:sts::000000000000:assumed-role/<prefix>-app-admin-role/CognitoIdentityCredentials                                                                                                                                                                                                              |
| 63  | S3 CreateBucket <prefix>-files (emulator key, setup)                                                   | ok          | 55  | <prefix>-files                                                                                                                                                                                                                                                                                             |
| 64  | S3 CreateBucket <prefix>-other (emulator key, setup)                                                   | ok          | 5   | <prefix>-other                                                                                                                                                                                                                                                                                             |
| 65  | S3 PutObject with the vended keys, role has no policy yet                                              | ok          | 56  | refused: AccessDenied: User: arn:aws:sts::000000000000:assumed-role/<prefix>-app-admin-role/CognitoIdentityCredentials is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::<prefix>-files/spike/no-policy.txt" because no identity-based policy allows the s3:PutObject action; HTTP 403 |
| 66  | IAM PutRolePolicy: s3:PutObject on <prefix>-files/\* only (setup)                                      | ok          | 6   | attached                                                                                                                                                                                                                                                                                                   |
| 67  | S3 PutObject with the vended keys, policy allows it                                                    | ok          | 6   | HTTP 200, ETag "dd54a4bffc52cc215acbf78fe9ab8d28"                                                                                                                                                                                                                                                          |
| 68  | S3 PutObject with the vended keys to <prefix>-other (outside the policy; control)                      | ok          | 5   | refused: AccessDenied: User: arn:aws:sts::000000000000:assumed-role/<prefix>-app-admin-role/CognitoIdentityCredentials is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::<prefix>-other/spike/vended.txt" because no identity-based policy allows the s3:PutObject action; HTTP 403    |
| 69  | S3 PutObject with a made-up key pair (control)                                                         | ok          | 50  | refused: AccessDenied: Sign the request with the emulator credentials; HTTP 403                                                                                                                                                                                                                            |
| 70  | GetId + GetCredentialsForIdentity with a devices-client ID token (pool trusts the admin client only)   | **differs** | 6   | refused, but with InvalidIdentityPoolConfigurationException; AWS answers NotAuthorizedException \| refused: InvalidIdentityPoolConfigurationException: at GetCredentialsForIdentity: Invalid identity pool configuration. Check assigned IAM roles for this pool.; HTTP 400                                |
| 71  | admin-web getIdentityPoolCredentials, starkeep-users-only member                                       | ok          | 0   | refused: Error: This account has no admin rights on this cloud. Ask an admin to make you one.                                                                                                                                                                                                              |
| 72  | GetId + GetCredentialsForIdentity direct, member token (no rule matches, AmbiguousRoleResolution Deny) | ok          | 3   | refused: NotAuthorizedException: at GetCredentialsForIdentity: The ambiguous role mapping rules for: cognito-idp.us-east-1.amazonaws.com/us-east-1_3c48426a2 denied this request.; HTTP 400                                                                                                                |

#### routes

| #   | Step                                                                                             | Outcome | ms  | Result or exact emulator error                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------ | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 73  | users.ts LIST                                                                                    | ok      | 58  | 4 users: admin1(CONFIRMED,admin,data) device(CONFIRMED,admin,data) installer(CONFIRMED,admin,data) member(CONFIRMED,data)                                     |
| 74  | users.ts CREATE {email, data} (AdminCreateUser without MessageAction: Cognito emails the invite) | ok      | 96  | 5 users: admin1(CONFIRMED,admin,data) device(CONFIRMED,admin,data) installer(CONFIRMED,admin,data) invitee(FORCE_CHANGE_PASSWORD,data) member(CONFIRMED,data) |
| 75  | users.ts SET_GROUP invitee → starkeep-admins                                                     | ok      | 92  | admin                                                                                                                                                         |
| 76  | users.ts RESET_PASSWORD invitee (AdminSetUserPassword Permanent false)                           | ok      | 100 | temporaryPassword <16 chars>, status FORCE_CHANGE_PASSWORD                                                                                                    |
| 77  | admin-web initiateAuth with the route's temporary password                                       | ok      | 48  | challengeName NEW_PASSWORD_REQUIRED                                                                                                                           |
| 78  | users.ts SIGN_OUT_EVERYWHERE installer (AdminUserGlobalSignOut)                                  | ok      | 95  | signed out                                                                                                                                                    |
| 79  | admin-web refreshTokens with installer's refresh token after global sign-out                     | ok      | 44  | refused: NotAuthorizedException: Refresh Token has been revoked; HTTP 400                                                                                     |
| 80  | users.ts SET_ENABLED invitee false (AdminDisableUser + AdminUserGlobalSignOut)                   | ok      | 96  | disabled                                                                                                                                                      |
| 81  | admin-web initiateAuth as the disabled invitee                                                   | ok      | 47  | refused: NotAuthorizedException: User is disabled.; HTTP 400                                                                                                  |
| 82  | users.ts SET_ENABLED invitee true                                                                | ok      | 99  | enabled                                                                                                                                                       |
| 83  | users.ts SET_GROUP admin1 out of starkeep-admins (others remain, so allowed)                     | ok      | 92  | removed                                                                                                                                                       |

[G-cog-es256]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T124858Z-cognito-idp-5-net-new-causes-tokens-are.md
[G-cog-es256-2]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T010846Z-cognito-identity-cognito-idp-user-pool-id-tokens.md
[G-cog-mfa]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T182116Z-cognito-idp-mfa-challenge-state-machine-mfa-setup.md
[G-cid-unbounded]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261026T054328Z-cognito-identity-4-net-new-root-causes-a.md
[G-cid-session]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261025T005354Z-cognito-identity-s3-the-cognito-vended-session-is.md
[G-cfn-cog1]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261024T114943Z-cognito-idp-cloudformation-provisioned-user-pools-app-clients.md
[G-cfn-cog2]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T124858Z-cloudformation-cognito-idp-4-net-new-causes-cfn.md
