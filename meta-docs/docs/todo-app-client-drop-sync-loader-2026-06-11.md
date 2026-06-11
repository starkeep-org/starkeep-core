# Delete sync `loadAppCredentials`; make the async loader the only API

`@starkeep/app-client` exports two credential loaders today:

- `loadAppCredentials(appId)` — synchronous, reads
  `~/.starkeep/app-creds/${appId}.json` from disk.
- `loadAppCredentialsAsync(appId)` — async, fetches from SSM in cloud
  mode and delegates to the sync form in local mode.

The sync form was kept for "backwards compatibility" with the pre-cloud
shape, but in cloud mode it can't fetch from SSM (SSM is async only)
and short-circuits to `null`. That's the source of the silent
"app not installed" 503 from cloud-served Next.js routes that haven't
been migrated to the async loader.

**The sync form is not useful in practice.** Every existing caller is
inside an `async` Next.js route handler, so `await`-ing the loader
costs nothing functionally. There is no caller today that genuinely
*needs* synchronous credential resolution.

## Fix shape

1. In `packages/app-client/src/credentials.ts`:
   - Delete `loadAppCredentials` (the sync export).
   - Rename `loadAppCredentialsAsync` → `loadAppCredentials` (no point
     in the suffix once there's only one). The function stays async.
   - Drop the `cache` map's sync-population path; keep only the
     `cloudCache` promise map (rename to `cache`).
2. In `packages/app-client/src/index.ts`: drop the
   `loadAppCredentialsAsync` re-export; `loadAppCredentials` is now
   the async function.
3. In `packages/app-client/src/next.ts`: make `createNextProxyHandler`
   `await` the loader.
4. Migrate the ~10 in-tree call sites in `starkeep-apps/photos/app/api/*`
   (route.ts files under `/api/photos`, `/api/photos/[id]`,
   `/api/photos/crop`, `/api/photos/style-graphic`, `/api/resize`) from
   `const creds = loadAppCredentials("photos")` to
   `const creds = await loadAppCredentials("photos")`. Every one is
   already inside an `async` handler.
5. Bump `@starkeep/app-client` to `0.2.0` (breaking change since the
   sync export is removed), republish, bump consumers in
   `starkeep-apps/photos/package.json` and
   `starkeep-apps/photos/infra/package.json`.

## Why this kills the gap entirely

If there is no sync API, no caller can silently get `null` in cloud
mode by picking the wrong function. Cloud and local both go through
one loader that does the right thing per `STARKEEP_APP_CLIENT_MODE`.

## Source

From doc id 18 (`functional-doc-cloud-apps-2026-06-05.md`), Part 2 —
Potential gaps ("Cloud-mode `loadAppCredentials` synchronous call
returns null silently"). Reframed during processing on 2026-06-11
after recognizing the sync form has no remaining legitimate use case.

## Revisit when

Before adding any new cloud-served Lambda that calls the app-client.
Sooner if a developer ever hits a "503 not installed" debugging
session and traces it back to the wrong loader.
