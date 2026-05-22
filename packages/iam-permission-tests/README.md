# @starkeep/iam-permission-tests

Observational IAM check: replay every AWS call the installer makes
through [`@cloud-copilot/iam-simulate`](https://github.com/cloud-copilot/iam-simulate)
against the policy that's actually attached to the calling principal at
that moment. Any call the simulator says is denied is either a real
permission gap or a bug in our context model — both worth catching
before AWS catches them at runtime.

## Layout

- `src/contexts.ts` — registry of named IAM contexts (principal +
  identity policies + boundary). Each context pulls policies from the
  same builders the installer uses at runtime, so policy edits flow
  through automatically. Add new contexts here.
- `src/parse-tf-trace.ts` — extracts AWS calls from Pulumi traces
  (PULUMI_OPTION_VERBOSE=9 + LOGTOSTDERR + TF_LOG=DEBUG output).
- `src/parse-sdk-trace.ts` — extracts AWS calls from the Node-side
  SDK middleware (`sdk-trace.ts`).
- `src/sdk-trace.ts` — installs a one-time monkey-patch on
  `@smithy/smithy-client`'s `Client.prototype.send` to record every
  AWS v3 SDK call to a file.
- `src/simulate.ts` — drives `runSimulation` per captured call.
- `src/cli.ts` — `--context=<name> <trace-file>...` driver.
- `test/sdk-mapping.test.ts` — guard test that every SDK→IAM action
  rename still resolves to a real action in `@cloud-copilot/iam-data`.

## Two evidence sources

Every `simulate` run combines:

1. **Expected calls (modeled).** A static list each context declares of
   the AWS calls it will make at install/runtime, with concrete action +
   resource ARN (see `expectedCalls` on each ContextBuilder). This is
   the authoritative "deployments will work" check — independent of any
   live install, so you can run it before deploying.
2. **Captured calls (optional).** Trace files supplement the model with
   what really happened. Captured SDK calls carry the principal that
   made them (`sdk-trace.ts` resolves credentials → assumed-role ARN at
   send time, learning the mapping from `AssumeRole` / `GetCallerIdentity`
   outputs), so a multi-role trace can be evaluated against each role's
   context separately. Calls whose principal doesn't match the context
   role are reported as skipped, not failed. Pulumi/TF traces don't
   carry caller identity, so all of those calls are included.

Verdict counts split into Allowed / Denied / Engine-error.
`ExplicitlyDenied`/`ImplicitlyDenied` fail the run (exit 1). `Error` is
a simulator-engine limitation (e.g. `apigatewayv2` isn't in iam-data,
the verb-on-path `apigateway:GET` model isn't supported); these are
reported but do not fail the exit code.

## Workflow

### 1. Capture traces

Run a real install. The admin-web "Deploy to Cloud" route already sets
the right env vars (see TEMP blocks in
`apps/admin-web/app/api/cloud-data-server/install/route.ts`):

```
~/.starkeep/cds-install.trace       # pulumi-aws HTTP traffic
~/.starkeep/cds-install.sdk.trace   # Node-side @aws-sdk calls
```

Or run the installer CLI directly with both env vars set:

```sh
TF_LOG=DEBUG \
PULUMI_OPTION_LOGFLOW=true PULUMI_OPTION_LOGTOSTDERR=true PULUMI_OPTION_VERBOSE=9 \
IAM_SDK_TRACE_PATH=$(pwd)/cds-install.sdk.trace \
  pnpm -F @starkeep/admin-installer cli:install-cloud-data-server 2> cds-install.trace
```

### 2. Simulate

```sh
pnpm -F @starkeep/iam-permission-tests simulate --list-contexts

ACCOUNT_ID=<id> REGION=us-east-2 \
  pnpm -F @starkeep/iam-permission-tests simulate \
    --context=install-cloud-data-server \
    ~/.starkeep/cds-install.trace \
    ~/.starkeep/cds-install.sdk.trace
```

For per-app install runs (photos, etc.) the admin-web cloud-install
route writes `~/.starkeep/photos-install.{trace,sdk.trace}`. A per-app
install wears two IAM hats in sequence — simulate against each context
separately (same trace files, different `--context`):

```sh
# DSQL DDL phase (install-ddl-role + temp-install-ddl-<appId>)
ACCOUNT_ID=<id> REGION=us-east-2 APP_ID=photos \
  pnpm -F @starkeep/iam-permission-tests simulate \
    --context=install-ddl \
    ~/.starkeep/photos-install.trace \
    ~/.starkeep/photos-install.sdk.trace

# AWS-resource provisioning phase (install-infra-role + temp-install-infra-<appId>)
ACCOUNT_ID=<id> REGION=us-east-2 APP_ID=photos \
  pnpm -F @starkeep/iam-permission-tests simulate \
    --context=install-infra \
    ~/.starkeep/photos-install.trace \
    ~/.starkeep/photos-install.sdk.trace
```

Calls made by the Manager role itself (CreateRole, PutRolePolicy on
the per-app role and on install-ddl/install-infra-role) are correctly
*skipped* by the principal filter in each per-app context — Manager
has a standing policy, not a temp grant, and is a separate concern.

Both contexts also work standalone (no trace) — the modeled expected
calls run as a static check:

```sh
ACCOUNT_ID=<id> REGION=us-east-2 APP_ID=photos \
  pnpm -F @starkeep/iam-permission-tests simulate --context=install-ddl
```

Multiple trace files are unioned per (principal, service:operation).
The CLI auto-detects format per file (Pulumi vs SDK). Pass `--no-filter`
to disable the principal scoping if you want to see every captured call
evaluated against the chosen context.

### 3. Run the guard test

```sh
pnpm -F @starkeep/iam-permission-tests test
```

This fails fast if iam-data ever drops or renames an action we depend
on in the SDK→IAM mapping.

## Adding a new context

1. Add an entry to `CONTEXTS` in `src/contexts.ts` with its identity
   policies, boundary, and assumed-role ARN shape. Reuse the same
   policy builders the installer uses — don't copy.
2. Capture a trace under that context (run the relevant install /
   runtime path with the trace env vars set).
3. Invoke `simulate --context=<your-name> <trace>`.

## What this catches vs. doesn't

**Catches:** action missing from policy ∩ boundary. The most common
real-world failure (`pulumi up` or an SDK call blowing up with
`AccessDenied`).

**Misses, for now:**
- **Resource-scoped denies.** Resource is passed as `*` to the
  simulator when the parser can't recover an ARN. A policy that
  restricts `s3:PutObject` to a specific bucket would still simulate
  as Allowed against `*`.
- **API Gateway named actions.** `apigateway:GetApi/GetStage/etc.`
  surface as `invalid.action` because the management API uses a
  verb-on-path permission model (`apigateway:GET` on
  `arn:aws:apigateway:region::/v2/apis/*`) that we don't yet model.
- **Condition keys we don't populate.** Most of `aws:RequestTag/*`,
  `aws:SourceArn`, etc. are missing — the simulator treats them as
  absent, which may evaluate more permissively than reality.
- **Resource policies.** We're only simulating the principal side. The
  S3 bucket policy this stack creates is its own concern.

## SDK→IAM action renames

`SDK_TO_IAM_ACTION` in `parse-tf-trace.ts` is a hand-maintained table
for cases where the SDK operation name doesn't match the IAM action
name (S3's "Bucket" prefix drops, Head→List/Get aliases). Add entries
here as new mismatches surface. The guard test in
`test/sdk-mapping.test.ts` will fail on entries that can't be found in
iam-data — so typos and stale renames are caught immediately.

## Related

- `packages/admin-installer/scripts/check-temp-vs-boundary.ts` — the
  *static* counterpart. Asserts every action in a temp policy is also
  permitted by the matching boundary. This package adds the
  observational side: every call we actually made is in policy ∩
  boundary.

## TEMP markers to remove when retiring the POC

- `apps/admin-web/app/api/cloud-data-server/install/route.ts` — env
  vars + file tee
- `apps/admin-web/app/api/apps/photos/cloud-install/route.ts` — env
  vars + file tee
- `packages/admin-installer/src/compute-stack.ts` — `onError`
  forwarding for pulumi stderr
- `packages/admin-installer/scripts/cli-install-cloud-data-server.ts` —
  conditional `installSdkTrace` import
- `packages/admin-installer/scripts/cli-install-photos.ts` —
  conditional `installSdkTrace` import

Grep for `iam-permission-tests POC` to find them all.
