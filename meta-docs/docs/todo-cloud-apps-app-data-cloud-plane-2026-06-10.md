# TODO: Cloud-side app-data plane (HTTP read/write of synced app-specific data)

App-specific data sync to the cloud already works: every per-app sync
channel's `/sync/exchange` is wired with an `appSyncableSource`
(`packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts:771-779`),
so rows an app writes to its declared `appSpecificSyncable` tables locally
get pushed into the corresponding cloud per-app tables on the next exchange.

What does **not** exist is an HTTP read/write surface on the cloud data
server analogous to local-data-server's `/app-data/db/<table>` and
`/app-data/files/<key>` routes (`apps/local-data-server/server.ts:1322-1410`).
A cloud-served app has no way to read or write its own synced
app-specific data through the cloud data server, even though the data is
sitting there.

Concrete symptom: the cloud-served photos app calls
`/api/photos/captions/[id]` (route at
`starkeep-apps/photos/app/api/photos/captions/[id]/route.ts`, called from
`src/photos-ui/components/viewer/photo-info-panel.tsx:39`). The Next route
runs in the cloud Lambda, calls `loadAppCredentials("photos")` which finds
no local creds file, and returns
`503 "photos has not been installed locally"`. Even if creds existed, the
underlying `signedFetch(creds, "/app-data/db/image_enriched?...")` would
404 because the cloud data server doesn't expose that path.

## Scope

- Add `/app-data/db/<table>` (GET, POST, PATCH, DELETE) and
  `/app-data/files/<key>` (PUT, GET, DELETE) handlers to the cloud data
  server's API handler, scoped to the calling app's identity (resolved
  from the existing JWT/auth path, just as the per-app sync channel
  already is).
- Enforce the same manifest gate the local server does — refuse ops on
  tables the app didn't declare in `appSpecificSyncable`.
- Reuse the existing per-app appSyncableSource client wiring; this is
  the HTTP front door for the same storage the sync exchange writes to.

## Proving example

Once the cloud plane exists, rewire
`starkeep-apps/photos/app/api/photos/captions/[id]/route.ts` so that in a
cloud build it forwards to the cloud data server's `/app-data/db/image_enriched`
(through the same auth path the rest of `/data/...` uses) instead of
calling `loadAppCredentials` and dying with 503. The caption fetch in
`photo-info-panel.tsx` should then succeed in cloud, mirroring local.

## Priority

High. Without this, no cloud-served Starkeep app can interact with its
own synced app-specific data — the captions 503 is the visible tip; every
app that stores enriched state through `appSpecificSyncable` has the same
hole. This is a foundational gap, not an app-level bug.
