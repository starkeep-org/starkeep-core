# AWS Emulator, the per-app Pulumi compute stack

Issue: AI-684 (epic AI-678, wave 2). Spike: [`spikes/aws-emulator/pulumi/`](../../spikes/aws-emulator/pulumi/).
Builds on [01-runtime.md](01-runtime.md) (install, TLS trust, credentials) and [02-coverage.md](02-coverage.md)
("Pulumi AWS provider", "Lambda and API Gateway v2", and item 3 of its "Top three").

**Emulator version used: 1.0.322** (release date 2026.11.10, commit `7753983c6e495ec3612695b1336bf4936fc7b7fd`),
`aws-emulator_1.0.322-1_amd64.deb`. **Pulumi CLI v3.237.0** (sha256-checked tarball from `get.pulumi.com`),
**`pulumi-resource-aws` v6.83.3**; `@pulumi/pulumi` 3.237.0 and `@pulumi/aws` 6.83.3 as resolved from
`packages/admin-installer`. Node 24.22.3, `tsx` 4.21.0. Region `us-east-1`. Measured in the agent sandbox
(Debian 12, x86_64, no root) on 2026-11-12.

## Findings

1. **The Pulumi AWS provider targets the emulator, and the real program deploys completely.**
   `buildPulumiProgram` run unchanged through the Automation API created all 15 resources the example-app
   manifest declares (2 log groups, 2 functions, 2 permissions, 2 integrations, 7 routes) with **0 failed and
   0 skipped**, returned every `functionArn:`/`routeId:` output, and destroyed cleanly. Each `up` takes 10 to 12 s.
2. **`AWS_ENDPOINT_URL` alone suffices, given TLS trust and the key pair.** With only `aws:region` in stack config
   and `AWS_ENDPOINT_URL`, `AWS_CA_BUNDLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` in the environment, the same
   15/0/0 result. That is exactly the shape `compute-stack.ts` already uses (it passes keys and region in `envVars`
   and sets only `aws:region`), so **the provider side of `installComputeStack` needs no seam** once the environment
   carries the endpoint and the CA bundle.
3. **With explicit stack config, two settings are load-bearing: the CA bundle and `skipCredentialsValidation`.**
   - Without `aws:customCaBundle` (and without `AWS_CA_BUNDLE`): `x509: certificate signed by unknown authority`.
   - Without `aws:skipCredentialsValidation`: the provider's credential check calls
     `https://sts.us-east-1.amazonaws.com/` **even though `aws:endpoints` sets `sts`**; the spike's egress fence
     stopped it. `AWS_ENDPOINT_URL` does reach that check (finding 2 ran with no skip flags).
   - `skipRequestingAccountId`, `skipMetadataApiCheck`, `s3UsePathStyle`, and the `iam`/`s3` endpoint entries
     made no difference to this program: it calls only Lambda, CloudWatch Logs, API Gateway v2 (and STS).
4. **The Pulumi state backend on the emulator's S3 works with a URL seam.**
   `PULUMI_BACKEND_URL=s3://<bucket>?endpoint=https://127.0.0.1:9297&s3ForcePathStyle=true&region=us-east-1`
   with `AWS_CA_BUNDLE` and the key pair in the environment ran the full `up`/`destroy` (15/0/0). The backend ignores
   `AWS_ENDPOINT_URL` and `AWS_ENDPOINT_URL_S3` (its gocloud S3 driver uses AWS SDK for Go v1);
   without `endpoint` it goes to `<bucket>.s3.amazonaws.com`, with `endpoint` but no `s3ForcePathStyle` to
   `<bucket>.127.0.0.1:9297`, and without a CA bundle it fails TLS. `use_path_style` (the SDK v2 name) is rejected as
   an unknown query parameter.
5. **`installComputeStack` unchanged stops at the state backend, 1.3 s in.** Its own SDK calls succeed against the
   emulator through the ambient `AWS_ENDPOINT_URL` (SSM `GetParameter /spk/pulumi/passphrase`, S3
   `ListObjectsV2` and `GetBucketAccelerateConfiguration` on the state bucket), and `ensurePulumiCli` downloads the
   CLI v3.237.0 into `~/.starkeep/pulumi` (354 MB, 5.1 s). Then `pulumi stack select` fails:
   `read ".pulumi/meta.yaml": … Get "https://spk-pulumi-state.s3.amazonaws.com/.pulumi/meta.yaml": proxyconnect
tcp: dial tcp 127.0.0.1:9: connect: connection refused` — the bare `s3://<bucket>` URL
   (`compute-stack.ts:328`) addresses real AWS, which the spike's fence blocks.
6. **The example-app Lambdas fail INIT on their first line: `Cannot find module 'node:module'`.** Both entries
   (`index.mjs`, `api.mjs`) begin with esbuild's banner `import { createRequire as __cr } from 'node:module'`
   (`example-app/web/scripts/bundle.mjs:65`), and the emulator's QuickJS runtime has no `node:module`. Direct
   `Invoke`: `{"errorMessage":"Error: Cannot find module 'node:module'","errorType":"Runtime.ImportModuleError"}`.
   Through API Gateway both routes answer `500 {"message":"Internal Server Error"}`. So the failure is earlier
   than the `createWebAppHandler` top-level await the issue anticipated: no module of the app is evaluated.
7. **Past the banner, two more walls.** With the two banner lines removed (a probe copy, created directly through
   the Lambda API): `index.mjs` fails INIT on `Cannot find module 'node:zlib'`, imported by the bundled AWS SDK
   (`@smithy/core` `Crc32Node.js`); `api.mjs` gets through INIT and fails on the first request with
   `ReferenceError: Headers is not defined` in `toRequest` (`packages/app-client/src/web.ts:215`). The QuickJS
   runtime has no Fetch API globals (`Headers`, and by implication `Request`/`Response`), which the whole
   `@starkeep/app-client/web` adapter is built on.
8. **The control handler runs.** A one-line ESM handler deployed through the same program (second manifest,
   6/0/0) answered `GET /apps/control-app/hello` with `200 {"ok":true,…,"node":"v22.0.0"}`. On the same API, its
   JWT route answered **200 with an emulator ID token and 401 without**, so the JWT authorizer (issuer = an
   emulator user pool) evaluates correctly; [G-apigw-jwt]'s "never answers" did not reproduce. The example-app's
   JWT route likewise answered 401 without a token and reached the Lambda (500) with one.
9. **Lambda resource policies are not enforced** ([G-lambda-perm]). After `RemovePermission` of the program's
   `invoke-hello` statement, the gateway still invoked the function (200). On AWS that is a 500. A CI run on the
   emulator cannot catch a missing or wrong `aws.lambda.Permission`.
10. **[G-lambda-role] confirmed:** `CreateFunction` with a role ARN that does not exist is accepted (AWS rejects
    it); with no role at all it is rejected as on AWS (`ValidationException … Value null at 'role'`). The program
    always sets `role`, so the gap only means a wrong `appExecRoleArn` would go unnoticed.
11. **Lambda output does not reach CloudWatch Logs.** The `/aws/lambda/<fn>` groups the program creates held no
    events after the invokes; the INIT error is visible only in the `Invoke` response and its `LogType: Tail`.

## Verdict

**Yes for the control plane, no for the app's code, with one seam.** The per-app install path can run in CI on the
emulator: the real `buildPulumiProgram` deploys every resource with the stock provider, configured by environment
alone, in about 11 s, and API Gateway routes, JWT authorization and `AWS_PROXY` invocation all work end to end
for a handler that QuickJS can run. Exercising `installComputeStack` itself needs one seam — a way to give the
state backend URL `?endpoint=…&s3ForcePathStyle=true&region=…` — plus `AWS_ENDPOINT_URL` and `AWS_CA_BUNDLE` in its
environment; and every CI run downloads the CLI (354 MB) and the aws plugin (781 MB) unless cached. What such a
test would prove is that the program's resources and routes are accepted and wired; it would not prove that an app
runs (no starkeep app bundle can execute in the emulator's QuickJS: `node:module`, `node:zlib`, no `Headers`), nor
that the Lambda permission or exec role is right (neither is enforced). Worth adding as a cheap regression test of
the program and installer plumbing, with a stub handler as the deployed code; not a substitute for a real-AWS app
smoke test.

## Working provider configuration

Stack config used for the per-resource table (`E` = `https://127.0.0.1:9297`, the keys are the emulator's
generated pair from `~/.aws/emulator/9297/emulator_credentials`, stored as secrets):

```text
aws:region                      us-east-1
aws:endpoints                   [{"lambda":E,"cloudwatchlogs":E,"apigatewayv2":E,"iam":E,"sts":E,"s3":E}]
aws:customCaBundle              ~/.aws/emulator/9297/ca.pem
aws:s3UsePathStyle              true
aws:skipCredentialsValidation   true
aws:skipRequestingAccountId     true
aws:skipMetadataApiCheck        true
aws:accessKey / aws:secretKey   (secret)
```

Local file backend (`PULUMI_BACKEND_URL=file://<work>/state/<variant>`), `PULUMI_CONFIG_PASSPHRASE` from the
environment (random per run). Each variant runs with an empty `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`,
because the emulator's own `config` file carries `endpoint_url` and `ca_bundle` and would otherwise leak into every
variant. The ablations add `aws:maxRetries=1` so a configuration that cannot connect fails in seconds.

| Variant                        | Configuration                                                                                            | up     | created/failed/skipped | s    | Error                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------ | ---------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`                         | the block above                                                                                          | ok     | 15/0/0                 | 11.1 |                                                                                                                                                                                                    |
| `env-endpoint-only`            | `aws:region` only; env `AWS_ENDPOINT_URL`, `AWS_CA_BUNDLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | ok     | 15/0/0                 | 10.1 |                                                                                                                                                                                                    |
| `env-endpoint-no-ca`           | as above without `AWS_CA_BUNDLE`                                                                         | failed | 0/0/15                 | 8.5  | `unable to validate AWS credentials … STS: GetCallerIdentity … Post "https://127.0.0.1:9297/": tls: failed to verify certificate: x509: certificate signed by unknown authority`                   |
| `s3-backend`                   | full, plus state in the emulator's S3 (finding 4)                                                        | ok     | 15/0/0                 | 11.3 |                                                                                                                                                                                                    |
| `no-ca-bundle`                 | full minus `aws:customCaBundle`                                                                          | failed | 0/2/13                 | 3.6  | `creating CloudWatch Logs Log Group (/aws/lambda/spk-app-example-app-static): … CreateLogGroup … x509: certificate signed by unknown authority` (both log groups; everything else depends on them) |
| `no-skipCredentialsValidation` | full minus that flag                                                                                     | failed | 0/0/15                 | 6.2  | `unable to validate AWS credentials … STS: GetCallerIdentity … Post "https://sts.us-east-1.amazonaws.com/": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused`                   |
| `no-skipRequestingAccountId`   | full minus that flag                                                                                     | ok     | 15/0/0                 | 11.2 |                                                                                                                                                                                                    |
| `no-skipMetadataApiCheck`      | full minus that flag                                                                                     | ok     | 15/0/0                 | 10.8 |                                                                                                                                                                                                    |
| `no-s3-path-style`             | full minus `aws:s3UsePathStyle`                                                                          | ok     | 15/0/0                 | 10.9 |                                                                                                                                                                                                    |
| `four-endpoints`               | full with `aws:endpoints` = lambda, cloudwatchlogs, apigatewayv2, sts                                    | ok     | 15/0/0                 | 10.7 |                                                                                                                                                                                                    |

Minimal working stack config, therefore: `aws:region`, `aws:endpoints` for lambda, cloudwatchlogs, apigatewayv2
and sts, `aws:customCaBundle`, `aws:skipCredentialsValidation`, and the keys. Or none of that, and the four
environment variables of `env-endpoint-only`.

## Inputs (step 2)

Created through the emulator's API by `inputs.mjs`, then handed to the program in a `ComputeContext` built field
for field as `orchestrator.ts:533-553` builds it (`infraCreds` = the emulator key pair; `bundleHash` = base64
SHA-256 of the uploaded zip, as `orchestrator.ts:530` computes it; `dsqlHostname` a placeholder, never dialled).

| Input                                                 | Result                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API + `$default` stage, `AutoDeploy`             | ok. `ApiEndpoint` is `https://127.0.0.1:9297/_aws/execute-api/<apiId>`, used as `apiGatewayUrl`; `apiGatewayExecutionArn` = `arn:aws:execute-api:us-east-1:000000000000:<apiId>` |
| JWT authorizer (`authorizerId`)                       | ok. Issuer = an emulator user pool (`https://127.0.0.1:9297/<poolId>`), audience = its client; the token comes from `AdminInitiateAuth`                                          |
| REQUEST authorizer (`sessionAuthorizerId`)            | ok. `AuthorizerUri` names a function that is not deployed (the cloud-data-server's Cookie authorizer is out of scope); no CUSTOM route was invoked                               |
| Exec role (`appExecRoleArn`)                          | ok, `CreateRole` with the Lambda trust policy. [G-lambda-role]: no role → rejected as on AWS; non-existent role ARN → **accepted**                                               |
| Artifacts bucket, `apps/example-app/latest/dist.zip`  | ok (294 330 bytes, from `example-app/web/scripts/bundle.mjs` with `STARKEEP_APP_BASE_PATH=/apps/example-app`)                                                                    |
| State bucket, `/spk/pulumi/passphrase` (SecureString) | ok                                                                                                                                                                               |

The emulator's ids are deterministic per fresh start: every run got api `mp67t4dbd4` and authorizer `x26iqi`.

## Per-resource results (step 3, variant `full`)

Example-app manifest (`example-app/starkeep.manifest.json`), stack prefix `spk`:

| Type                           | Pulumi name                                              | Outcome  | Id / note                                               |
| ------------------------------ | -------------------------------------------------------- | -------- | ------------------------------------------------------- |
| `aws.cloudwatch.LogGroup`      | `logGroup-static`                                        | created  | `/aws/lambda/spk-app-example-app-static`, retention 14  |
| `aws.lambda.Function`          | `fn-static`                                              | created  | `nodejs22.x`, S3 code, `sourceCodeHash`, environment    |
| `aws.lambda.Permission`        | `invoke-static`                                          | created  | `apigateway.amazonaws.com`, `sourceArn <execArn>/*/*`   |
| `aws.apigatewayv2.Integration` | `integration-static`                                     | created  | `AWS_PROXY`, payload 2.0                                |
| `aws.apigatewayv2.Route`       | `route-static-any-proxy-89a42042`                        | created  | `ANY /apps/example-app/{proxy+}`, CUSTOM (session)      |
| `aws.apigatewayv2.Route`       | `route-static-any-c61d8a34`                              | created  | `ANY /apps/example-app`, public                         |
| `aws.apigatewayv2.Route`       | `route-static-any-immutable-proxy-a8cf1496`              | created  | `ANY /apps/example-app/_immutable/{proxy+}`, public     |
| `aws.apigatewayv2.Route`       | `route-static-any-sign-in-b96c9610`                      | created  | `ANY /apps/example-app/sign-in`, public                 |
| `aws.apigatewayv2.Route`       | `route-static-any-api-session-proxy-89c14795`            | created  | `ANY /apps/example-app/api/session/{proxy+}`, public    |
| `aws.apigatewayv2.Route`       | `route-static-any-starkeep-runtime-config-4eadc519`      | created  | `ANY /apps/example-app/starkeep-runtime-config`, public |
| `aws.cloudwatch.LogGroup`      | `logGroup-api`                                           | created  | `/aws/lambda/spk-app-example-app-api`                   |
| `aws.lambda.Function`          | `fn-api`                                                 | created  |                                                         |
| `aws.lambda.Permission`        | `invoke-api`                                             | created  |                                                         |
| `aws.apigatewayv2.Integration` | `integration-api`                                        | created  |                                                         |
| `aws.apigatewayv2.Route`       | `route-api-post-api-echo-e26c67a5`                       | created  | `POST /apps/example-app/api/echo`, JWT                  |
| outputs                        | `functionArn:static`, `functionArn:api`, 7 × `routeId:…` | returned |                                                         |

**Totals: 15 created, 0 failed, 0 skipped.** The control manifest (`spikes/aws-emulator/pulumi/control/`): 6
created (log group, function, permission, integration, route `GET /apps/control-app/hello` public, route
`POST /apps/control-app/echo` JWT), 0 failed, 0 skipped. The spike runs
`up` with `continueOnError` so independent resources still get an outcome after a failure; the installer does not.

## `installComputeStack` (step 4)

Called unchanged with the same `ComputeContext`, with `AWS_ENDPOINT_URL`, `AWS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`
and the emulator key pair (as `infraCreds`) in its environment, `HOME` pointing at a fresh directory:

| Step (in `pulumiUpInline`)                                                                | Result                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensurePulumiCli` (`compute-stack.ts:38`)                                                 | downloads CLI v3.237.0 (the SDK's version) into `$HOME/.starkeep/pulumi`, 354 MB, 5.1 s                                                                                                               |
| `getPulumiPassphrase` (SSM, `compute-stack.ts:153`)                                       | ok — the SDK client takes `AWS_ENDPOINT_URL` from the environment                                                                                                                                     |
| `probePulumiStateBucket` (S3 `ListObjectsV2`, `GetBucketAccelerateConfiguration`)         | ok — same                                                                                                                                                                                             |
| `LocalWorkspace.createOrSelectStack`, `PULUMI_BACKEND_URL=s3://spk-pulumi-state` (`:328`) | **stops**: `pulumi stack select … read ".pulumi/meta.yaml": … Get "https://spk-pulumi-state.s3.amazonaws.com/.pulumi/meta.yaml": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused` |
| `setConfig("aws:region")` (`:333`) and `up`                                               | not reached; would work on environment alone (variant `env-endpoint-only`)                                                                                                                            |

What a seam needs (no change made here):

- **Endpoint and path style on the backend URL**, the only required change:
  `s3://<bucket>?endpoint=<emulator>&s3ForcePathStyle=true&region=<region>` in both `pulumiUpInline` and `pulumiDestroyInline`. `pulumiStateBucket`
  is also the `Bucket` of the SDK probes, so the query must be appended at the `PULUMI_BACKEND_URL` line, not carried
  in the bucket name, and only when an endpoint override is configured.
- **CA bundle**: nothing in code. The CLI child inherits `process.env` (Automation API merges `envVars` over it), so
  `AWS_CA_BUNDLE` reaches both the backend and the provider.
- **Provider endpoint**: nothing in code, for the same reason (`AWS_ENDPOINT_URL`). The explicit
  `us-east-1-provider` in `cloud-data-server-program.ts` was not exercised (out of scope).
- **CLI download**: point `HOME` at a cache, or pre-populate `~/.starkeep/pulumi`; `PulumiCommand.get` finds it and
  skips the install.

## Invokes (step 5)

| Request                                                           | Status                         | Body / payload                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /apps/example-app/` (public)                                 | 500                            | `{"message":"Internal Server Error"}`                                                                                                                                               |
| `GET /apps/example-app` (public)                                  | 500                            | same                                                                                                                                                                                |
| `POST /apps/example-app/api/echo`, Bearer emulator ID token (JWT) | 500                            | same                                                                                                                                                                                |
| `POST /apps/example-app/api/echo`, no token                       | 401                            | `{"message":"Unauthorized"}`                                                                                                                                                        |
| `lambda:Invoke spk-app-example-app-static`                        | 200, `FunctionError=Unhandled` | `{"errorMessage":"Error: Cannot find module 'node:module'","errorType":"Runtime.ImportModuleError","trace":["Runtime.ImportModuleError: Error: Cannot find module 'node:module'"]}` |
| `lambda:Invoke spk-app-example-app-api`                           | 200, `FunctionError=Unhandled` | same `node:module` error                                                                                                                                                            |
| probe `index.mjs` without the banner, `Invoke`                    | 200, `FunctionError=Unhandled` | `Cannot find module 'node:zlib'` (`Runtime.ImportModuleError`)                                                                                                                      |
| probe `api.mjs` without the banner, `Invoke`                      | 200, `FunctionError=Unhandled` | `ReferenceError: Headers is not defined` at `toRequest (file:///var/task/api.mjs:5:23)`                                                                                             |
| control `GET /apps/control-app/hello` (public)                    | 200                            | `{"ok":true,"from":"control","rawPath":"/apps/control-app/hello","node":"v22.0.0"}`                                                                                                 |
| control `POST /apps/control-app/echo`, Bearer token (JWT)         | 200                            | `{"ok":true,"from":"control","rawPath":"/apps/control-app/echo","node":"v22.0.0"}`                                                                                                  |
| control `POST /apps/control-app/echo`, no token                   | 401                            | `{"message":"Unauthorized"}`                                                                                                                                                        |
| control `GET …/hello` after `RemovePermission`                    | 200                            | as before (AWS: 500)                                                                                                                                                                |

Static `node:*` imports of the bundle (resolved during INIT): `index.mjs` — `node:module`, `node:crypto`, `node:fs`,
`node:fs/promises`, `node:os`, `node:path`, `node:process`, `node:stream`, `node:zlib`; `api.mjs` — `node:module`
only. Of these, `module`, `zlib`, `process` and `fs/promises` are not in the emulator's documented module list
(02-coverage, "Lambda and API Gateway v2"); INIT stops at the first one it meets. `index.mjs` also carries
`import("node:http")` and `require("node:https")`/`require("node:child_process")` from the bundled SDK and
`@hono/node-server`, which would fail when reached.

The first module the bundle attempted: `node:module` (esbuild banner, line 1 of both entries). The first module the
app's own graph attempted after that: `node:zlib`, from the bundled `@smithy/core` that `@starkeep/app-client`
pulls in. The first call: `new Headers()` in `@starkeep/app-client/web`'s `toRequest`.

## Gaps found

- **[G-lambda-perm]** confirmed: the gateway invokes a function whose resource policy has no statement for it.
- **[G-lambda-role]** confirmed: `CreateFunction` accepts a non-existent role ARN.
- **QuickJS runtime lacks `node:module`, `node:zlib` and the Fetch API globals** (`Headers` at least). The first
  two follow from the documented module list; the missing `Headers` global is not stated in 02-coverage.
- **Lambda logs are not delivered to CloudWatch Logs**: `/aws/lambda/<fn>` stays empty after invokes and an INIT
  failure.
- **Provider credential validation ignores `aws:endpoints.sts`** (a provider behaviour, not an emulator gap): with
  stack-config endpoints, `aws:skipCredentialsValidation` must be set or the check goes to `sts.us-east-1.amazonaws.com`.
- **Not reproduced:** [G-apigw-jwt] ("never answers") — JWT routes answered 200 and 401 correctly. [G-apigw-lambda]
  (REQUEST authorizer 500) was not exercised: no CUSTOM route was invoked.

## What this means for starkeep-core

- A CI job can exercise `buildPulumiProgram` on the emulator **today, with no starkeep change**: set
  `AWS_ENDPOINT_URL`, `AWS_CA_BUNDLE` and the key pair, use a local file backend, run the program. It catches
  provider-level mistakes (bad route keys, a wrong integration shape, a renamed resource that collides, which is the
  `ConflictException` case `routeResourceName` exists for) in about 11 s per `up`.
- Running `installComputeStack` end to end needs **one seam**: an optional state-backend endpoint that adds
  `?endpoint=…&s3ForcePathStyle=true&region=…` to `PULUMI_BACKEND_URL` (`compute-stack.ts:328` and `:425`). It must be
  impossible to set in a deployed environment (read only under a test flag, like the seams 04-cognito proposes).
- Cache the CLI and plugin: the CLI tarball and the 781 MB aws plugin add over 1 GB of downloads to a cold run (not timed here);
  a warm run of the spike is 3.5 minutes (211 s measured), nearly all of it the ten `up`/`destroy` pairs.
- Deploy a stub handler, not an app: no bundle produced by `pnpm bundle` today can run in the emulator's Lambda.
  Removing the `createRequire` banner would not be enough (bundled SDK needs `node:zlib`; the web adapter needs
  `Headers`). App behaviour stays with the local data server and real-AWS smoke tests.
- Do not rely on the emulator for the Lambda permission or the exec-role choice: neither is enforced, so the
  security-relevant parts of the program (`pulumi-program.ts:109-171`) are untested by such a job.

## Reproduce

```bash
pnpm install
bash spikes/aws-emulator/pulumi/run.sh      # about 3.5 min warm; prints every table above
```

`SPIKE_VARIANTS=full,s3-backend` runs a subset of the provider configurations. See the spike's
[README](../../spikes/aws-emulator/pulumi/README.md) for versions, caching and the egress fence (every Pulumi child
gets `HTTPS_PROXY=http://127.0.0.1:9` with `NO_PROXY=127.0.0.1`, so nothing can reach an AWS host).

[G-lambda-role]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261109T163411Z-cloudformation-iam-lambda-s3-lambda-createfunction-accepts-a-role-arn-that-names.md
[G-lambda-perm]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261105T223150Z-iam-lambda-the-addpermission-alone-authorizes-invoke-scenario.md
[G-apigw-jwt]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261029T070719Z-apigatewayv2-cognito-idp-lambda-an-http-api-route.md
[G-apigw-lambda]: https://github.com/aws/aws-emulator/blob/v1.0.322/issues/things-that-do-not-work/20261110T170829Z-apigatewayv2-lambda-7-net-new-causes-aws-iam.md
