# aws-emulator coverage matrix for starkeep-core

Issue: AI-680 (epic AI-678, wave 1). Desk research only: nothing was installed or run against
the emulator, and no starkeep-core source file was changed.

**Emulator version assessed:** `v1.0.322` (commit `7753983c6e495ec3612695b1336bf4936fc7b7fd`,
released 2026-11-11 00:32 UTC). All "source" claims below refer to that commit; all issue links
point at the `v1.0.322` tag. The emulator releases several times a day, so re-check any row
before relying on it.

## Findings first

1. **Every AWS API operation starkeep-core calls has a real handler in the emulator.** None of
   the ~120 operations found is a 501 scaffold stub. (The one Cognito operation that is still a
   stub, `GetSigningCertificate`, is not one starkeep-core calls.) The gaps are behavioural, not
   missing APIs.
2. **The cloud-data-server path cannot run end to end on the emulator, for three independent
   reasons.**
   - Aurora DSQL is emulated as a control plane only. No PostgreSQL listener sits behind the
     cluster endpoint ([G-dsql]).
   - Lambda runs Node handlers in an in-process QuickJS engine with no `net`, `http`, `https`
     or `tls` module, so `pg` cannot connect from inside a function (source:
     `services/service-com-amazonaws-lambda-awsgirapiservice/src/state/execution/node.rs`,
     `node/core_modules.rs`).
   - Cognito tokens are signed **ES256**, while both starkeep-core verifiers accept only
     **RS256** (`packages/app-client/src/auth/verify.ts:122`,
     `packages/admin-installer/builtin-apps/cloud-data-server/src/verify-user-token.ts:148`).
3. **The bootstrap CloudFormation stack would "succeed" without creating its user pool.**
   `AWS::Cognito::UserPool`, `UserPoolClient`, `UserPoolDomain`, `UserPoolUser` and
   `UserPoolUserToGroupAttachment` have no provisioner in the emulator's CloudFormation
   service. They are left _declared-only_: nothing is created in Cognito, and `Ref` returns a
   CloudFormation-style name instead of a pool or client id ([G-cfn-cog1], [G-cfn-cog2],
   [G-cfn-cogref]).
4. **The best experiment targets are the SDK-level S3, SSM, STS, IAM and Cognito
   user-management paths.** Their per-operation fidelity scores run from 80 to 100% (see
   [per-operation matrix](#per-operation-matrix)), and the AWS SDK
   v3 already reads `AWS_ENDPOINT_URL`.
5. **Two structural mismatches apply to every path.**
   - **One Region per emulator.** The user guide says "Use one Region for all your requests.
     To test several Regions, run one emulator for each Region"
     ([point-sdk-to-emulator][ug-point]). The cloud-data-server program creates a second
     `us-east-1` provider for ACM, CloudFront and CUR
     (`packages/admin-installer/src/builtin-programs/cloud-data-server-program.ts:1171`).
   - **Hard-coded endpoints.** Several starkeep-core files build AWS URLs directly, so
     `AWS_ENDPOINT_URL` does not reach them:
     - `packages/app-client/src/auth/cognito.ts:59`
     - `packages/app-client/src/auth/verify.ts:43`
     - `packages/admin-installer/builtin-apps/cloud-data-server/src/verify-user-token.ts:85`
     - `packages/admin-installer/builtin-apps/cloud-data-server/src/sign-in-routes.ts:240,297`
       (the configured Cognito domain, `<prefix>.auth.<region>.amazoncognito.com`, which the
       emulator does not serve)
6. **The emulator's own documentation rules out using it to test IAM policies.** "Don't use the
   emulator to test … IAM policies and permissions boundaries … The emulator never denies a
   request signed with its own key" ([security][ug-security]). `packages/iam-permission-tests`
   and the permission-boundary design cannot be validated on it.

## Summary table: code path → services → verdict

| Code path                                                                                                                                               | Services                                                                       | Verdict                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage adapter (`packages/storage-s3`) incl. presigned GET/PUT and multipart                                                                           | S3                                                                             | **Likely works.** All ops implemented, 81–100% step pass rate (CompleteMultipartUpload 50%). Path-style addressing is automatic on `127.0.0.1`.                                                                                                                               |
| Static assets / admin-web S3 (`static-assets.ts`, `apps/admin-web/src/lib/s3.ts`, `src/s3.ts`)                                                          | S3                                                                             | **Likely works.**                                                                                                                                                                                                                                                             |
| App credentials, Pulumi passphrase, mobile keys (`app-creds.ts`, `pulumi-passphrase.ts`, `mobile-keys.ts`, `app-client/credentials.ts`)                 | SSM Parameter Store (String + SecureString)                                    | **Likely works.** All four ops implemented; open gaps are error wording and metadata members ([G-ssm-sem], [G-ssm-err]).                                                                                                                                                      |
| Installer IAM role management (`iam.ts`, `iam-diagnostics.ts`, `session.ts`)                                                                            | IAM, STS                                                                       | **Works for function, not for policy correctness.** Ops implemented; policy docs returned un-encoded ([G-iam-raw]); session tags / `aws:PrincipalTag` conditions have open gaps ([G-sts-tags], [G-sts-sesspol]). Security testing is out of scope by the emulator's own docs. |
| Admin console user management (`apps/admin-web/src/routes/users.ts`, `e2e-aws/src/admin-user.ts`)                                                       | Cognito user pools                                                             | **Likely works** against a pool created through the API (not CloudFormation). Admin\* ops 100% step pass.                                                                                                                                                                     |
| Admin sign-in (`apps/admin-web/src/lib/cognito-auth.ts`, `admin-installer/src/cognito-auth.ts`)                                                         | Cognito user pools + identity pools                                            | **Partly works.** `USER_PASSWORD_AUTH`, `NEW_PASSWORD_REQUIRED` and `REFRESH_TOKEN_AUTH` are implemented. `RespondToAuthChallenge` scores 0/15 steps. `GetCredentialsForIdentity` vends non-ASIA keys and has role-mapping gaps ([G-cid-unbounded], [G-cid-session]).         |
| App sign-in clients (`app-sign-in-clients.ts`)                                                                                                          | Cognito (app clients, managed-login branding)                                  | **Likely works** (control plane).                                                                                                                                                                                                                                             |
| App/device session token verify (`app-client/src/auth/*`, `protocol-primitives/.../cognito-client.ts`, `verify-user-token.ts`)                          | Cognito JWT + JWKS                                                             | **Does not work as written.** JWKS is served, but tokens are ES256 and `iss` is the emulator endpoint; verifiers require RS256 and the public `cognito-idp.<region>.amazonaws.com` issuer ([G-cog-es256]).                                                                    |
| Hosted-UI sign-in routes (`cloud-data-server/src/sign-in-routes.ts`)                                                                                    | Cognito `/oauth2/authorize`, `/oauth2/token`                                   | **Not emulated.** No handler for the OAuth2 endpoints in the Cognito service.                                                                                                                                                                                                 |
| Bootstrap stack (`aws-bootstrap` template, `e2e-aws/src/bootstrap-stack.ts`, `scripts/update-bootstrap.sh`)                                             | CloudFormation, Cognito, IAM, S3                                               | **Does not work.** Stack operations exist, but the 5 user-pool resource types are declared-only and Ref returns names, so the identity pool and every output that names the pool are wrong.                                                                                   |
| Per-app compute stack (`pulumi-program.ts`, `compute-stack.ts`)                                                                                         | Pulumi → Lambda, CloudWatch Logs, API GW v2, S3 state backend                  | **Worth an experiment.** All control-plane ops implemented. Pulumi provider exposes `endpoints`, `skipCredentialsValidation`, `skipRequestingAccountId`, `s3UsePathStyle`, `insecure`, `customCaBundle`. Lambda execution is QuickJS, not Node.                               |
| Cloud data server program (`cloud-data-server-program.ts`, `api-handler.ts`)                                                                            | DSQL, Lambda, API GW v2, CloudFront, ACM, Route 53, CUR, S3, Logs              | **Does not work end to end.** No DSQL data plane, no sockets in Lambda, JWT authorizer issuer/alg mismatch, two Regions, CloudFront OAC/TrustedKeyGroups edge gaps.                                                                                                           |
| DSQL schema/DDL & registry (`storage-aurora-dsql`, `registry.ts`, `dsql-ddl.ts`, `dsql-schema-init.ts`, `installer-dsql.ts`, `scripts/debug-dsql-*.ts`) | DSQL data plane (PostgreSQL wire + IAM token)                                  | **Not emulated** ([G-dsql]). Keep PGlite.                                                                                                                                                                                                                                     |
| Custom domain (`custom-domain.ts`, `routes/custom-domain.ts`, `e2e-aws-custom-domain/src/zone.ts`, `scripts/setup-e2e-dns-zone.sh`)                     | ACM, Route 53, CloudFront                                                      | **Control plane only.** Route 53 works. ACM DNS-validated certs never reach `ISSUED` ([G-acm-settle], [G-acm-dns]). CloudFront edge gaps.                                                                                                                                     |
| Billing (`builtin-installs.ts` CUR teardown, `apps/admin-web/src/lib/cost-usage-report.ts`)                                                             | CUR, S3, STS                                                                   | **Control plane only.** Report definitions CRUD exist; no report files are ever delivered to S3, so `cost-usage-report.ts` has nothing to read.                                                                                                                               |
| Teardown scripts (`scripts/teardown-*.sh`)                                                                                                              | IAM, Lambda, Logs, S3, SSM, DSQL, API GW v2, CUR, ACM, CloudFormation, Cognito | **Mostly works** at API level; relies on resources the previous rows could not create.                                                                                                                                                                                        |

## Per-operation matrix

Rating legend: **S** = supported (handler implemented, no open gap found that touches how
starkeep-core uses it); **G** = supported with known gap (cited); **501** = stubbed;
**N** = service or feature not emulated; **?** = unknown. "Steps" is the per-operation pass rate
over fidelity-test steps in `scores.json.gz` for v1.0.322 (see
[method](#method-and-exact-commands)); a blank means the operation had no scored step.

### S3 (`service-com-amazonaws-s3-amazons3`, 112 ops, 4 stubs)

| Operation                              | Called from                                                                                                   | Rating | Steps   | Evidence                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| HeadBucket                             | `storage-s3/src/adapter.ts`; teardown scripts                                                                 | S      | 29/30   |                                                                                                                              |
| PutObject                              | `storage-s3`, `static-assets.ts`, `admin-installer/src/s3.ts`, `admin-web/lib/s3.ts`                          | S      | 216/222 |                                                                                                                              |
| GetObject                              | `storage-s3`, `static-assets.ts`, `admin-web/lib/s3.ts`, `cost-usage-report.ts`                               | G      | 125/155 | [G-s3-read]                                                                                                                  |
| HeadObject                             | `storage-s3`                                                                                                  | G      | 54/56   | [G-s3-read]                                                                                                                  |
| PutObjectTagging                       | `storage-s3`                                                                                                  | S      | 8/9     |                                                                                                                              |
| GetObjectTagging                       | `e2e-aws/src/journey.ts`                                                                                      | S      | 12/15   |                                                                                                                              |
| RestoreObject                          | `storage-s3`                                                                                                  | S      | 3/3     |                                                                                                                              |
| DeleteObject                           | `storage-s3`; `teardown-cloud-data-server.sh`                                                                 | G      | 175/177 | [G-s3-del]                                                                                                                   |
| DeleteObjects                          | `static-assets.ts`, `admin-installer/src/s3.ts`, `scripts/clear-user-cloud-data.ts`, `cutover-clear-cloud.ts` | G      | 44/50   | [G-s3-read]                                                                                                                  |
| ListObjectsV2                          | many (`storage-s3`, `static-assets.ts`, `compute-stack.ts`, `journey.ts`, scripts)                            | G      | 114/119 | [G-s3-list]                                                                                                                  |
| CreateMultipartUpload                  | `storage-s3`                                                                                                  | S      | 9/9     |                                                                                                                              |
| UploadPart (incl. presigned)           | `storage-s3`                                                                                                  | G      | 6/6     | [G-s3-crc64] (only for CRC64NVME checksums)                                                                                  |
| CompleteMultipartUpload                | `storage-s3`                                                                                                  | G      | 4/8     | [G-s3-urls] (`Location` names the real S3 host)                                                                              |
| GetBucketAccelerateConfiguration       | `compute-stack.ts`                                                                                            | S      | 5/5     |                                                                                                                              |
| DeleteBucket                           | `builtin-installs.ts`; teardown scripts                                                                       | G      | 382/383 | [G-s3-del]                                                                                                                   |
| DeleteBucketPolicy                     | `teardown-cloud-data-server.sh`                                                                               | S      | 7/7     |                                                                                                                              |
| Presigned URL (`s3-request-presigner`) | `storage-s3` `getSignedUrl` (GET/PUT/UploadPart)                                                              | ?      |         | Client-side signing; whether the emulator accepts query-string SigV4 for S3 was not confirmed from source. Wave-2 must test. |

### Cognito user pools (`service-com-amazonaws-cognitoidentityprovider-…`, 133 ops, 7 stubs)

| Operation                                               | Called from                                                                                                                                               | Rating | Steps             | Evidence                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| InitiateAuth `USER_PASSWORD_AUTH`                       | `admin-web/lib/cognito-auth.ts`, `admin-installer/src/cognito-auth.ts`, `protocol-primitives/.../cognito-client.ts`, `cli-uninstall-cloud-data-server.ts` | G      | 17/34             | [G-cog-es256], [G-cog-refresh]                                                                                   |
| InitiateAuth `REFRESH_TOKEN_AUTH`                       | `admin-web/lib/cognito-auth.ts`, `app-client/src/auth/cognito.ts`, `protocol-primitives`                                                                  | G      | (above)           | [G-cog-es256] (501 for a disabled user), [G-cog-refresh]                                                         |
| RespondToAuthChallenge `NEW_PASSWORD_REQUIRED`          | same as USER_PASSWORD_AUTH callers                                                                                                                        | G      | 0/15              | [G-cog-mfa]; 10 of 15 steps blocked upstream                                                                     |
| AdminInitiateAuth `ADMIN_USER_PASSWORD_AUTH`            | `e2e-aws/src/cloud-app-session.ts`                                                                                                                        | G      | 22/29             | [G-cog-refresh], [G-cog-es256-2]                                                                                 |
| RevokeToken                                             | `protocol-primitives/.../cognito-client.ts`                                                                                                               | S      | 5/6               |                                                                                                                  |
| DescribeUserPool                                        | `admin-web/routes/cognito-outputs.ts`                                                                                                                     | G      | 43/46             | [G-cog-read]                                                                                                     |
| ListUserPoolClients                                     | `cognito-outputs.ts`, `app-sign-in-clients.ts`                                                                                                            | S      | 13/13             |                                                                                                                  |
| DescribeUserPoolClient                                  | `app-sign-in-clients.ts`                                                                                                                                  | G      | 22/25             | [G-cog-read]                                                                                                     |
| CreateUserPoolClient                                    | `app-sign-in-clients.ts`                                                                                                                                  | S      | 120/120           |                                                                                                                  |
| UpdateUserPoolClient                                    | `app-sign-in-clients.ts`                                                                                                                                  | S      | 5/8               |                                                                                                                  |
| CreateManagedLoginBranding                              | `app-sign-in-clients.ts`                                                                                                                                  | S      | 7/8               |                                                                                                                  |
| DescribeManagedLoginBrandingByClient                    | `app-sign-in-clients.ts`                                                                                                                                  | S      | 3/4               |                                                                                                                  |
| UpdateManagedLoginBranding                              | `app-sign-in-clients.ts`                                                                                                                                  | S      | 3/3               |                                                                                                                  |
| AdminCreateUser                                         | `admin-web/routes/users.ts`, `e2e-aws/src/admin-user.ts`, `member-steps.ts`                                                                               | S      | 80/80             |                                                                                                                  |
| AdminSetUserPassword                                    | `users.ts`, `admin-user.ts`                                                                                                                               | S      | 52/52             |                                                                                                                  |
| AdminAddUserToGroup / AdminRemoveUserFromGroup          | `users.ts`, `admin-user.ts`                                                                                                                               | S      | 6/6, 5/5          |                                                                                                                  |
| AdminDisableUser / AdminEnableUser                      | `users.ts`                                                                                                                                                | S      | 3/3, 3/3          |                                                                                                                  |
| AdminUserGlobalSignOut                                  | `users.ts`                                                                                                                                                | S      | 3/3               |                                                                                                                  |
| ListUsers / ListUsersInGroup                            | `users.ts`, `scripts/clear-user-cloud-data.ts`                                                                                                            | S      | 9/9, 6/6          |                                                                                                                  |
| AdminGetUser / AdminDeleteUser / AdminListGroupsForUser | `e2e-aws`, `clear-user-cloud-data.ts`                                                                                                                     | S      | 37/37, 49/49, 7/7 |                                                                                                                  |
| UpdateUserPool / DeleteUserPool (CLI)                   | `scripts/teardown-bootstrap.sh`                                                                                                                           | S      | 17/19, 189/189    |                                                                                                                  |
| JWKS `/<pool>/.well-known/jwks.json`                    | `app-client/src/auth/verify.ts`, `verify-user-token.ts`, API GW JWT authorizer                                                                            | G      |                   | Served (source `service.rs`), but keys are ES256/P-256 and `iss` is the endpoint the caller used ([G-cog-es256]) |
| Hosted UI / `/oauth2/authorize`, `/oauth2/token`        | `cloud-data-server/src/sign-in-routes.ts`                                                                                                                 | N      |                   | No route in the Cognito service; `service.rs` only special-cases `jwks.json` and the classic-UI logo             |

### Cognito identity pools (`service-com-amazonaws-cognitoidentity-…`, 24 ops, 0 stubs)

| Operation                 | Called from                                                                                                  | Rating | Steps | Evidence                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ | ----- | ----------------------------------------------- |
| GetId                     | `admin-web/lib/cognito-auth.ts`, `admin-installer/src/cognito-auth.ts`, `cli-uninstall-cloud-data-server.ts` | S      | 23/23 |                                                 |
| GetCredentialsForIdentity | same                                                                                                         | G      | 5/10  | [G-cid-unbounded], [G-cid-session], [G-cid-sst] |
| DeleteIdentityPool (CLI)  | `teardown-bootstrap.sh`                                                                                      | S      | 69/69 |                                                 |

### SSM (`service-com-amazonaws-ssm-amazonssm`, 153 ops, 96 stubs; none we call)

| Operation           | Called from                                                                                                                                   | Rating | Steps | Evidence                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- | ------------------------------------------------ |
| GetParameter        | `app-client/src/credentials.ts`, `app-creds.ts`, `pulumi-passphrase.ts`, `compute-stack.ts`, `api-handler.ts`, `mobile-keys.ts`, `journey.ts` | G      | 15/17 | [G-ssm-sem], [G-ssm-err]                         |
| PutParameter        | `app-creds.ts`, `pulumi-passphrase.ts`, `mobile-keys.ts`                                                                                      | G      | 27/27 | [G-ssm-sem]                                      |
| DeleteParameter     | `app-creds.ts`, `cutover-clear-cloud.ts`, teardown scripts                                                                                    | G      | 12/13 | [G-ssm-err]                                      |
| GetParametersByPath | `cutover-clear-cloud.ts`, `teardown-bootstrap.sh`                                                                                             | G      | 8/12  | [G-ssm-sem] (pagination tokens, hierarchy depth) |

### STS (`service-com-amazonaws-sts-…`, 12 ops, 3 stubs)

| Operation         | Called from                                                                                                                   | Rating | Steps | Evidence                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | ----- | ------------------------------------------- |
| AssumeRole        | `admin-installer/src/session.ts`, `api-handler.ts` (with session `Tags`), `scripts/debug-dsql-*.ts`, `recreate-*`, `reship-*` | G      | 4/6   | [G-sts-tags], [G-sts-sesspol], [G-sts-asia] |
| GetCallerIdentity | `cost-usage-report.ts`, `iam-diagnostics.ts`, `scripts/cli-*.ts`, every teardown script                                       | S      | 7/7   | Returns account `000000000000` ([ug-point]) |

### IAM (`service-com-amazonaws-iam-…`, 175 ops, 18 stubs; none we call)

| Operation                                                                                         | Called from                                                                          | Rating           | Steps                           | Evidence                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| CreateRole                                                                                        | `admin-installer/src/iam.ts`, `iam-permission-tests/src/sdk-trace.ts`                | G                | 43/53                           | [G-iam-malformed]                                                                         |
| GetRole                                                                                           | `iam.ts`, `iam-diagnostics.ts`, teardown scripts                                     | G                | 21/38                           | [G-iam-raw], [G-iam-getdeleted]                                                           |
| DeleteRole                                                                                        | `iam.ts`, teardown scripts                                                           | S                | 56/56                           |                                                                                           |
| PutRolePolicy                                                                                     | `iam.ts`, `scripts/debug-dsql-*.ts`                                                  | G                | 27/27                           | [G-iam-malformed]                                                                         |
| GetRolePolicy                                                                                     | `iam.ts`                                                                             | G                | 5/16                            | [G-iam-raw] (document not URL-encoded on the Query wire)                                  |
| DeleteRolePolicy                                                                                  | `iam.ts`, scripts, teardown scripts                                                  | G                | 21/21                           | [G-iam-delpol]                                                                            |
| ListRolePolicies                                                                                  | `iam.ts`, `iam-diagnostics.ts`, teardown scripts                                     | S                | 19/19                           |                                                                                           |
| UpdateAssumeRolePolicy                                                                            | `iam.ts`                                                                             | G                | 3/5                             | [G-iam-malformed]                                                                         |
| ListAttachedRolePolicies                                                                          | `iam-diagnostics.ts`, teardown scripts                                               | S                | 28/30                           |                                                                                           |
| DeleteRolePermissionsBoundary (CLI)                                                               | teardown scripts                                                                     | S                | 4/4                             |                                                                                           |
| DetachRolePolicy (CLI)                                                                            | teardown scripts                                                                     | S                | 33/33                           |                                                                                           |
| GetPolicy / ListEntitiesForPolicy / ListPolicyVersions / DeletePolicyVersion / DeletePolicy (CLI) | `teardown-bootstrap.sh`                                                              | S                | 11/17, 9/9, 12/12, 15/15, 28/29 |                                                                                           |
| ListRoles (CLI)                                                                                   | `teardown-bootstrap.sh`                                                              | G                | 5/10                            | [G-iam-raw]                                                                               |
| IAM policy evaluation (boundaries, `aws:PrincipalTag`)                                            | permission boundaries in `aws-bootstrap`, `temp-policies.ts`, `iam-permission-tests` | N (for security) |                                 | [ug-security]: "Don't use the emulator to test … IAM policies and permissions boundaries" |

### Aurora DSQL (`service-com-amazonaws-dsql-dsql`, 17 ops, 0 stubs)

| Operation / feature                               | Called from                                                                                                                       | Rating          | Steps           | Evidence                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------- | ---------------------------------------------- |
| CreateCluster (via Pulumi `aws.dsql.Cluster`)     | `cloud-data-server-program.ts`                                                                                                    | G               | 8/11            | [G-dsql] (endpoint published, nothing listens) |
| GetCluster / `dsql wait` (CLI)                    | `teardown-cloud-data-server.sh`                                                                                                   | S               | 19/23           |                                                |
| TagResource / UpdateCluster / DeleteCluster (CLI) | `teardown-cloud-data-server.sh`                                                                                                   | S               | 1/3, 5/7, 11/11 |                                                |
| `DsqlSigner.getDbConnect[Admin]AuthToken`         | `registry.ts`, `installer-dsql.ts`, `dsql-ddl.ts`, `dsql-schema-init.ts`, `api-handler.ts`, `e2e-aws/.../connect.ts`, `scripts/*` | S (client-side) |                 | Presigning needs no server ([G-dsql] says so)  |
| PostgreSQL wire connection with IAM token         | `storage-aurora-dsql` (via `pg`), everything above                                                                                | **N**           |                 | [G-dsql], [G-dsql-2], [G-dsql-3]               |

### Lambda (`service-com-amazonaws-lambda-awsgirapiservice`, 89 ops, 5 stubs)

| Operation                                  | Called from                                         | Rating | Steps   | Evidence                                                                                                     |
| ------------------------------------------ | --------------------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------ |
| CreateFunction (Pulumi, `nodejs22.x`)      | `pulumi-program.ts`, `cloud-data-server-program.ts` | G      | 131/151 | [G-lambda-role] (accepts a non-existent role)                                                                |
| AddPermission (Pulumi `lambda.Permission`) | same                                                | G      | 34/35   | [G-lambda-perm]                                                                                              |
| GetFunctionConfiguration                   | `e2e-aws/src/journey.ts`                            | S      | 151/180 |                                                                                                              |
| GetFunction (CLI)                          | `teardown-cloud-apps.sh`                            | G      | 31/45   | [G-lambda-codeloc]                                                                                           |
| ListFunctions (CLI)                        | teardown scripts                                    | S      | 11/12   |                                                                                                              |
| DeleteFunction                             | `builtin-installs.ts`, teardown scripts             | S      | 137/139 |                                                                                                              |
| Invoke (via API GW integration)            | every deployed app handler                          | G      | 41/45   | QuickJS in-process, no `net`/`http`/`https`/`tls` (source `state/execution/node.rs`, `node/core_modules.rs`) |

### CloudWatch Logs (`service-com-amazonaws-cloudwatchlogs-logs-20140328`, 119 ops, 5 stubs)

| Operation                                     | Called from                                         | Rating | Steps   | Evidence      |
| --------------------------------------------- | --------------------------------------------------- | ------ | ------- | ------------- |
| CreateLogGroup (Pulumi `cloudwatch.LogGroup`) | `pulumi-program.ts`, `cloud-data-server-program.ts` | S      | 113/113 |               |
| PutRetentionPolicy (Pulumi)                   | same                                                | S      | 7/7     |               |
| DeleteLogGroup                                | `builtin-installs.ts`, teardown scripts             | G      | 124/124 | [G-logs-del]  |
| DescribeLogGroups (CLI)                       | teardown scripts                                    | G      | 40/44   | [G-logs-read] |

### Cost and Usage Report (`service-com-amazonaws-costandusagereportservice-…`, 8 ops, 0 stubs)

| Operation                                           | Called from                                      | Rating | Steps | Evidence                                                         |
| --------------------------------------------------- | ------------------------------------------------ | ------ | ----- | ---------------------------------------------------------------- |
| PutReportDefinition (Pulumi `cur.ReportDefinition`) | `cloud-data-server-program.ts`                   | S      | 8/8   |                                                                  |
| DeleteReportDefinition                              | `builtin-installs.ts`, teardown script           | G      | 6/6   | [G-cur-del]                                                      |
| DescribeReportDefinitions (CLI)                     | `teardown-cloud-data-server.sh`                  | G      | 0/5   | [G-cur-desc]                                                     |
| Report delivery into S3                             | read by `admin-web/src/lib/cost-usage-report.ts` | N      |       | No delivery engine found in the crate (8 control-plane ops only) |

### ACM (`service-com-amazonaws-acm-certificatemanager`, 41 ops, 0 stubs)

| Operation                                                       | Called from                                                        | Rating | Steps             | Evidence                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ----------------- | ---------------------------------------------------- |
| RequestCertificate (+ Pulumi `acm.Certificate`)                 | `custom-domain.ts`, `cloud-data-server-program.ts`                 | G      | 34/35             | [G-acm-settle], [G-acm-dns]                          |
| DescribeCertificate (+ Pulumi `acm.CertificateValidation` wait) | `custom-domain.ts`, `routes/custom-domain.ts`, `zone.ts`, teardown | G      | 28/49             | [G-acm-settle], [G-acm-dns] (never reaches `ISSUED`) |
| ListCertificates / ListTagsForCertificate / DeleteCertificate   | `custom-domain.ts`, `zone.ts`, `teardown-bootstrap.sh`             | S      | 3/3, 27/27, 76/77 |                                                      |

### Route 53 (`service-com-amazonaws-route53-awsdnsv20130401`, 72 ops, 16 stubs; none we call)

| Operation                                                   | Called from                                                        | Rating | Steps             | Evidence         |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ----------------- | ---------------- |
| GetHostedZone                                               | `custom-domain.ts`, `zone.ts`, `setup-e2e-dns-zone.sh`             | G      | 11/12             | [G-r53-features] |
| ListResourceRecordSets                                      | same                                                               | S      | 1/1               |                  |
| ChangeResourceRecordSets (+ Pulumi `route53.Record`)        | `zone.ts`, `setup-e2e-dns-zone.sh`, `cloud-data-server-program.ts` | S      | 5/5               |                  |
| ListHostedZones / CreateHostedZone / DeleteHostedZone (CLI) | `setup-e2e-dns-zone.sh`                                            | S      | 1/2, 20/20, 23/23 |                  |

### API Gateway v2 (`service-com-amazonaws-apigatewayv2-apigatewayv2`, 104 ops, 9 stubs; none we call)

| Operation / feature                                         | Called from                                         | Rating | Steps      | Evidence                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| CreateApi (Pulumi `apigatewayv2.Api`)                       | `cloud-data-server-program.ts`                      | S      | 62/76      |                                                                                                                                 |
| CreateIntegration `AWS_PROXY` payload 2.0                   | `pulumi-program.ts`, `cloud-data-server-program.ts` | G      | 27/30      | [G-apigw-lambda]                                                                                                                |
| CreateRoute                                                 | same                                                | G      | 45/55      | [G-apigw-9]                                                                                                                     |
| CreateStage                                                 | `cloud-data-server-program.ts`                      | G      | 21/25      | [G-apigw-stage]                                                                                                                 |
| CreateAuthorizer `JWT` (Cognito issuer)                     | `cloud-data-server-program.ts:674`                  | G      | 4/8        | [G-apigw-jwt], [G-apigw-jwt2]                                                                                                   |
| CreateAuthorizer `REQUEST` (Lambda, Cookie identity source) | `cloud-data-server-program.ts:746`                  | G      |            | [G-apigw-lambda] (Lambda-authorizer routes answer 500)                                                                          |
| GetApis / DeleteApi (CLI)                                   | `teardown-cloud-data-server.sh`                     | S      | 7/7, 78/80 |                                                                                                                                 |
| HTTP invoke data plane → Lambda                             | every deployed route                                | G      |            | Implemented (`src/service/invoke.rs`); served on the emulator endpoint with the api id in the path, not on `{api}.execute-api…` |

### CloudFront (`service-com-amazonaws-cloudfront-cloudfront2020-05-31`, 168 ops, 24 stubs; none we call)

| Operation / feature                                             | Called from                         | Rating | Steps        | Evidence                                                                                |
| --------------------------------------------------------------- | ----------------------------------- | ------ | ------------ | --------------------------------------------------------------------------------------- |
| CreateDistribution                                              | `cloud-data-server-program.ts`      | G      | 33/63        | [G-cf-oac], [G-cf-tkg]                                                                  |
| CreateCachePolicy / CreateOriginAccessControl                   | same                                | G      | 10/16, 12/15 | [G-cf-loc]                                                                              |
| CreatePublicKey / CreateKeyGroup                                | same                                | G      | 18/39, 5/12  | [G-cf-loc], [G-cf-kg]                                                                   |
| CreateFunction / PublishFunction (`cloudfront-js-2.0`)          | same                                | G      | 5/12, 4/4    | [G-cf-loc]                                                                              |
| ListDistributions                                               | `e2e-aws-custom-domain/src/zone.ts` | S      | 2/3          |                                                                                         |
| Signed URLs (`@aws-sdk/cloudfront-signer`) verified at the edge | `api-handler.ts:1642,1676`          | G      |              | Signing is client-side; edge enforcement of TrustedKeyGroups never answers ([G-cf-tkg]) |
| OAC-protected S3 origin at the edge                             | files and app-assets origins        | G      |              | [G-cf-oac]                                                                              |

### CloudFormation (`service-com-amazonaws-cloudformation-cloudformation`, 91 ops, 3 stubs; none we call)

API operations:

| Operation                                                    | Called from                      | Rating | Steps                          | Evidence |
| ------------------------------------------------------------ | -------------------------------- | ------ | ------------------------------ | -------- |
| CreateStack / UpdateStack / DescribeStacks / GetTemplate     | `e2e-aws/src/bootstrap-stack.ts` | S      | 102/104, 22/27, 222/234, 25/25 |          |
| DeleteStack / `cloudformation wait`                          | `teardown-bootstrap.sh`          | S      | 110/113                        |          |
| Create/Describe/Execute/DeleteChangeSet, DescribeStackEvents | `scripts/update-bootstrap.sh`    | S      | 71/71, 36/42, 6/9, 9/9, 4/6    |          |

Resource types in the bootstrap template (`packages/aws-bootstrap/src/bootstrap/bootstrap-template.ts`):

| Resource type                                 | Count | Rating                | Evidence                                                                                                                         |
| --------------------------------------------- | ----- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `AWS::Cognito::UserPool`                      | 1     | **N (declared-only)** | No arm in `provisioner_for` (`state/provisioner.rs:894`); [G-cfn-cog1], [G-cfn-cogref]                                           |
| `AWS::Cognito::UserPoolClient`                | 2     | **N (declared-only)** | [G-cfn-cogclient]                                                                                                                |
| `AWS::Cognito::UserPoolDomain`                | 1     | **N (declared-only)** | No provisioner arm                                                                                                               |
| `AWS::Cognito::UserPoolUser`                  | 1     | **N (declared-only)** | No provisioner arm; [G-cfn-cog2]                                                                                                 |
| `AWS::Cognito::UserPoolUserToGroupAttachment` | 2     | **N (declared-only)** | [G-cfn-cog2] ("UserPoolGroup/UserPoolUserToGroupAttachment never deploy")                                                        |
| `AWS::Cognito::UserPoolGroup`                 | 2     | G                     | Provisioner arm exists (`COGNITO_USER_POOL_GROUP`), but the pool it names does not exist; [G-cfn-cog2]                           |
| `AWS::Cognito::IdentityPool`                  | 1     | G                     | Provisioned (`state/provisioning/cognito_identity_pool.rs`); fed a non-id client Ref → rollback ([G-cfn-cogclient], [G-cid-cfn]) |
| `AWS::Cognito::IdentityPoolRoleAttachment`    | 1     | G                     | [G-cid-roleatt]                                                                                                                  |
| `AWS::IAM::Role`                              | 4     | S                     | Provisioner arm `IAM_ROLE`                                                                                                       |
| `AWS::IAM::ManagedPolicy`                     | 5     | S                     | Provisioner arm `IAM_MANAGED_POLICY`                                                                                             |
| `AWS::S3::Bucket`                             | 3     | G                     | Arm `S3_BUCKET`; `DeletionPolicy`/`UpdateReplacePolicy: Retain` gaps [G-cfn-retain], [G-cfn-urp]                                 |
| `AWS::S3::BucketPolicy`                       | 1     | G                     | Arm `S3_BUCKET_POLICY`; [G-s3-pol]                                                                                               |

Template features: `Parameters` with `AllowedPattern`/`MinLength`/`MaxLength`, `Conditions`
(`!Not`, `!Equals`), resource-level `Condition`, `DeletionPolicy: Retain`,
`UpdateReplacePolicy: Retain`, `!Ref` (40), `!Sub` (23), `!GetAtt <Role>.Arn` (8), pseudo
parameters `AWS::AccountId` and `AWS::Region`, and `Outputs`. All are parsed by the emulator
(`state/template.rs`). The earlier "Outputs carry no OutputValue" issue has moved to
`issues/things-that-now-work/`. No custom resources (`Custom::*`) and no `Transform` are used.

### Pulumi resource types

| Pulumi type                                                                                                                                                                                    | Program                                             | Underlying API → rating                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `aws.lambda.Function` (`nodejs22.x`)                                                                                                                                                           | `pulumi-program.ts`, `cloud-data-server-program.ts` | CreateFunction → G                                                                           |
| `aws.lambda.Permission`                                                                                                                                                                        | both                                                | AddPermission → G                                                                            |
| `aws.cloudwatch.LogGroup`                                                                                                                                                                      | both                                                | CreateLogGroup → S                                                                           |
| `aws.apigatewayv2.Integration` / `Route`                                                                                                                                                       | both                                                | G                                                                                            |
| `aws.apigatewayv2.Api` / `Stage` / `Authorizer`                                                                                                                                                | `cloud-data-server-program.ts`                      | G (JWT/REQUEST authorizers)                                                                  |
| `aws.s3.BucketV2`, `BucketVersioningV2`, `BucketServerSideEncryptionConfigurationV2`, `BucketPublicAccessBlock`, `BucketCorsConfigurationV2`, `BucketLifecycleConfigurationV2`, `BucketPolicy` | `cloud-data-server-program.ts`                      | S/G (PutBucketEncryption is not authorized [G-s3-enc]; bucket policy plane [G-s3-pol])       |
| `aws.s3.Inventory`                                                                                                                                                                             | `cloud-data-server-program.ts`                      | G: [G-s3-inv] (neither validates nor persists)                                               |
| `aws.s3.BucketNotification` → Lambda                                                                                                                                                           | `cloud-data-server-program.ts`                      | ? (PutBucketNotificationConfiguration implemented; 32 open issues name it; not triaged)      |
| `aws.dsql.Cluster`                                                                                                                                                                             | `cloud-data-server-program.ts`                      | Control plane G, data plane N                                                                |
| `aws.cur.ReportDefinition`                                                                                                                                                                     | `cloud-data-server-program.ts` (us-east-1)          | S (no delivery)                                                                              |
| `aws.acm.Certificate`, `acm.CertificateValidation`                                                                                                                                             | `cloud-data-server-program.ts` (us-east-1)          | G (validation never completes)                                                               |
| `aws.route53.Record`                                                                                                                                                                           | `cloud-data-server-program.ts`                      | S                                                                                            |
| `aws.cloudfront.Distribution`, `CachePolicy`, `Function`, `KeyGroup`, `PublicKey`, `OriginAccessControl`                                                                                       | `cloud-data-server-program.ts`                      | G                                                                                            |
| `tls.PrivateKey` (`@pulumi/tls`)                                                                                                                                                               | `cloud-data-server-program.ts`                      | Local, no AWS call                                                                           |
| Pulumi S3 state backend (`PULUMI_BACKEND_URL=s3://…`)                                                                                                                                          | `compute-stack.ts:328,425`                          | ? (S3 ops are S; Pulumi backend endpoint/path-style settings not confirmed from public docs) |

`compute-stack.ts` creates no resources itself. It wraps the Automation API around
`pulumi-program.ts` and reads SSM, S3 `ListObjectsV2` and `GetBucketAccelerateConfiguration`.

## Answers to the step-3 questions

### Is Aurora DSQL emulated?

**Only the control plane.** The crate implements all 17 modelled operations (`CreateCluster`,
`GetCluster`, policies, streams, tags). A cluster reaches `ACTIVE` and publishes an endpoint of
the form `<id>.dsql.<region>.on.aws`, but the crate declares only `ops`, `scaffolded`,
`service` and `state`. No module speaks the PostgreSQL wire protocol, so a libpq connect is
refused on TCP 5432 ([G-dsql], CRITICAL, open; duplicates [G-dsql-2] and [G-dsql-3]).
`DsqlSigner` tokens are generated client-side, so token generation "works", but there is
nothing to present them to.

**What this means for the cloud-data-server path:**

- PGlite remains the only local stand-in for DSQL. The emulator adds nothing to the SQL half
  of `storage-aurora-dsql`, `dsql-ddl.ts`, `dsql-schema-init.ts`, `registry.ts`,
  `installer-dsql.ts` or the `scripts/debug-dsql-*.ts` tools.
- The emulator can at most exercise the IAM, STS and SSM calls that surround a DSQL connect
  (AssumeRole with session tags, `GetParameter`). The final `pg.connect` must still be faked
  or pointed at PGlite.
- Even with a data plane, the handler could not reach it from inside an emulated Lambda: the
  QuickJS runtime has no sockets.

### Cognito

- **InitiateAuth flows starkeep-core uses:** `USER_PASSWORD_AUTH`, `REFRESH_TOKEN_AUTH`
  (InitiateAuth), `ADMIN_USER_PASSWORD_AUTH` (AdminInitiateAuth), and the
  `NEW_PASSWORD_REQUIRED` challenge via `RespondToAuthChallenge`. All four are implemented. Only
  `CUSTOM_AUTH` is called out as `NotImplemented`, and starkeep-core does not use it. Known
  gaps:
  - refresh-token shape ([G-cog-refresh]);
  - `REFRESH_TOKEN_AUTH` answers 501 for a disabled user ([G-cog-es256]);
  - `RespondToAuthChallenge` passes 0 of 15 scored steps ([G-cog-mfa]).

  `NEW_PASSWORD_REQUIRED` is the first thing a wave-2 experiment should check.

- **JWTs:** Yes, ID, access and refresh tokens are issued and signed. The signature is
  **ES256 (P-256)**, not RS256. The source comment says this is deliberate: the Rust RSA crates
  carry unfixed timing advisories (`state/tokens.rs`). The `iss` claim is
  `<endpoint the caller used>/<poolId>`, so it is `https://127.0.0.1:9297/<poolId>` unless the
  client reached the emulator under the public `cognito-idp.<region>.amazonaws.com` host name
  ([G-cog-es256], [G-cog-es256-2]).
- **JWKS endpoint:** Yes. `GET /<poolId>/.well-known/jwks.json` is served (`src/service.rs`),
  publishing an EC P-256 key. The older issue that says JWKS is not served is stale.
  starkeep-core's verifiers would still reject every emulator token:
  - they import keys as `RSASSA-PKCS1-v1_5` and return `null` unless `alg === "RS256"`;
  - they also compute the issuer and JWKS URL from the public AWS host name.
- **Identity pool `GetCredentialsForIdentity`:** Implemented, 5/10 scored steps. Open gaps:
  - vended keys are `EMULATOR…`-prefixed rather than `ASIA…`;
  - the vended session is not a session of the mapped role and is "authorization-unbounded";
  - server-side token check vends the ambient emulator principal.

  Sources: [G-cid-unbounded], [G-cid-session], [G-cid-sst]. It is usable for a "does the call
  succeed" check, but not for "does the admin role get the right permissions".

- **Hosted UI / OAuth2:** starkeep-core uses them:
  - `sign-in-routes.ts` redirects to `https://<domain>/oauth2/authorize` and POSTs to
    `/oauth2/token`;
  - `app-sign-in-clients.ts` sets `AllowedOAuthFlows: ["code"]`;
  - the bootstrap output is `<domain>.auth.<region>.amazoncognito.com`.

  **Not emulated.** The Cognito service answers only modelled operations plus two non-modelled
  GETs (the JWKS document and the classic-UI logo). Its own routing test lists
  `/<pool>/oauth2/token` as unclaimed (`service.rs`, `only_a_pools_well_known_key_set_path_names_a_pool`).
  `CreateUserPoolDomain` and managed-login branding are emulated only as control-plane records.

### CloudFormation

**No.** The emulator recognises every resource type in the bootstrap template, and its template
engine handles every intrinsic used (`Ref`, `Fn::Sub`, `Fn::GetAtt`, `Fn::Equals`, `Fn::Not`,
`Condition`, pseudo parameters, `DeletionPolicy`/`UpdateReplacePolicy`). The template uses no
custom resources or transforms. Recognised is not provisioned, though:

- **Declared-only, nothing created:** `AWS::Cognito::UserPool`, `UserPoolClient`,
  `UserPoolDomain`, `UserPoolUser`, `UserPoolUserToGroupAttachment`. "A type with no entry here
  is left declared-only … nothing is created in any service" (`state/provisioner.rs` module
  docs). Five open issues confirm the effect ([G-cfn-cog1], [G-cfn-cog2], [G-cfn-cogref],
  [G-cfn-cogclient]).
- **Provisioned but broken by the above:**
  - `AWS::Cognito::UserPoolGroup` names a pool that does not exist.
  - `AWS::Cognito::IdentityPool` gets a CloudFormation-style client "id" and rolls back
    ([G-cfn-cogclient]).
  - `IdentityPoolRoleAttachment` is not applied through `SetIdentityPoolRoles`
    ([G-cid-roleatt]).
- **Provisioned:** `AWS::IAM::Role`, `AWS::IAM::ManagedPolicy`, `AWS::S3::Bucket`,
  `AWS::S3::BucketPolicy`, with open `Retain`-policy gaps on buckets ([G-cfn-retain],
  [G-cfn-urp]).

Net: `CreateStack` may reach `CREATE_COMPLETE` or roll back. Either way the stack outputs that
starkeep-core reads (`UserPoolId`, client ids, `IdentityPoolId`, Cognito domain) will not name
working Cognito resources.

### Lambda and API Gateway v2

- **Lambda executes code, in process, without Docker.**
  - `nodejs*` functions run in **QuickJS** (`rquickjs`) inside the emulator process.
  - `python*` functions run in an embedded interpreter.
  - The engine supplies a fixed set of Node core modules: `path`, `util`, `events`, `buffer`,
    `crypto`, `fs`, `timers`, `stream`, `string_decoder`, `os`, `assert`, `querystring`, `url`.
  - There is no `net`, `http`, `https`, `tls`, `zlib`, `child_process` or `worker_threads`.
  - A built-in `@aws-sdk/client-*` shim routes SDK calls back into the emulator. A function
    that bundles its own SDK copy keeps that copy, which then needs `node:https` and fails.

  The user guide adds that function code "runs with your user's permissions" and is not
  isolated ([security][ug-security]). That reads as a conservative statement; the source
  describes a contained engine. Either way, starkeep-core's handlers would hit the missing
  modules: they use `pg`, and Lambda bundles commonly carry their own AWS SDK.

- **API Gateway v2 routes to Lambda: yes.** The HTTP-API invoke data plane
  (`src/service/invoke.rs`):
  - resolves a deployed stage's route;
  - evaluates JWT authorizers in full;
  - performs `AWS_PROXY` integrations over the in-process transport.

  The API is announced on the emulator's own endpoint with the api id in the path, because
  `{api}.execute-api.{region}.amazonaws.com` does not resolve locally. Open gaps:
  - Lambda-authorizer (`REQUEST`) routes answer 500 ([G-apigw-lambda]). The cloud-data-server
    Cookie authorizer is one of these.
  - JWT-authorizer routes have open "never answers" and empty-claims issues ([G-apigw-jwt],
    [G-apigw-jwt2]).
  - A JWT authorizer configured with the public Cognito issuer will not match emulator-issued
    tokens (previous section).

### Pulumi AWS provider

**Yes, by configuration.** The Pulumi AWS provider ([Provider API docs][pulumi-provider])
exposes:

- `endpoints`: a per-service override list, "Use this to override the default service endpoint
  URL". It has fields for `s3`, `sts`, `iam`, `lambda`, `apigatewayv2`, `cloudfront`, `dsql`,
  `cur`, `acm`, `route53` and `cloudwatchlogs`.
- `skipCredentialsValidation`: "Skip the credentials validation via STS API."
- `skipRequestingAccountId`: "Skip requesting the account ID."
- `skipMetadataApiCheck`.
- `s3UsePathStyle`: "Set this to true to enable the request to use path-style addressing."
- `insecure`: "Explicitly allow the provider to perform 'insecure' SSL requests."
- `customCaBundle`: "File containing custom root and intermediate certificates", which can point
  at the emulator's `~/.aws/emulator/<port>/ca.pem`.

What starkeep-core would have to change (to be confirmed in wave 2):

- `compute-stack.ts` sets only `aws:region` (`compute-stack.ts:333`). The stack config would
  also need the endpoints and the CA bundle.
- The explicit `new aws.Provider("us-east-1-provider", { region: "us-east-1" })` does not
  inherit the default provider's config. It would need its own `endpoints`, and with a single
  emulator the deployment Region would have to be `us-east-1`.
- The skip flags are probably unnecessary: the emulator implements STS `GetCallerIdentity` and
  returns account `000000000000`.
- Could not determine from public sources:
  - whether `@pulumi/aws` v6 also honours `AWS_ENDPOINT_URL` from the environment;
  - how the Pulumi DIY S3 state backend (`PULUMI_BACKEND_URL=s3://…`) is pointed at a custom
    endpoint with path-style addressing. The Pulumi state-and-backends page names
    "S3-compatible servers" but gives no parameters.

### CloudFront, ACM, Route 53, Cost and Usage Report

- **CloudFront:** Emulated: control plane plus an edge data plane (`src/service/edge.rs`) that
  serves cache behaviours, geo restrictions and origin fetches. Signed URLs are produced
  client-side by `@aws-sdk/cloudfront-signer`. Gaps:
  - **Edge enforcement of `TrustedKeyGroups`:** a distribution with trusted key groups never
    serves its S3 origin ([G-cf-tkg]).
  - **OAC-protected S3 origins** never serve at the edge ([G-cf-oac]).

  Signed-URL verification and OAC are therefore "supported with known gap", effectively
  unusable today.

- **ACM:** Emulated (41 ops, 0 stubs). Requested certificates never reach a terminal state, and
  DNS-validated ones never reach `ISSUED` ([G-acm-settle], [G-acm-dns], [G-acm-zone]).
  `aws.acm.CertificateValidation` and the admin-web custom-domain poll would wait forever.
- **Route 53:** Emulated (hosted zones and record sets); every op starkeep-core calls is
  implemented. Records are API state only: no DNS is served for them.
- **Cost and Usage Report:** Emulated as a control plane (8 ops, report definitions only). No
  report is ever written to S3, so `apps/admin-web/src/lib/cost-usage-report.ts` would always
  find an empty prefix.

### Project health

- **License:** CC0-1.0 for the emulator; Apache-2.0 for `vendor/` (README "License"). No
  licensing obstacle to running it in CI.
- **Release cadence:** very high. `gh release list` shows 12 published releases between
  2026-11-07 and 2026-11-11 (v1.0.250 → v1.0.322), with version numbers advancing about 70 in
  four days. Releases are cut by `aws-emulator-ci[bot]` and the notes are lists of
  `fix: <issue-slug>`. Security fixes ship only in the latest release ([security][ug-security]),
  so pinning a version has a cost.
- **Does not take PRs:** "This repository does not take PRs" (README). Gaps can only be
  reported as GitHub issues, and starkeep-core cannot fix a blocker itself.
- **Fidelity scores: available.** Each release attaches `scores.json.gz`: per-unit
  wire/behavioural fidelity tests with per-step outcomes. v1.0.322 has 42,937 units (24,243
  pass, 18,614 fail, 80 skipped). The [check-project][ug-check] page describes using them with
  `manifest.jsonl` from `aws/aws-emulator-evaluation-suite`. Per-operation numbers for
  starkeep-core are in the matrix above.
- **Known-gap tracking:** 6,544 files in `issues/things-that-do-not-work/`, 12,708 in
  `issues/things-that-now-work/`. Issues are snapshots tied to a commit and can be stale. The
  JWKS issue is one example, so verify against source before trusting a single issue.
- **"Don't use it to test security":** the security page lists IAM policies and permissions
  boundaries, resource policies (bucket policies), KMS key policies and cross-account/Region
  access as things not to test. It adds that "the emulator never denies a request signed with
  its own key" and "doesn't check AWS KMS key policies or Amazon S3 bucket policies"
  ([security][ug-security]). Consequences for starkeep-core:
  - The emulator cannot replace `packages/iam-permission-tests` (which uses a local IAM
    simulator anyway) or a real-AWS run of the permission boundaries in `aws-bootstrap`.
  - It cannot check the `aws:PrincipalTag`-scoped user-data-owner boundary or the CloudFront
    → S3 bucket policy.
  - Open STS issues show `aws:PrincipalTag` conditions are not evaluated reliably
    ([G-sts-tags], [G-sts-sesspol]).
  - A passing emulator run says the calls are well-formed, nothing about whether they are
    permitted on AWS.

## Ranked experiments

### Top three worth an experiment (wave 2)

1. **S3 storage adapter and SSM credential/passphrase store.** Run `packages/storage-s3`'s
   adapter (put/get/head/tag/restore/delete, presigned GET/PUT, multipart),
   `admin-installer/src/app-creds.ts`, `pulumi-passphrase.ts` and
   `app-client/src/credentials.ts` with `AWS_ENDPOINT_URL=https://127.0.0.1:9297` and
   `NODE_EXTRA_CA_CERTS`.
   - Why: highest fidelity (S3 81–100%, SSM 67–100%); no code change needed, because
     `adapter.ts` uses default SDK config. Presigned-URL acceptance is the main unknown.
2. **Cognito user-pool API path with a pool created through the API** (not CloudFormation).
   - Cover: `admin-web/src/routes/users.ts` admin operations; `USER_PASSWORD_AUTH` →
     `NEW_PASSWORD_REQUIRED` → `REFRESH_TOKEN_AUTH` in `lib/cognito-auth.ts`; identity-pool
     `GetId`/`GetCredentialsForIdentity`; `app-sign-in-clients.ts`.
   - Why: Admin\* ops score 100%. This would replace a slow real-AWS dependency.
   - Confirm: the `RespondToAuthChallenge` 0/15 score, and the ES256/issuer mismatch with
     `verify.ts`.
3. **Per-app compute stack through Pulumi** (`pulumi-program.ts` via `compute-stack.ts`):
   Lambda + LogGroup + API GW v2 Integration/Route against an emulator-created HTTP API, using
   provider `endpoints` + `customCaBundle`, then invoke a trivial handler through the API.
   - Why: this is the installer path with no local test today; all control-plane ops are
     implemented.
   - Learn: whether Pulumi's provider and S3 state backend can be pointed at the emulator,
     which also decides whether any Pulumi path is testable.

Runner-up: IAM/STS installer functions (`iam.ts`, `session.ts`, `iam-diagnostics.ts`) as a
_functional_ check only.

### Not worth trying now

- **cloud-data-server end to end, and anything touching DSQL SQL.** No DSQL data plane; no
  sockets in Lambda; JWT alg/issuer mismatch; Lambda-authorizer routes answer 500. Keep PGlite.
- **Bootstrap CloudFormation stack** (`e2e-aws/src/bootstrap-stack.ts`,
  `scripts/update-bootstrap.sh`). Cognito user-pool resource types are declared-only.
- **Token verification and hosted-UI sign-in** (`app-client/src/auth/verify.ts`,
  `verify-user-token.ts`, `sign-in-routes.ts`). ES256 tokens, emulator-host issuer,
  hard-coded AWS host names, and no `/oauth2/*` endpoints.
- **Custom domain** (ACM + Route 53 + CloudFront). Certificates never reach `ISSUED`, and the
  stack needs a second Region.
- **CloudFront signed URLs / OAC delivery.** Edge never serves these origins.
- **Cost and Usage Report reading** (`cost-usage-report.ts`). No report delivery.
- **IAM policy and permissions-boundary correctness** (`iam-permission-tests`, boundary
  statements). Explicitly out of scope per the emulator's security page.

## Gaps found (index)

Every link points at `issues/things-that-do-not-work/` on tag `v1.0.322`.

- DSQL data plane absent: [G-dsql], [G-dsql-2], [G-dsql-3]
- Cognito tokens ES256 / issuer / refresh: [G-cog-es256], [G-cog-es256-2], [G-cog-refresh]
- Cognito challenge state machine: [G-cog-mfa]; read payloads: [G-cog-read]
- Cognito identity credentials: [G-cid-unbounded], [G-cid-session], [G-cid-sst], [G-cid-cfn],
  [G-cid-roleatt]
- CloudFormation Cognito resources: [G-cfn-cog1], [G-cfn-cog2], [G-cfn-cogref],
  [G-cfn-cogclient]; bucket retain policies: [G-cfn-retain], [G-cfn-urp]
- STS: [G-sts-tags], [G-sts-sesspol], [G-sts-asia]
- IAM: [G-iam-raw], [G-iam-malformed], [G-iam-getdeleted], [G-iam-delpol]
- SSM: [G-ssm-sem], [G-ssm-err]
- S3: [G-s3-read], [G-s3-del], [G-s3-list], [G-s3-crc64], [G-s3-urls], [G-s3-inv], [G-s3-enc],
  [G-s3-pol]
- Lambda: [G-lambda-role], [G-lambda-perm], [G-lambda-codeloc]
- Logs: [G-logs-del], [G-logs-read]; CUR: [G-cur-del], [G-cur-desc]
- ACM: [G-acm-settle], [G-acm-dns], [G-acm-zone]; Route 53: [G-r53-features]
- API GW v2: [G-apigw-jwt], [G-apigw-jwt2], [G-apigw-lambda], [G-apigw-9], [G-apigw-stage]
- CloudFront: [G-cf-tkg], [G-cf-oac], [G-cf-loc], [G-cf-kg]

## What this means for starkeep-core

- The emulator can plausibly replace real AWS for the **SDK-level storage, parameter, role and
  user-management code**: the parts that call AWS APIs directly and do not depend on DSQL,
  CloudFront edges, certificate issuance or token verification.
- It **cannot** replace real AWS for the cloud-data-server, the bootstrap stack, custom domains
  or any security property. Those still need `STARKEEP_AWS_TESTS=1` runs (by humans, on real
  AWS) or the existing fakes (PGlite, `packages/testkit` fake pool).
- Adopting it for Cognito token flows would mean code changes in starkeep-core:
  - accept ES256 in tests, or inject a verifier;
  - make the Cognito/JWKS host configurable in `app-client/src/auth/*` and
    `verify-user-token.ts`.

  Wave 3 should weigh that against the existing `testkit` fake pool.

- Wave-2 experiments should run with Region `us-east-1`, because one emulator serves one
  Region.

## Method and exact commands

Research only; nothing was installed or executed against the emulator.

```bash
# Emulator source (read-only), pinned to the commit behind v1.0.322
git clone --depth 50 https://github.com/aws/aws-emulator /tmp/emu-src/aws-emulator
git -C /tmp/emu-src/aws-emulator log -1 --format='%H %cd'   # 7753983c6e49… 2026-11-10

# Per operation: does services/<crate>/src/ops/<snake_op>.rs exist, and does it carry the
# stub marker "^//! SCAFFOLDED, NOT IMPLEMENTED:"?
grep -rl '^//! SCAFFOLDED, NOT IMPLEMENTED:' services/<crate>/src/ops/

# Open gaps per operation: issues/things-that-do-not-work/*.md whose "## Operation",
# "_Operation:" or "Issue-Key: svc|Op|…" names the operation; titles reviewed by hand.

# Fidelity scores for the release
gh release download v1.0.322 -R aws/aws-emulator -p scores.json.gz
# per-step outcomes aggregated by (service shape id, step.operation)

# starkeep-core side
grep -rhoE "@aws-sdk/[a-z0-9-]+" --include=*.ts .            # SDK packages
grep -oE "\b[A-Z][A-Za-z0-9]+Command\b" <file>                # commands per file
grep -oE "\baws (s3api|iam|ssm|…) [a-z0-9-]+" scripts/*.sh    # CLI subcommands
```

Documentation consulted: emulator README and `AGENTS.md`; user guide pages
[security][ug-security], [point-sdk-to-emulator][ug-point], [check-project][ug-check]; Pulumi
AWS [Provider API docs][pulumi-provider] and
[state and backends](https://www.pulumi.com/docs/iac/concepts/state-and-backends/).

[ug-security]: https://docs.aws.amazon.com/emulator/latest/userguide/security.html
[ug-point]: https://docs.aws.amazon.com/emulator/latest/userguide/point-sdk-to-emulator.html
[ug-check]: https://docs.aws.amazon.com/emulator/latest/userguide/check-project.html
[pulumi-provider]: https://www.pulumi.com/registry/packages/aws/api-docs/provider/
[G-dsql]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261107T211056Z-dsql-the-published-cluster-endpoint-accepts-no-postgresql.md
[G-dsql-2]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261023T121409Z-dsql-clusters-report-active-with-a-published-endpoint.md
[G-dsql-3]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261022T193920Z-dsql-publishes-a-cluster-endpoint-but-serves-no.md
[G-cog-es256]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T124858Z-cognito-idp-5-net-new-causes-tokens-are.md
[G-cog-es256-2]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T010846Z-cognito-identity-cognito-idp-user-pool-id-tokens.md
[G-cog-refresh]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261030T114740Z-cognito-idp-admin-initiateauth-responses-diverge-refresh-token.md
[G-cog-mfa]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T182116Z-cognito-idp-mfa-challenge-state-machine-mfa-setup.md
[G-cog-read]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261102T111936Z-cognito-idp-response-payloads-diverge-read-paths-omit.md
[G-cid-unbounded]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261026T054328Z-cognito-identity-4-net-new-root-causes-a.md
[G-cid-session]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261025T005354Z-cognito-identity-s3-the-cognito-vended-session-is.md
[G-cid-sst]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261025T005354Z-cognito-identity-cognito-idp-both-server-side-token.md
[G-cid-cfn]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261025T061337Z-cognito-identity-6-net-new-root-causes-cfn.md
[G-cid-roleatt]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261027T054912Z-cognito-identity-a-cloudformation-aws-cognito-identitypoolroleattachment-is.md
[G-cfn-cog1]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261024T114943Z-cognito-idp-cloudformation-provisioned-user-pools-app-clients.md
[G-cfn-cog2]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T124858Z-cloudformation-cognito-idp-4-net-new-causes-cfn.md
[G-cfn-cogref]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261105T021658Z-apigateway-cognito-identity-cognito-idp-ref-of-a.md
[G-cfn-cogclient]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261106T081405Z-cloudformation-cognito-identity-sts-aws-cognito-userpoolclient-s.md
[G-cfn-retain]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T180026Z-cloudformation-dynamodb-s3-cloudformation-s3-template-fetch-authorization-deletionpolicy-retain-on.md
[G-cfn-urp]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261107T060626Z-s3-cloudformation-updatereplacepolicy-retain-is-ignored-when-an.md
[G-sts-tags]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261027T130805Z-sts-5-net-new-behavioral-root-causes-temporary.md
[G-sts-sesspol]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261108T173319Z-sts-2-net-new-behavioral-root-causes-a-4010b7.md
[G-sts-asia]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T191504Z-sts-vended-credentials-and-policy-size-members-diverge.md
[G-iam-raw]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T184359Z-iam-policy-documents-are-returned-as-raw-json.md
[G-iam-malformed]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T184359Z-iam-malformed-iam-policy-documents-are-accepted-instead-of.md
[G-iam-getdeleted]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261103T132715Z-iam-getrole-answers-200-for-a-role-that.md
[G-iam-delpol]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261030T001243Z-iam-deleterolepolicy-answers-404-nosuchentity-for-an-inline--r2.md
[G-ssm-sem]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261103T215115Z-ssm-parameter-store-semantics-diverge-selector-echo-filter.md
[G-ssm-err]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261103T173026Z-ssm-parameter-store-error-classes-and-messages-are-emulator.md
[G-s3-read]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261102T111455Z-s3-object-read-and-batch-delete-response-contracts.md
[G-s3-del]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261031T220739Z-s3-successful-deletes-answer-a-4xx-error-instead.md
[G-s3-list]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261102T111455Z-s3-listings-percent-encode-the-key-delimiter-under.md
[G-s3-crc64]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T072224Z-s3-uploadpart-does-not-return-x-amz-checksum.md
[G-s3-urls]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261110T134656Z-s3-publishes-response-urls-on-the-real-aws.md
[G-s3-inv]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261102T111455Z-s3-inventory-configuration-plane-neither-validates-nor-persists.md
[G-s3-enc]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T163411Z-iam-s3-sts-s3-putbucketencryption-is-not-authorized-against-s3-putencryptionconfiguration.md
[G-s3-pol]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261102T111455Z-s3-bucket-policy-plane-accepts-malformed-policies-and.md
[G-lambda-role]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T163411Z-cloudformation-iam-lambda-s3-lambda-createfunction-accepts-a-role-arn-that-names.md
[G-lambda-perm]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261105T223150Z-iam-lambda-the-addpermission-alone-authorizes-invoke-scenario.md
[G-lambda-codeloc]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T163411Z-codecommit-codepipeline-glue-iam-lambda-lambda-getfunction-publishes-a-code-location-on-an.md
[G-logs-del]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261103T165236Z-logs-cloudwatch-logs-deleteloggroup-refuses-an-existing-log-group.md
[G-logs-read]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261103T142322Z-logs-log-group-log-stream-and-log-event.md
[G-cur-del]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261107T111503Z-cost-and-usage-report-service-deletereportdefinition-wrong-behavior.md
[G-cur-desc]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261108T004453Z-cur-describereportdefinitions-omits-the-modeled-reportstatus-member-from-every.md
[G-acm-settle]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261110T181625Z-acm-requested-certificates-never-settle-terminally-describecertificate-stays.md
[G-acm-dns]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T132410Z-acm-apigateway-s3-a-dns-validated-acm-certificate.md
[G-acm-zone]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T093731Z-acm-dns-validated-certificate-issuance-is-unreachable-the.md
[G-r53-features]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261108T200652Z-route53-route-53-gethostedzone-serializes-an-empty-hostedzone-features.md
[G-apigw-jwt]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T070719Z-apigatewayv2-cognito-idp-lambda-an-http-api-route.md
[G-apigw-jwt2]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261108T120220Z-apigatewayv2-cognito-idp-lambda-http-api-jwt-authorizer.md
[G-apigw-lambda]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261110T170829Z-apigatewayv2-lambda-7-net-new-causes-aws-iam.md
[G-apigw-9]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261110T170829Z-apigatewayv2-9-net-new-causes-aws-iam-routes.md
[G-apigw-stage]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261103T032504Z-apigatewayv2-createstage-mishandles-default-stage-names-and-duplicate.md
[G-cf-tkg]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261027T001031Z-apigateway-cloudfront-s3-cloudfront-a-distribution-with-trustedkeygroups-never-serves-its.md
[G-cf-oac]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T175823Z-cloudfront-s3-an-oac-protected-s3-origin-never.md
[G-cf-loc]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T120741Z-cloudfront-create-responses-announce-a-location-uri-on.md
[G-cf-kg]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261108T183800Z-cloudfront-createkeygroup-accepts-a-keygroupconfig-items-entry-naming.md
