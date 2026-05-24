# Sync TODOs

## App IDs containing `/` break cloud-side routing and IAM naming

`@starkeep/watcher` (the only currently-scoped app id) is marked
`active` in the local registry and the LDS supervisor starts a sync
engine for it, but it has no cloud presence at all — no
`starkeep-app-@starkeep/watcher-role` exists, and the cloud Lambda logs
show its requests landing on `starkeep-app-@starkeep-role` (the `/watcher`
suffix is dropped). Three independent reasons this never works as-is:

1. **API Gateway path routing.** The LDS encodes the appId in
   `/apps/%40starkeep%2Fwatcher/...`, but API Gateway HTTP API v2
   unconditionally decodes `%2F` before the handler sees `event.rawPath`.
   The handler's `parseAppPath` then matches `[^/]+` and captures only
   `@starkeep` (`cloud-data-server/src/api-handler.ts:213-216`).

2. **IAM role names disallow `/`.** Allowed chars are `[A-Za-z0-9+=,.@_-]`
   (per AWS docs). Anywhere the installer builds
   `${stackPrefix}-app-${appId}-role` raw — `iam.ts:262`, `:429`, `:447`,
   plus the policy ARN templates in `temp-policies.ts` — IAM would reject
   the create call for a slash-containing appId. The watcher slipping past
   this without an error means it's never gone through the installer.

3. **DSQL/Postgres role names too.** `dsql-ddl.ts:272-273` derives
   `${stackPrefix}_app_${appId}` lowercased; Postgres disallows `/` in
   identifiers. The same applies to the `apps/${appId}/` S3 prefix
   templates in `temp-policies.ts` (legal for S3 but breaks the per-app
   prefix isolation pattern).

Two-part design decision needed before any code change:

- **Is `@starkeep/watcher` actually supposed to sync to the cloud?** Its
  `app_syncable_namespaces` row is `[]` and it only originates *shared*
  types (`image`) consumed by other apps' engines. If the watcher is
  origination-only and not itself a syncing engine, the LDS supervisor
  should skip it — that's a one-line filter in `sync-supervisor.ts`
  (e.g. only start an engine for apps with a non-empty namespace row),
  and bug 2 evaporates without any cloud-side change.

- **If scoped app ids should ever be cloud-installable**, pick an
  encoding scheme (`/` → `__` is the obvious one — `__` is legal in IAM,
  PG, S3 prefixes, and URL paths) and apply it consistently across
  installer role naming, DSQL role naming, S3 prefix templates, and the
  handler's `parseAppPath`. Or simpler: forbid `/` in cloud-installable
  app ids at install time and rename the watcher.
