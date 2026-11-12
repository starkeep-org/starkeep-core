# aws-emulator Cognito sign-in spike (AI-682)

Creates Starkeep's Cognito resources through the API on
[AWS Emulator](https://github.com/aws/aws-emulator), mirroring
`packages/aws-bootstrap/src/bootstrap/bootstrap-template.ts` (user pool, admin and
devices app clients, both groups, domain, identity pool, admin role, role mapping),
then runs the real code against them and prints one row per step: outcome (`ok` /
`differs` from AWS / `failed`), milliseconds, and the exact result or emulator error.

The code under test, all from TypeScript source under `tsx`:

- `apps/admin-web/src/lib/cognito-auth.ts`: `initiateAuth`, `respondNewPasswordChallenge`,
  `refreshTokens`, `getIdentityPoolCredentials`;
- `packages/admin-installer/src/cognito-auth.ts`: `cognitoPasswordAuthTokens`,
  `getIdentityPoolCredentials`, `regionFromUserPoolId`;
- `packages/protocol-primitives/src/device-session/cognito-client.ts`: `createCognitoClient`
  with `endpoint` set (the seam `STARKEEP_COGNITO_ENDPOINT` feeds in the local data server);
- `packages/app-client/src/auth/verify.ts` `verifyIdToken`, and `auth/cognito.ts` `refreshTokens`;
- `apps/admin-web/src/routes/users.ts`: the user-management route handlers, called with the
  identity-pool credentials the admin's sign-in produced.

Findings: [docs/aws-emulator/04-cognito.md](../../../docs/aws-emulator/04-cognito.md).

## Run it

From the repo root, on Linux (x86_64 or arm64) with Node 22+, `pnpm`, `curl`,
`dpkg-deb` and `gpgv`, after `pnpm install` at the root:

```bash
bash spikes/aws-emulator/cognito/run.sh
```

About 35 s, most of it downloading the 163 MiB package. The script:

1. installs this directory's own dependencies (`pnpm install --ignore-workspace`);
2. builds `@starkeep/app-client` with turbo (`users.ts` imports its `dist`);
3. downloads, verifies (`gpgv`, pinned AWS key) and unpacks the emulator, starts it
   and waits for `GET /__admin/health`: the steps of [`../runtime/run.sh`](../runtime/run.sh), unchanged;
4. runs `cognito.mjs` under `tsx` with the emulator's environment and a throwaway
   `STARKEEP_DIR` (the user routes read the pool id from its `config.json`);
5. stops the emulator and prints the summary and the table (`report.mjs`).

No AWS account or credentials are used. Every credential variable the SDK could read
is removed, the driver refuses to run unless `AWS_ENDPOINT_URL` is
`https://127.0.0.1:<port>`, and it wraps `fetch` so nothing in the process can reach a
host other than 127.0.0.1 (the code paths that hard-code the public Cognito host are
stopped there and reported). Tokens, passwords and keys are printed only as their
shape (`<JWT, 800 chars>`, `EMULATOR… (20 chars)`).

The same options as the runtime spike apply: `EMULATOR_VERSION` (default pinned in
`run.sh`, or `latest`), `EMULATOR_INSTALL` (`extract`, default, or `apt`),
`EMULATOR_DATA_PORT` (default `9297`). Exit code is 0 when the driver ran to the end,
whatever the per-step outcomes, and 1 when it aborted.

In a git worktree whose main checkout is not writable, turbo cannot create its shared
cache; set `TURBO_CACHE_DIR=$PWD/.turbo/cache` first.

Standalone like the other spikes: own `package.json` and `pnpm-lock.yaml`, not in
`pnpm-workspace.yaml`, not run by `ci.yml`.
