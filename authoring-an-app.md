# Writing your own Starkeep app

This is a how-to guide for building an installable Starkeep app. It walks through
the parts an app is made of — what each one is for, and which are required vs.
optional — using the canonical **Photos** app in the sibling
[`starkeep-apps/`](../starkeep-apps) repo as a worked example. File references
below point at `starkeep-apps/photos/`.

For the system this app plugs into — the data servers, how data is classified,
and how it syncs — read [`system-design.md`](system-design.md) first. For the
trust boundaries, see [`data-roles-and-permissions.md`](data-roles-and-permissions.md).

## What an app is

An app is **any directory that contains a `starkeep.manifest.json`, lives inside
a parent directory admin-web is configured to scan, and depends on the published
`@starkeep/*` packages.** There is no privileged build wiring against
`starkeep-core` — first-party apps like Photos install through the exact same
path a third-party app would.

Apps are **thin clients**. The SDK, type registry, database, and object storage
all live in the data-server process (local or cloud). Your app talks to a data
server over HTTP and is otherwise a pure presentation/logic layer. You generally don't
embed storage or run access control yourself — you make authenticated requests
and the data server enforces the rules.

## The pieces, at a glance

| Part | Required? | What it's for |
| --- | --- | --- |
| `starkeep.manifest.json` | **Required** | Declares identity, install targets, and the file/table access the app needs. |
| `@starkeep/app-client` | **Required** | Request signing, the local-data proxy, and the runtime-config handler. The only `@starkeep/*` package Photos needs at runtime. |
| `@starkeep/admin-manifest` | Optional | The manifest schema + `validateManifest()` — useful in tests to catch manifest errors before install. |
| Runtime-config route | **Required** | Tells the browser whether this build is paired with a cloud data server or the local one. |
| Local-data proxy route | **Required (local target)** | Server-side proxy that signs browser requests with the app's HMAC credential. |
| A data client | **Required** | The code that actually calls `/data/records`, `/files/presign`, etc. |
| `appSpecificSyncable` tables/files | Optional | App-private rows and blobs that sync alongside shared records. |
| `compute` handlers + `pnpm bundle` | Optional (cloud only) | Lambda handlers and the deployment-zip builder for a cloud install. |
| Auth gate | Required in cloud | Gates the UI behind Cognito sign-in when talking to a remote data server. |

---

## 1. Install the SDK packages

```bash
pnpm add @starkeep/app-client       # required at runtime
pnpm add -D @starkeep/admin-manifest # optional — manifest validation in tests
```

`@starkeep/app-client` is the only `@starkeep/*` package the app needs at
runtime. Your `package.json` always declares published version ranges, never
`workspace:*` paths into a sibling repo — see `photos/package.json`. (To iterate
on core and an app together, use `pnpm link` / `overrides`; that's a dev-only
ergonomics workflow.)

## 2. Write `starkeep.manifest.json`

This is the heart of the app and the only required file. It's the contract the
admin installer reads to validate the app, prompt the user for grants, and
provision per-app credentials. See `photos/starkeep.manifest.json` for the worked
example and `@starkeep/admin-manifest`'s `appManifestSchema` for the full schema.

**Required fields**

- `id` — stable app id (e.g. `"photos"`). Must match the app id you pass to the
  proxy handler and use in your data-client paths.
- `name`, `version` — display name and semver.
- `tier` — `"official" | "verified" | "community"`.

**Common fields**

- `targets` — `["local"]`, `["cloud"]`, or both. Defaults to `["local"]`. The
  admin Dashboard derives its Local/Cloud lists from this.
- `infraRequirements.fileAccess[]` — the **shared file types** the app operates
  on. Each entry lists exact `<category>/<format>` type ids (e.g. `image/jpeg`),
  an `access` of `"read"` or `"readwrite"`, an optional `metadataWrite` flag (to
  write into the shared metadata table for those types), and a `rationale` shown
  to the user at install. Photos enumerates the raster image types and sets
  `metadataWrite: true` because it writes EXIF/dimensions.
- `localRun` — how admin-web spawns the app's dev/serve process (`command`,
  `args`, optional `portFlag`). Without it, the app can't be started from the
  admin UI. With `portFlag`, admin-web allocates a free port and appends it.

**Optional fields** — `protocolMinVersion`, `requiredPermissions` /
`optionalPermissions`, `homepage`, `author`, `license`, plus the
`appSpecificSyncable` and `compute` blocks covered in §6–§7.

> Two grants are reserved and rejected by the validator for normal apps:
> `infraRequirements.fileAccessAll` (all file types — Drive / User-Data-Owner
> only) and `brokerPower` (cloud-data-server only). Installable apps enumerate
> types in `fileAccess`.

Validate it in a test with `validateManifest()` from `@starkeep/admin-manifest`
to catch errors before install.

## 3. Serve runtime config to the browser

A build doesn't know at compile time whether it's talking to the local or cloud
data server — it's decided at request time from env. Expose a runtime-config
route so the client can branch:

```ts
// app/starkeep-runtime-config/route.ts
import { createRuntimeConfigHandler } from "@starkeep/app-client";
export const dynamic = "force-dynamic";   // read env per-request, not at build
export const GET = createRuntimeConfigHandler();
```

`getRuntimeConfig()` reads the `STARKEEP_*` env block (API Gateway URL, Cognito
pool ids, S3 bucket/region). A local-only build sees these undefined and falls
back to the same-origin local proxy; a cloud build populates them from the env
its compute handler declares (§7).

## 4. Proxy + sign requests to the local data server

The browser must never hold the app's HMAC secret. Add a server-side proxy route
that signs and forwards:

```ts
// app/api/local-data/[...path]/route.ts
import { createNextProxyHandler } from "@starkeep/app-client";
const handler = createNextProxyHandler({ appId: "photos" });
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
```

`@starkeep/app-client` loads the HMAC secret from
`$STARKEEP_DATA_DIR/app-creds/<appId>.json` (written by admin-web at install
time, mode 0600) and adds `X-Starkeep-App-Id` + signature headers. Same-origin,
so no CORS. The data-server URL (default `127.0.0.1:9820`) is resolved
server-side.

## 5. Write a data client

This is where you actually use the platform. Your client resolves the target
(local proxy vs. remote API Gateway + bearer token), then calls the data-server
HTTP API. See `src/lib/data-client.ts` (target resolution + Cognito token
refresh) and `src/lib/data-server-client.ts` (the calls). The key endpoints:

- `POST /files/presign` then S3 `PUT`, then `POST /data/records` — upload large
  file bytes out-of-band, then register the record by content hash (bypasses the
  API Gateway ~7 MB inline-body cap).
- `GET /data/records` — list records. **A type-less query is server-scoped to the
  app's granted types**, so Photos gets every image type in one call without
  hardcoding a type filter.
- `GET /data/records/:id/file-url` — presigned download URL.
- `POST /data/records/:id/metadata` — write into the shared metadata table
  (requires `metadataWrite` in the manifest).

For the local target these go through the `/api/local-data` proxy from §4; for a
remote target they go to `<apiGatewayUrl>/apps/<appId>/...` with a
`Authorization: Bearer` header.

**A note on type granularity.** A Starkeep type is a two-level
`<category>/<format>` id (e.g. `image/jpeg`) — it resembles a MIME type but is
the platform's own namespace, with extra categories like `archive`. Two
different granularities are in play, and it's easy to confuse them:

- A **record's `type`** is the full `<category>/<format>` id, and read/write
  access is gated against the exact type. So you set `type` from the file
  (`image/jpeg`, `image/png`, …) and your manifest's `fileAccess.types` lists
  those same full ids. A bare category like `"image"` is **not** a valid record
  type or grant key and won't match anything.
- **Category-namespaced resources** — object-storage keys (`shared/<category>/…`)
  and the per-category metadata table — authorize at the *category* level. This
  is why `data-server-client.ts` passes the bare `"image"` as the object-key
  prefix and as the metadata `typeId`, while still creating the record with the
  full `image/jpeg` type. The bare value there is the **category**, not a record
  type.

**A note on advisory labels.** If your app writes shared records that may not be
of interest to *other* apps that read that same type, include a `label` on
`POST /data/records` so those apps can easily filter them out. The convention is
`<yourAppId>/<purpose>` — e.g. Photos tags each generated thumbnail
`photos/thumbnail`, so a different image-declaring app can skip the thumbnails
and show only the originals. Guidance:

- Only label records that are genuinely lower-interest to *other* apps (derived,
  auxiliary, machine-generated). A record the user would think of as their own
  content — an uploaded original, a user-made crop — should stay **unlabeled**
  (`null` label = general interest).
- The label is advisory: it does not restrict access or hide anything, it only
  gives readers a cheap way to filter. Reading apps decide whether to honor it
  (e.g. a `WHERE label IS NULL` / `label != 'photos/thumbnail'` filter, or the
  `label` filter on `GET /data/records`).
- The prefix must be your own app id; the data server rejects a write whose
  label prefixes another app's id. Set it once at creation — it is immutable.
- It is not a substitute for `parentId`. `parentId` is the structural link from a
  derived record to its source; `label` is the interest hint. A thumbnail sets
  both.

---

## Optional parts

### 6. App-specific syncable data

> **Note — there is no runtime "policy" or "bootstrap" step.** An app's access to
> shared types comes entirely from the `fileAccess` block in its manifest (§2): at
> install the data-server writes one `shared_access_grants` row per declared
> `<category>/<format>` type, and both data servers enforce reads/writes against
> those rows (full type for records, category for object keys and metadata — see
> the granularity note at the end of §5). The app itself calls nothing at startup
> to grant access.

**App-specific syncable data.**  Starkeep can sync app-specific data so it's available in the cloud and across devices. Declare it under `infraRequirements.appSpecificSyncable`:

- `tables[]` — each becomes `<appId>_syncable_<name>` locally and syncs row-wise.
  `updated_at` / `deleted_at` are reserved by the sync runtime. Photos declares an
  `image_enriched` table (caption, title, date override).
- `files: true` — opt into an `apps/<appId>/syncable/` object-storage prefix for
  app-private blobs. Leave false for row-only apps.

### 7. Cloud compute + the bundle (cloud target only)

To install to the cloud, declare compute handlers and ship a bundler.

In the manifest, `infraRequirements.compute`:

```jsonc
"compute": {
  "enabled": true,
  "handlers": [
    { "name": "api", "handler": "infra/src/resize-handler.handler",
      "memoryMb": 512, "timeoutSeconds": 30, "routes": ["POST /api/resize"] },
    { "name": "static", "handler": "index.handler",
      "routes": ["GET /", "GET /{proxy+}"], "auth": "public",
      "env": { "STARKEEP_API_GATEWAY_URL": "", "STARKEEP_USER_POOL_ID": "", ... } }
  ]
}
```

Each handler names a Lambda entry point **inside your `dist.zip`**, its routes,
memory/timeout, `auth` (`"jwt"` default or `"public"`), and the `env` keys the
platform fills in (these feed `getRuntimeConfig()` from §3).

Then provide a `pnpm bundle` script — the app-owned half of the install contract.
The installer invokes it with two env vars and consumes the zip it writes:

```
env in:  STARKEEP_APP_BASE_PATH = /apps/<appId>   (route prefix to bake in)
         STARKEEP_BUNDLE_OUT    = <abs path>       (where to write dist.zip)
out:     dist.zip at STARKEEP_BUNDLE_OUT
```

See `infra/build-bundle.ts` for the contract and a full OpenNext + sharp example.
Knowledge of your framework, native deps, and asset layout lives entirely in this
script — the platform only ever sees a `dist.zip`.

### 8. Gate the UI behind sign-in (cloud target only)

When paired with a remote data server, requests need a Cognito token. Wrap the
app in an auth gate that checks for a refresh token and shows a sign-in form
otherwise — see `src/lib/AuthGate.tsx` and `SignInForm.tsx`. For local builds the
gate is a no-op (`not-required`).

---

## Installing it

The install path is identical for first-party and third-party apps:

1. Place the app dir inside a parent directory registered with admin-web. The
   sibling `starkeep-apps/` is seeded by default; add others via the **App
   discovery** card on the Dashboard.
2. Click **Install** on the app's card. Admin reads and validates the manifest,
   prompts you to approve the requested grants, and POSTs to `local-data-server`
   to register the app and provision its per-app HMAC credential.
3. For a cloud target, the installer additionally runs your `pnpm bundle` and
   deploys the resulting handlers.

See [`starkeep-apps/README.md`](../starkeep-apps/README.md) for the install steps
from the app-author's side, and the root [`README.md`](README.md) for the
end-user local/cloud setup walkthrough.
