# Architecture intent

## Bootstrap

A single CloudFormation bootstrap stack creates the foundational IAM resources:

- **Admin-app role** — assumed by the admin-web Lambda; can assume Manager.
- **Manager role** — can create per-app roles (within the permissions boundary) and attach/detach temp install/uninstall policies.
- **App permissions boundary** — an IAM managed policy that caps what any per-app role can do.
- **Foundational permissions boundary** — caps the Manager and other privileged roles.

## App install lifecycle

Apps are installed via `packages/admin-installer`'s orchestrator:

1. **Manager mints the per-app role** (`${stackPrefix}-app-${appId}-role`) with the permissions boundary attached. The role's trust policy allows the Lambda execution principal (cloud-data-server's role) to assume it.
2. **Manager attaches the temp-install policy** — a scoped policy that grants just enough access for the install steps: SSM (Pulumi passphrase), S3 (state bucket + artifacts bucket), IAM (attach/detach own policies), DSQL (connect as admin during DDL), Lambda/API Gateway (Pulumi up).
3. **App's own session** — the orchestrator STS-assumes Manager → app role. Under these credentials it:
   - Runs DSQL DDL: creates the per-app PG role (`${stackPrefix}_app_${appId}`), schema, tables, and grants.
   - Uploads the Lambda artifact zip to the artifacts bucket.
   - Runs `pulumi up` via the Automation API to create Lambda(s), log groups, API Gateway integrations, and JWT-authenticated routes.
4. **Manager detaches the temp-install policy** — the app role is left with only its permanent, scoped permissions.
5. Access policies and the app registry entry are recorded (phase 2: DSQL-backed; currently no-op stubs).

## Per-app compute

Apps that declare `infraRequirements.compute.enabled: true` in their manifest get Lambda functions and API Gateway routes managed by Pulumi Automation API (`packages/admin-installer/src/compute-stack.ts`).

- Pulumi state is stored in `${stackPrefix}-pulumi-state-${accountId}-${region}` (S3).
- The Pulumi passphrase is in SSM at `/${stackPrefix}/pulumi/passphrase`.
- Routes are prefixed with `/apps/${appId}` automatically for non-`$default` routes.
- Every Lambda receives standard env vars: `STARKEEP_APP_ID`, `STARKEEP_STACK_PREFIX`, `STARKEEP_DSQL_HOSTNAME`, `STARKEEP_FILES_BUCKET`, plus any handler-specific `env` from the manifest.

## Runtime request flow

All app API requests flow through the shared API Gateway → the target app's Lambda. The Lambda execution role IS the per-app role, so it connects to DSQL using `dsql:DbConnect` (not Admin) as `${stackPrefix}_app_${appId}`.

## Key references

- Role taxonomy and credential chain: `docs/role-taxonomy.md`
- Canonical install implementation: `packages/admin-installer/`
- Per-app manifest schema: `packages/admin-manifest/src/schema.ts`
