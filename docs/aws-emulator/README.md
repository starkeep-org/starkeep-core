# aws-emulator in starkeep-core: recommendation

Epic AI-678, issue AI-687. Evidence: [01 runtime](01-runtime.md), [02 coverage](02-coverage.md),
[03 S3 + SSM](03-s3-ssm.md), [04 Cognito](04-cognito.md), [05 Pulumi compute stack](05-pulumi-compute-stack.md).
Every experiment used emulator **1.0.322** (commit `7753983c`).

## Recommendation

**Adopt it narrowly: one non-required CI job, pinned to an emulator version, that runs the S3 storage adapter,
the SSM credential readers, the Cognito admin and sign-in API flows, and the per-app Pulumi program (with a stub
handler) against the emulator. Do not adopt it for the bootstrap CloudFormation stack, IAM policy correctness,
the e2e-aws journey, custom domains, DSQL, CloudFront signing or app Lambda code. Token verification and
`installComputeStack` can be added later, once their test seams land.** The biggest reason: those four paths are
mocked or stubbed in CI today, so no request ever reaches a real implementation of the AWS API. The emulator ran the real code for
all four with environment variables only (no product change), and the job would cost about 15 s of install plus
seconds of test time on GitHub Actions. What the emulator cannot do is decide whether a request is _permitted_, so
the job adds wire-level regression coverage, not permission coverage.

## Per code path

CI cost is seconds added on GitHub Actions on top of a workspace install. Installing and starting the emulator
takes 13.7 to 17.6 s plus 0.16 to 0.20 s ([01](01-runtime.md#measured-numbers)) and is paid once per job.

| Code path                                  | Exists today                                                                                                                                     | Emulator result                                                                                                                                                                                                                                                                             | Fidelity concerns                                                                                                                                                                                                                            | CI cost                                                                                                                                           | Verdict                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Bootstrap stack (`packages/aws-bootstrap`) | Offline: the template is parsed as data (`bootstrap-template.test.ts`); real AWS only by hand                                                    | Not run. Five `AWS::Cognito::*` types are declared-only, `Ref` returns names, so every Cognito output is wrong ([02](02-coverage.md#cloudformation))                                                                                                                                        | The identity pool rolls back on a non-id client `Ref` ([02](02-coverage.md#cloudformation))                                                                                                                                                  | n/a                                                                                                                                               | **Do not adopt.** Build the same resources through the API instead ([04](04-cognito.md)) |
| Cognito sign-in and admin users            | Fake: `packages/testkit` fake pool (HMAC tokens); `aws-sdk-client-mock` in admin-web tests                                                       | 83 steps: 73 ok, 7 differ, 3 failed. All three failures are `RespondToAuthChallenge NEW_PASSWORD_REQUIRED` answering 501; refresh, revoke, sign-out, disable, identity-pool credentials and every `users.ts` route work unchanged ([04](04-cognito.md#findings))                            | ES256 tokens with an emulator `iss`, so `verifyIdToken` returns `null` at `verify.ts:122`; `app-client/src/auth/cognito.ts:59` cannot be pointed at the emulator; Cognito admin calls are not IAM-evaluated ([04](04-cognito.md#gaps-found)) | about 3 s of driver time ([04](04-cognito.md#findings), finding 12)                                                                               | **Adopt** the API flows; verification later, behind a seam                               |
| S3 adapter (`packages/storage-s3`) + SSM   | Mock: tests stub the client's `send`, and 20/20 pass against a dead endpoint; offline presign URL check ([03](03-s3-ssm.md#findings), finding 7) | 53 S3 rows: 0 failed, 2 differ. 23 SSM rows: all ok. Presigned GET, PUT and UploadPart are accepted, and bad checksums, altered headers and expired URLs are refused ([03](03-s3-ssm.md#findings))                                                                                          | Accepts `x-amz-*` headers that are present but unsigned, which AWS refuses; `CompleteMultipartUpload` `Location` names the AWS host ([03](03-s3-ssm.md#gaps-found))                                                                          | about 5 s of driver time ([03](03-s3-ssm.md#timings))                                                                                             | **Adopt**                                                                                |
| IAM policies and boundaries                | Offline: `packages/iam-permission-tests` simulator, run in Tier 1                                                                                | Not run. The emulator's security page says not to use it for this ([02](02-coverage.md#project-health)). Incidentally confirmed: Cognito admin calls, Lambda permissions and exec roles are not enforced ([04](04-cognito.md#findings) f7, [05](05-pulumi-compute-stack.md#findings) f9–10) | The emulator never denies a request signed with its own key ([02](02-coverage.md#project-health))                                                                                                                                            | n/a                                                                                                                                               | **Do not adopt**                                                                         |
| Pulumi install (`compute-stack.ts`)        | Mock: `pulumi.runtime.setMocks` in `pulumi-program.test.ts`; nothing covers `installComputeStack`                                                | The real `buildPulumiProgram` created 15/15 resources with environment variables only. `installComputeStack` stops at the bare `s3://` backend URL. App Lambdas fail INIT on `node:module` ([05](05-pulumi-compute-stack.md#findings))                                                      | QuickJS has no `node:module`, no `node:zlib` and no `Headers`; Lambda permissions are not enforced; no logs reach CloudWatch ([05](05-pulumi-compute-stack.md#gaps-found))                                                                   | about 11 s per `up` ([05](05-pulumi-compute-stack.md#findings)); a cold run downloads 354 MB of CLI plus a 781 MB plugin (untimed, so cache them) | **Adopt** the program with a stub handler; `installComputeStack` after AI-768            |
| e2e-aws journey                            | Real AWS only, gated by `STARKEEP_AWS_TESTS=1`, never in CI                                                                                      | Not run (AI-685 was cancelled). It depends on the bootstrap stack and the cloud-data-server, which has no DSQL data plane, no sockets in Lambda and a JWT alg/issuer mismatch ([02](02-coverage.md#ranked-experiments))                                                                     | As for the bootstrap and Cognito rows                                                                                                                                                                                                        | n/a                                                                                                                                               | **Do not adopt**                                                                         |
| Custom domain                              | Mock: `aws-sdk-client-mock` tests; real AWS only through gated `e2e-aws-custom-domain`                                                           | Not run. ACM certificates never reach `ISSUED`, the path needs a second Region, and CloudFront has edge gaps ([02](02-coverage.md#cloudfront-acm-route-53-cost-and-usage-report))                                                                                                           | One Region per emulator ([02](02-coverage.md#findings-first))                                                                                                                                                                                | n/a                                                                                                                                               | **Do not adopt**                                                                         |

DSQL SQL (keep PGlite), CloudFront signed URLs and OAC, and CUR reading are out for the same reasons
([02](02-coverage.md#not-worth-trying-now)).

## Risks

- **Project health** ([02](02-coverage.md#project-health)).
  - The license is CC0-1.0, so nothing blocks running it in CI.
  - The repo takes no PRs, so we cannot fix a blocker ourselves.
  - Twelve releases shipped in four days, and security fixes land only in the latest release, so pinning a version has a cost.
  - **Correction to this issue's brief:** fidelity scores _are_ available. Each release attaches `scores.json.gz`
    (42,937 units for 1.0.322), and 02 lists per-operation pass rates.
  - The upstream gap files are snapshots and can be stale or wrong in either direction. [G-cid-session] did not
    reproduce for S3 ([04](04-cognito.md#findings), f6) and [G-apigw-jwt] did not reproduce at all
    ([05](05-pulumi-compute-stack.md#findings), f8).
- **"Don't test security with it" versus our IAM use.** A green run means the calls are well-formed, nothing more.
  The emulator accepts unsigned presign headers (03 f3), Cognito admin calls without a grant (04 f7), a missing
  `lambda.Permission` (05 f9) and a non-existent role ARN (05 f10). S3 _does_ evaluate the identity policy of a
  Cognito-vended session (04 f6), but that is undocumented behaviour; keep `iam-permission-tests` as the authority.
- **TLS and credential plumbing.**
  - Node trusts the emulator only through `NODE_EXTRA_CA_CERTS`, set before the process starts, and the CA changes
    on every start, so the test runner must be launched after the emulator ([01](01-runtime.md#gaps-found)).
  - The Pulumi CLI and backend read `AWS_CA_BUNDLE` instead ([05](05-pulumi-compute-stack.md#findings), f2 and f4).
  - The endpoint must be `127.0.0.1`, not `localhost`.
  - Real AWS credential variables must be unset.
  - A misconfigured Pulumi provider or backend silently targets real AWS hosts, so every job needs a dead
    `HTTPS_PROXY` egress fence (AI-684 Linear comment).
  - Emulator keys are generated at each start, so there is nothing to commit. The cognito spike's deliberately fake
    key `AKIASPIKEMADEUP00000` may trip secret scanners (AI-682 lead comment).
- **Drift from real AWS.**
  - One Region per emulator.
  - ES256 tokens; `EMULATOR…` keys rather than `ASIA…`; no `email_verified` claim.
  - `GetId` accepts a token from an untrusted client ([04](04-cognito.md#gaps-found)).
  - Response URLs name real AWS hosts ([03](03-s3-ssm.md#gaps-found)).

  A pinned version keeps these stable; every version bump should re-run the four spikes.

## Compared with the status quo

| Existing fake                                                                     | What it covers                                                                                                            | What the emulator adds                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/testkit` (`fake-cloud.ts`, `fake-pool.ts`)                              | Cloud-data-server exchange semantics over SQLite + FS; the device's four Cognito calls, including `NEW_PASSWORD_REQUIRED` | Real Cognito state transitions for admin-web and the installer (04). It cannot replace the fake cloud (no DSQL, no app Lambda) or the `NEW_PASSWORD_REQUIRED` branch (501) |
| PGlite                                                                            | All DSQL SQL                                                                                                              | Nothing: DSQL is control-plane only (02)                                                                                                                                   |
| `aws-sdk-client-mock` (admin-installer, admin-web, app-client, cloud-data-server) | Request shapes and our handling of canned responses                                                                       | Real responses: SSM error classes that pass our `instanceof` checks (03 f4), presign acceptance and refusal, checksums (03 f2, f5)                                         |
| `storage-s3` stubbed `send`, offline presign test                                 | Adapter logic; URL shape of signed headers                                                                                | Every adapter method end to end (03). The offline presign test must stay (03 f3)                                                                                           |
| Pulumi runtime mocks                                                              | Manifest-to-resource translation                                                                                          | Provider acceptance of route keys, integration shapes and name collisions (05)                                                                                             |
| `packages/iam-permission-tests`                                                   | Policy and boundary evaluation                                                                                            | Nothing it should rely on                                                                                                                                                  |

The marginal gain is real but bounded. It is the first real wire traffic for four SDK-level paths, at a cost of
roughly 15 s plus test time, and no security signal.

## Proposed follow-up issues

**Wave A (no dependencies)**

1. **An aws-emulator CI job runs the S3 adapter against a pinned emulator.** Add a harness that installs the cached,
   signature-checked `.deb`, starts the emulator, exports the environment with a `127.0.0.1` guard and an egress
   fence, then launches the command. Add an `emulator` vitest project to storage-s3 (kept out of `pnpm test`) that
   covers 03's S3 rows, and a non-required workflow job. Files: `scripts/aws-emulator/with-emulator.sh` (from
   `spikes/aws-emulator/runtime/run.sh`), `packages/storage-s3/vitest.config.ts`,
   `packages/storage-s3/__tests__/emulator/*.test.ts`, `turbo.json` (`test:emulator`),
   `.github/workflows/aws-emulator.yml`.
2. **02-coverage.md is corrected against wave-2 results.** Finding 1 and the Cognito answer call
   `NEW_PASSWORD_REQUIRED` implemented, but 04 measured it as a 501 scaffold. The `[G-cid-session]`,
   `[G-apigw-jwt]` and Pulumi state-backend rows also need forward notes to 04 and 05. Files:
   `docs/aws-emulator/02-coverage.md`.

**Wave B (after A1)**

3. **The SSM credential readers run in the emulator job.** Port 03's SSM rows for `app-creds.ts`,
   `pulumi-passphrase.ts` and `loadAppCredentials` to emulator tests. Files:
   `packages/admin-installer/__tests__/emulator/ssm.test.ts`, `packages/app-client/__tests__/emulator/credentials.test.ts`,
   the package vitest configs.
4. **Cognito admin and sign-in flows run in the emulator job.** Build the template's pool through the API (04's
   `pool` section) and test the `users.ts` routes, admin-web and installer sign-in, and the device client through
   `STARKEEP_COGNITO_ENDPOINT`, with passwords set permanent. Files: `packages/testkit/src/emulator-pool.ts`,
   `apps/admin-web/__tests__/emulator/*.test.ts`, `packages/admin-installer/__tests__/emulator/cognito-auth.test.ts`.
5. **`buildPulumiProgram` deploys a stub-handler manifest in the emulator job.** Use a file backend and a cached
   Pulumi CLI and plugin, and assert the resources, outputs and a `200`/`401` invoke. Files:
   `packages/admin-installer/__tests__/emulator/pulumi-program.test.ts`, a stub-manifest fixture,
   `.github/workflows/aws-emulator.yml` (cache step).

**Wave C (product seams, each after its B issue)**

6. **AI-768 (exists in Backlog), after B5:** a test-only state-backend endpoint for `installComputeStack`, plus an
   emulator test of the whole install. Files: `packages/admin-installer/src/compute-stack.ts` (`:328`, `:425`), its
   emulator test.
7. **Token verifiers accept emulator tokens under a test-only override (after B4).** Implement 04's option (a): the
   issuer and JWKS URL come from an optional endpoint, and ES256 is accepted only for an EC key, impossible to set in
   a deployed environment. This touches credential verification, so the review runs the reachability pass. Files:
   `packages/app-client/src/auth/verify.ts`,
   `packages/admin-installer/builtin-apps/cloud-data-server/src/verify-user-token.ts`, their tests.
8. **`app-client` session refresh accepts an endpoint (after B4).** Add an optional `endpoint` to `PoolConfig`, as
   `createCognitoClient` already has, and an emulator refresh test. Files:
   `packages/app-client/src/auth/cognito.ts`, its emulator test.

Owner action, not an agent issue: report the unsigned-presign-header gap upstream (03, gap 1). Doing so publishes to
`aws/aws-emulator`.

**`spikes/aws-emulator/`: keep as a docs companion.** Each evidence document's "Reproduce" section runs its spike,
and the spikes stay pinned to 1.0.322 for re-checking on a version bump. A1 _copies_ the runtime install and start
logic into `scripts/aws-emulator/` rather than importing it, so the spikes stay standalone. Revisit deleting them
once waves A and B have landed and the documents point at the real tests.

[G-cid-session]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261025T005354Z-cognito-identity-s3-the-cognito-vended-session-is.md
[G-apigw-jwt]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T070719Z-apigatewayv2-cognito-idp-lambda-an-http-api-route.md
