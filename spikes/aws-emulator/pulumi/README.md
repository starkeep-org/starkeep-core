# aws-emulator per-app Pulumi compute stack spike (AI-684)

Runs admin-installer's real per-app Pulumi program (`buildPulumiProgram` in
`packages/admin-installer/src/pulumi-program.ts`) through the Automation API
against [AWS Emulator](https://github.com/aws/aws-emulator), then
`installComputeStack` (`compute-stack.ts`) unchanged, invokes the deployed routes,
and prints one row per declared resource, per provider configuration and per
invoke.

Findings: [docs/aws-emulator/05-pulumi-compute-stack.md](../../../docs/aws-emulator/05-pulumi-compute-stack.md).

## Run it

From the repo root, on Linux (x86_64 or arm64) with Node 22+, `pnpm`, `curl`,
`dpkg-deb`, `gpgv`, `sha256sum`, `zip`, `unzip` and `openssl`, after `pnpm install`
at the root:

```bash
bash spikes/aws-emulator/pulumi/run.sh
```

## Pinned versions

| What                                 | Version         | Where it comes from                                               |
| ------------------------------------ | --------------- | ----------------------------------------------------------------- |
| AWS Emulator                         | 1.0.322         | `run.sh` (`EMULATOR_VERSION=latest` overrides)                    |
| Pulumi CLI                           | **v3.237.0**    | `run.sh`, = `@pulumi/pulumi` in the root lockfile; sha256-checked |
| `pulumi-resource-aws` (plugin)       | v6.83.3         | `run.sh`, = `@pulumi/aws` in the root lockfile                    |
| `@pulumi/pulumi`, `@pulumi/aws` (JS) | 3.237.0, 6.83.3 | resolved from `packages/admin-installer`, not from this folder    |

The CLI and the aws provider plugin (781 MB unpacked) are cached in
`${XDG_CACHE_HOME:-~/.cache}/starkeep-aws-emulator-spike-pulumi/`. The first run
downloads both; a warm run took 211 s in the agent sandbox, mostly the ten
`up`/`destroy` pairs and the 163 MiB emulator download.

## What it does

1. installs this directory's dependencies (`pnpm install --ignore-workspace`),
   builds `@starkeep/admin-manifest`, installs the `example-app` workspace and runs
   its `pnpm bundle` (`example-app/web/scripts/bundle.mjs`) with the installer's two
   variables; zips the one-line control handler in `control/`; makes a probe copy of
   the bundle without esbuild's `node:module` banner;
2. downloads, verifies and starts the emulator (the steps of
   [`../runtime/run.sh`](../runtime/run.sh), unchanged);
3. `spike.mjs` (under `tsx`, because admin-installer is source-only):
   - creates the program's inputs through the emulator's API (`inputs.mjs`): HTTP API
     with a `$default` stage, a JWT authorizer on an emulator user pool, a REQUEST
     authorizer, the exec role, the artifacts bucket with `apps/<appId>/latest/dist.zip`,
     the state bucket and `/<prefix>/pulumi/passphrase`;
   - `pulumi up` + `destroy` of the example-app program under each provider
     configuration (`SPIKE_VARIANTS=full,s3-backend` runs a subset), local file backend,
     `PULUMI_CONFIG_PASSPHRASE` from the environment;
   - one more `up` with the full configuration, then the invokes; the control manifest
     (`control/starkeep.manifest.json`) through the same program, then its invoke;
   - `installComputeStack` unchanged, with `HOME` pointing at the work directory so
     `ensurePulumiCli`'s download lands there;
4. stops the emulator and prints the tables (`report.mjs`).

The provider configuration that works, as stack config (`aws:accessKey`/`aws:secretKey`
are the keys the emulator generated for the run, set as secrets):

```text
aws:region                      us-east-1
aws:endpoints                   [{"lambda":E,"cloudwatchlogs":E,"apigatewayv2":E,"iam":E,"sts":E,"s3":E}]   E = https://127.0.0.1:9297
aws:customCaBundle              ~/.aws/emulator/9297/ca.pem
aws:s3UsePathStyle              true
aws:skipCredentialsValidation   true
aws:skipRequestingAccountId     true
aws:skipMetadataApiCheck        true
aws:accessKey / aws:secretKey   (secret)
```

## Safety

No AWS account or credentials are used. Every credential variable is removed
before the driver starts, and the driver refuses to run unless `AWS_ENDPOINT_URL`
is `https://127.0.0.1:<port>`. Every Pulumi CLI child gets `HTTPS_PROXY` and
`HTTP_PROXY` pointing at a closed local port with `NO_PROXY=127.0.0.1`, so a
configuration whose provider or state backend ignores the emulator endpoint fails
with `proxyconnect … connection refused` instead of reaching an AWS host. The only
keys are the emulator's, generated for the run and deleted when it stops; they and
the passphrase are redacted from the output.

The same options as the runtime spike apply: `EMULATOR_VERSION`, `EMULATOR_INSTALL`
(`extract`, default, or `apt`), `EMULATOR_DATA_PORT` (default `9297`). In a git
worktree whose main checkout is not writable, set `TURBO_CACHE_DIR=$PWD/.turbo/cache`
first.

Standalone like the other spikes: own `package.json` and `pnpm-lock.yaml`, not in
`pnpm-workspace.yaml`, not run by `ci.yml`.
