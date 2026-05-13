# Follow-up: kill `@starkeep/admin-db` (deferred until cloud-data-server install is working)

## Context

User flagged that we don't want to depend on a full Postgres database server — we
use DSQL exclusively in the cloud and sqlite exclusively locally. `@starkeep/admin-db`
is a `pg`-backed Postgres package (reads `DATABASE_URL`), so it shouldn't be on
the live path.

Initial hypothesis: registry.ts has a stale reference; just delete the import
and the package.

That turns out to be wrong — see below.

## What's actually using admin-db

Single direct importer: `packages/admin-installer/src/registry.ts`.

`registry.ts` actively reads/writes three Postgres tables:

| function                                | table                | purpose |
|----------------------------------------|----------------------|---------|
| `recordStep` / `getCompletedSteps`     | `app_install_steps`  | per-step idempotency ledger driving `runStep` in `orchestrator.ts` |
| `registerApp` / `deleteAppRegistryEntry` | `app_registry`     | registered-app catalog |
| `createAccessPolicies` / `revokeAccessPolicies` | `access_policies` | per-app shared-type permissions |

`orchestrator.ts` (the per-app `installApp` / `uninstallApp` state machine)
consumes all six functions. `installApp` / `uninstallApp` are re-exported from
`admin-installer`'s `index.ts` but currently have **zero callers outside the
package** — the live install path is `installCloudDataServer`, which talks to
DSQL directly and does not touch admin-db.

So the orchestrator is dormant code today, but per the user it is the planned
path for non-built-in app install/uninstall and should be kept.

Other admin-db symbols (`getPool`, `AwsSettingsRepository`,
`AppRegistryRepository`, `AccessPoliciesRepository`): zero consumers outside
admin-db itself. Two `@deprecated` comments in
`packages/admin-core/src/aws-settings.ts` mention `AwsSettingsRepository` but
don't import it.

## Options for replacing admin-db

1. **Port the three tables into DSQL.** Fits the "DSQL in cloud, sqlite local"
   rule. `shared.app_install_steps` and `shared.access_grants` already exist in
   our DSQL schema init (close but not identical to what registry.ts uses); we'd
   add a `shared.app_registry` table and rewrite the four repository methods to
   use a DSQL `pg` connection like `dsql-ddl.ts` does. Medium effort, clean.

2. **Drop the ledger entirely.** Same route `installCloudDataServer` already
   takes: existence checks (does the IAM role exist? is the bundle in S3?) and
   let Pulumi handle compute-step idempotency. Access policies/registry become
   DSQL rows on `shared.access_grants` only. Smaller surface, less moving
   state, but loses the "resume from exact failed step" property.

User leaning toward option (1) but wants cloud-data-server install working
first before tackling this.

## When picking this up

- Confirm option choice with user.
- If (1): add `shared.app_registry` to `packages/admin-installer/src/dsql-schema-init.ts`,
  rewrite `registry.ts` to use a DSQL connection (mirror `dsql-ddl.ts`), then
  delete `packages/admin-db/` and the workspace dependency in
  `packages/admin-installer/package.json`.
- Either way: clean up the two `@deprecated` `AwsSettingsRepository` comments
  in `packages/admin-core/src/aws-settings.ts`.
