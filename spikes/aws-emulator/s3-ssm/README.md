# aws-emulator S3 adapter and SSM readers spike (AI-734)

Runs the real `S3ObjectStorageAdapter` (from `packages/storage-s3`'s build) and the
real SSM Parameter Store readers and writers (`packages/admin-installer/src/app-creds.ts`,
`pulumi-passphrase.ts`, `packages/app-client/src/credentials.ts`) against
[AWS Emulator](https://github.com/aws/aws-emulator), then prints one row per
operation: outcome (`ok` / `differs` from AWS / `failed`), milliseconds, and the
exact result or emulator error.

Findings: [docs/aws-emulator/03-s3-ssm.md](../../../docs/aws-emulator/03-s3-ssm.md).

## Run it

From the repo root, on Linux (x86_64 or arm64) with Node 22+, `pnpm`, `curl`,
`dpkg-deb` and `gpgv`, after `pnpm install` at the root:

```bash
bash spikes/aws-emulator/s3-ssm/run.sh
```

About 30 s, most of it downloading the 163 MiB package. The script:

1. installs this directory's own dependencies (`pnpm install --ignore-workspace`);
2. builds `@starkeep/storage-s3` and `@starkeep/protocol-primitives` (and their
   workspace dependencies) with turbo;
3. downloads, verifies (`gpgv`, pinned AWS key) and unpacks the emulator, starts it
   and waits for `GET /__admin/health` — the steps of
   [`../runtime/run.sh`](../runtime/run.sh), unchanged;
4. runs `s3.mjs` under plain `node` and `ssm.mjs` under `tsx` (admin-installer is
   source-only), both with the emulator's environment;
5. runs `packages/storage-s3`'s vitest suite twice, with the emulator endpoint and
   with a dead one, to show whether any test reaches S3;
6. stops the emulator and prints the summary and the table (`report.mjs`).

No AWS account or credentials are used. Every credential variable the SDK could
read is removed, both drivers refuse to run unless `AWS_ENDPOINT_URL` is
`https://127.0.0.1:<port>`, and the only keys are the ones the emulator generates
for the run (deleted when it stops). Secret values (the HMAC secret) are printed
only as their shape.

The same options as the runtime spike apply: `EMULATOR_VERSION` (default pinned in
`run.sh`, or `latest`), `EMULATOR_INSTALL` (`extract`, default, or `apt`),
`EMULATOR_DATA_PORT` (default `9297`). Exit code is 0 when both drivers ran to
the end, whatever the per-operation outcomes, and 1 when one aborted.

In a git worktree whose main checkout is not writable, turbo cannot create its
shared cache; set `TURBO_CACHE_DIR=$PWD/.turbo/cache` first.

Standalone like the runtime spike: own `package.json` and `pnpm-lock.yaml`, not in
`pnpm-workspace.yaml`, not run by `ci.yml`.
