---
name: starkeep-app-anatomy
description: Use when creating, restructuring or debugging the shape of a Starkeep app — its folder layout, starkeep.manifest.json, install lifecycle, publicPaths, browser mount and build mode.
when_to_use: Creating or restructuring a Starkeep app; editing starkeep.manifest.json; deciding which paths are public; wiring the browser build, base path, fetch URLs or router basename; or asking "why does my app 401", "why does it show the mock backend", "why is it serving old assets", "why did my manifest edit do nothing".
---

# Starkeep app anatomy

A router into the authoring docs plus the gotchas they leave implicit. The docs
are the source of truth: open the linked section before you change anything, and
treat this file as the map. Where a gotcha is not in the docs, the source that
defines it is cited.

Source links point at `main` of
[starkeep-core](https://github.com/myleshenderson/starkeep-core). Doc links point
at the copies shipped inside this plugin under `ref/`.

## Shape of an app

| Question                                               | Read                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| What counts as an app at all                           | [What an app is](../../ref/docs/authoring-an-app.md#what-an-app-is)                                                   |
| Browser half vs. server half, and the four reach rules | [The two halves](../../ref/docs/authoring-an-app.md#the-two-halves-and-the-platforms-answer-for-each)                 |
| Which app to copy                                      | [The example app](../../ref/docs/authoring-an-app.md#the-example-app)                                                 |
| Which parts are required, and when                     | [The pieces, at a glance](../../ref/docs/authoring-an-app.md#the-pieces-at-a-glance)                                  |
| The minimum that installs on both surfaces             | [The smallest app](../../ref/docs/authoring-an-app.md#the-smallest-app)                                               |
| One app id across web, cloud, phone, desktop           | [Structuring an app with several flavors](../../ref/docs/authoring-an-app.md#structuring-an-app-with-several-flavors) |
| The example's folder map                               | [example-app Layout](../../ref/example-app/README.md#layout)                                                          |
| The rename checklist for a copy                        | [example-app Copying it](../../ref/example-app/README.md#copying-it)                                                  |

- **Copy `example-app/`, never `test-apps/probe`.** Probe is the platform's test
  fixture, deliberately austere (no browser bundle, shell written as a string).
  See [Probe, the platform's fixture](../../ref/docs/authoring-an-app.md#probe-the-platforms-fixture).
- Do all five steps of [Copying it](../../ref/example-app/README.md#copying-it),
  including the `@example-app/` scope in every `package.json` and import, and
  `common/src/ids.ts`. A copy that keeps the id `example-app` collides with the
  real one, which admin-web registers by default: when two folders hold one id,
  Discover apps offers neither, or only the one already installed (`scanApps` in
  [`app-discovery.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-installer/src/app-discovery.ts)).

## Manifest

Read [2. Write `starkeep.manifest.json`](../../ref/docs/authoring-an-app.md#2-write-starkeepmanifestjson).
Things agents get wrong:

- **Unknown keys are rejected at every level**, with a did-you-mean suggestion
  (doc §2). Every object in the schema is a `z.strictObject`
  ([`schema.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/schema.ts));
  the suggestion is built in
  [`validate.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/validate.ts).
  Do not invent fields; look them up in `appManifestSchema`.
- **`description` is a declared, optional top-level field.** Keep it; it is not
  the cause of a validation error (`appManifestSchema` in `schema.ts`; doc §2
  "Optional fields").
- **`localRun.cwd` is relative to the manifest**, so `"cwd": "web"` starts in
  `web/` ([several flavors](../../ref/docs/authoring-an-app.md#structuring-an-app-with-several-flavors)).
- **`localRun.command` serves the built app, never a dev server** (doc §2,
  `localRun`). No `vite`, `vite dev` or `next dev` here.
- **`installDependencies` and `bundle` must match the approved command table**
  under [Installing it](../../ref/docs/authoring-an-app.md#installing-it)
  (`pnpm|npm|yarn|bun run <script>` for a bundle). Anything else is not run:
  install leaves it to the operator, and a cloud install stops before it deploys.
- **Validate in a test**: `validateManifest()` from `@starkeep/admin-manifest`
  (dev dependency; doc [§1](../../ref/docs/authoring-an-app.md#1-install-the-sdk-packages)
  and §2). It runs the same route and `publicPaths` checks the installer does,
  so a test catches them before an Install click.

## Install lifecycle

Read [Installing it](../../ref/docs/authoring-an-app.md#installing-it).

**The manifest is applied once, at install.** Install pins the app's folder and
the approved manifest (step 3). Editing `starkeep.manifest.json` afterwards
changes nothing: no new table, index, label key, grant, route or `localRun`
takes effect. To apply an edit, either:

- click **Update from folder** on the app's card in admin-web. The card offers
  it once the folder's manifest differs from the installed one (doc step 3; UI
  in
  [`LocalAppsSection.tsx`](https://github.com/myleshenderson/starkeep-core/blob/main/apps/admin-web/src/components/LocalAppsSection.tsx)).
  A cloud install of the app refuses until the local card is updated; or
- from a starkeep-core checkout, run `scripts/upgrade-app.sh <appId>`
  (`--diff <appId>` previews what is stale, with no writes; `--diff` alone
  checks every installed app). **The docs do not mention this script.** Its
  header comment
  ([`scripts/upgrade-app.sh`](https://github.com/myleshenderson/starkeep-core/blob/main/scripts/upgrade-app.sh))
  is the reference: it reapplies every schema step idempotently through the
  local data server, which must be running, and keeps rows, the HMAC secret and
  the install date.

**Neither is a migration.** Tables are created `IF NOT EXISTS`, so a column
whose declared type changed keeps its physical type. A change that crosses a
storage class needs a drop, and only Uninstall drops the app's tables (same
header comment). In development, uninstall and reinstall rather than writing a
migration.

## `publicPaths`

Read the four rules under
[The two halves](../../ref/docs/authoring-an-app.md#the-two-halves-and-the-platforms-answer-for-each)
and the cloud checklist under
[10. Who authenticates the end user](../../ref/docs/authoring-an-app.md#10-who-authenticates-the-end-user-in-your-app).
Then the parts that only the source states:

- **Each entry becomes its own `ANY <path>` route with no authorizer**, under
  `auth: "session"`. `/x/*` becomes `/x/{proxy+}`; a literal stays itself
  (`publicPathRoutePath` in
  [`routes.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/routes.ts)).
- **A derived route replaces any declared route on the same path, whatever its
  method** (`resolveHandlerRoutes`, same file). Listing `/api/thing` as public
  when you declared only `POST /api/thing` makes it `ANY /api/thing`, anonymous,
  for every method. Make public only paths that are safe for anyone to call
  with any method.
- **`/*` is refused**: it derives `ANY /{proxy+}` and would un-gate the whole
  handler, data proxy included (`validate.ts`, the "wildcard over the whole
  handler" error).
- **The validator does not check for `/sign-in`.** A session handler must have a
  non-empty `publicPaths` (`validate.ts`, the "or nobody can sign in" error),
  but any one entry satisfies it. Without `/sign-in` and `/api/session/*`
  public, the first cloud request returns the gateway's raw
  `{"message":"Unauthorized"}` instead of a sign-in page.
- **`staticAssetPaths` must be a subset of `publicPaths`**, enforced by a schema
  refinement in `schema.ts`.

Start from the example's list in
[`example-app/starkeep.manifest.json`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/starkeep.manifest.json)
(handler `static`): `/`, `/_immutable/*`, `/sign-in`, `/api/session/*`,
`/starkeep-runtime-config`. Add to it deliberately and never remove the session
pair.

## Mount and fetches

In the cloud an app lives under `/apps/<appId>/`; locally it owns its origin at
`/`. The server half is covered by the fourth rule under
[The two halves](../../ref/docs/authoring-an-app.md#the-two-halves-and-the-platforms-answer-for-each):
write Hono routes app-relative, `honoUpstream` strips `/apps/<appId>`, and
`appBasePath()` from `@starkeep/app-client/hono` gives the mount for an absolute
redirect or a link printed into HTML.

**The browser half is not documented beyond "route prefix to bake in"**
([§7](../../ref/docs/authoring-an-app.md#7-cloud-compute--the-bundle-cloud-target-only)).
How the example does it:

1. The installer runs the bundle script with
   `STARKEEP_APP_BASE_PATH=/apps/<appId>`
   ([`cli-install-app.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-installer/scripts/cli-install-app.ts)),
   and sets the same variable on the Lambda for `appBasePath()`
   ([`pulumi-program.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-installer/src/pulumi-program.ts)).
   The example's
   [`web/scripts/bundle.mjs`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/web/scripts/bundle.mjs)
   passes it to `vite build`.
2. [`web/vite.config.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/web/vite.config.ts)
   sets Vite's `base` from it (`/` when unset, i.e. locally), so emitted asset
   URLs carry the mount.
3. The page reads `import.meta.env.BASE_URL`
   ([`web/src/browser/api.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/web/src/browser/api.ts))
   and builds every URL it fetches from it. A client-side router needs the same
   value as its basename.

**Failure mode:** `fetch("/api/...")` with a leading slash, or a `BrowserRouter`
without `basename={import.meta.env.BASE_URL}`, works locally (mount is `/`) and
in the cloud hits the deployment's root instead of the app, or matches no
route. Test with `STARKEEP_APP_BASE_PATH=/apps/<appId>` set for a build if you
cannot deploy.

## Build mode and stale output

Not documented in core; this section is the reference.

- **Two build paths, one setting.** The platform builds the browser half in two
  places: the `localRun` command (the example's `start`) and the `bundle`
  script. If your app has a build-time switch, for example a
  `VITE_DATA_BACKEND=mock|starkeep` flag read through `import.meta.env`, set it
  in **both**. Set only in a dev script, the mock backend ships to the local
  install, the cloud, or both, and every check that runs against the dev build
  stays green.
- **Start must rebuild.** The example's `start` is
  `vite build && tsx src/server/local.ts`
  ([`web/package.json`](https://github.com/myleshenderson/starkeep-core/blob/main/example-app/web/package.json)),
  so every **Start** in admin-web rebuilds `dist/`. A `start` that only serves
  serves whatever `dist/` last held, possibly a build from another branch or
  mode.
- **Rebuild before you judge.** Before you conclude a change "did not work" in
  the running app, restart it from admin-web (or rerun its `start`), and after a
  manifest change, apply it as in [Install lifecycle](#install-lifecycle).
  The cloud bundle is built fresh on each cloud install, so a cloud fix needs a
  reinstall too.

## Runtime config and the proxy

- Local vs. cloud data server is decided at request time, not build time:
  [3. Serve runtime config to the browser](../../ref/docs/authoring-an-app.md#3-serve-runtime-config-to-the-browser).
- The browser never holds the HMAC secret; every data call goes through your
  server's signing proxy:
  [4. Proxy + sign requests to the data server](../../ref/docs/authoring-an-app.md#4-proxy--sign-requests-to-the-data-server).

## Where to go next

- **`starkeep-cloud-and-sign-in`**: sign-in page, session routes, `endUserAuth`,
  the cloud bundle and web adapter.
- **`starkeep-data-model`**: shared records, files, labels and app-specific
  tables.
- **`starkeep-run-local`**: bringing up the local platform and running, installing
  and testing the app against it.
