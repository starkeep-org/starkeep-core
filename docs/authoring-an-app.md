# Writing your own Starkeep app

This is a how-to guide for building an installable Starkeep app. It walks through
the parts an app is made of — what each one is for, and which are required vs.
optional. The worked example is the **example app** in
[`example-app`](../example-app), a small app that performs every
app-facing data operation and shows each request on its page. Copy that folder to
start an app. The **Photos** app in the sibling
[`starkeep-apps/`](../../starkeep-apps) repo is the full-size reference: a real
browser UI, image processing and a phone app. File references below that name no
folder point at `starkeep-apps/photos/`.

For the system this app plugs into — the data servers, how data is classified,
and how it syncs — read [`system-design.md`](system-design.md) first. For the
trust boundaries, see [`data-roles-and-permissions.md`](data-roles-and-permissions.md).

## What an app is

An app is **any directory that contains a `starkeep.manifest.json`, is
configured in admin-web's app discovery or lives inside a folder that is, and
depends on the published `@starkeep/*` packages.** There is no privileged build wiring against
`starkeep-core` — first-party apps like Photos install through the exact same
path a third-party app would.

Apps are **thin clients**. The SDK, type registry, database, and object storage
all live in the data-server process (local or cloud). Your app talks to a data
server over HTTP and is otherwise a pure presentation/logic layer. You generally don't
embed storage or run access control yourself — you make authenticated requests
and the data server enforces the rules.

## The two halves, and the platform's answer for each

A Starkeep app's browser half is a **static bundle**. A Starkeep app's server
half is a **declared set of request handlers**. The platform owns the seam
between the two and owns nothing else about either.

Each half is still the app's own choice, and the platform states a default for
each so an author makes one fewer decision and a reviewer reads one shape:

- **The browser half builds with [Vite](https://vitejs.dev).** `vite build`
  writes an `index.html` shell plus content-hashed assets. The shell is a file
  the platform serves from disk on both surfaces, not a response the app
  renders.
- **The server half is a [Hono](https://hono.dev) app.** Hono routes web
  `Request`s and returns web `Response`s, which is the only shape the platform
  consumes.

The contract between the halves is one function of `Request -> Response`. Hono
spells that function `app.fetch`. Two adapters consume it, and neither asks the
app to know which surface it runs on:

- **Cloud** — `createWebAppHandler` from `@starkeep/app-client/web`, given
  `app.fetch` through `honoUpstream` from `@starkeep/app-client/hono`. See §7.
- **Local** — `@hono/node-server`'s `serve({ fetch: app.fetch, port })`, started
  by admin-web from the manifest's `localRun`. See §2. Mount `serveStatic` from
  `@starkeep/app-client/hono` ahead of your routes, and the local server answers
  your build output with the same responder the cloud adapter uses. See §7.

Four rules govern what a browser reaches, and the manifest states each one:

- **`publicPaths` enumerates paths and never wildcards them.** Each entry
  removes the gateway's authorizer from one path. An entry covering the
  catch-all removes the authorizer from the whole app, so the schema refuses
  such an entry outright.
- **`staticAssetPaths` is a subset of `publicPaths`, and every entry names a
  literal path or a file-backed prefix.** The static branch answers before the
  app's own gate runs, which makes each entry an enforcement bypass by
  construction. The schema enforces the subset relation.
- **`/_immutable/*` and `/_static/*` are the reserved prefixes for build
  output.** `/_immutable/` holds content-hashed files and is the only prefix
  cached forever. `/_static/` holds files with stable names, which every
  request revalidates. In the cloud, CloudFront serves both prefixes from S3,
  so no request for them reaches your Lambda. A handler with
  `staticAssetPaths` names its build-output directory in `bundleAssetsDir`. The
  installer copies the two prefixes from it, and measures every other file the
  Lambda serves against the Lambda's response limit.
- **App routes are written app-relative.** `honoUpstream` strips the
  `/apps/<appId>` mount before Hono routes the request, so one route table
  matches on both surfaces. Call `appBasePath()` for the two cases where a
  browser resolves a URL itself: an absolute redirect, and a link printed into
  HTML.

### The example app

[`example-app`](../example-app) is the shape to copy. It is
one folder holding one app: one manifest at the root, one pnpm workspace, and a
package per flavor. Its `web` package serves both web surfaces from one Hono
app, `src/server/app.ts`. The local surface starts `src/server/local.ts` and the
cloud surface runs `src/server/cloud.ts`. The browser half, under `src/browser/`,
calls every data-plane route through the signing proxy, and its page shows each
request with its status. The manifest declares a second compute handler, `api`,
for one JWT-gated route, `POST /api/echo` (`src/server/echo.ts`). The page
calls it with a Bearer token from `GET /api/session/token` in the cloud, and
same-origin with no token locally. The example reads and writes only `example/plaintext`,
a type that exists for it alone, so trying it on a real deployment never mixes
invented files into anyone's library.

The example is its own workspace with its own lockfile, so a copy installs
anywhere. Its `README.md` lists what to rename. Two CI jobs keep it honest: one
runs its end-to-end suite against core's current platform, and one copies the
folder out of the repository and installs, typechecks, builds and bundles it.

### Probe, the platform's fixture

`test-apps/probe` in this repository is the smallest app that touches every
surface the platform offers: a served shell, a sign-in flow, a signing proxy, a
shared-record write path, a declared label vocabulary, an app-private table and
a JWT-gated compute route. Read `src/app.ts` for the server half, `src/serve.ts`
for the local surface and `src/static-handler.ts` for the cloud one.

Probe is a fixture the platform tests itself against rather than a template to
copy. The tier-2 and tier-3 suites install Probe, drive it and assert the
result, so a change that breaks the pattern breaks those suites first. Being a
fixture also makes Probe austere on purpose: Probe writes its shell as a string
and ships no browser bundle at all, because a fixture carrying a build step
would test the build step. Copy the example app rather than Probe.

## The pieces, at a glance

| Part                                   | Required?             | What it's for                                                                                                                                    |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `starkeep.manifest.json`               | **Required**          | Declares identity, install targets, and the file/table access the app needs.                                                                     |
| `@starkeep/app-client`                 | **Required**          | Static file serving on both surfaces, request signing, the signing proxy, sign-in and the runtime-config handler.                                |
| `@starkeep/admin-manifest`             | Optional              | The manifest schema + `validateManifest()` — useful in tests to catch manifest errors before install.                                            |
| Runtime-config route                   | If the app uses data  | Tells the browser whether this build is paired with a cloud data server or the local one.                                                        |
| Signing proxy route                    | If the app uses data  | Server-side proxy that signs browser requests with the app's HMAC credential. Serves both surfaces, and carries the end-user decision (§4, §10). |
| A data client                          | If the app uses data  | The code that actually calls `/data/records`, `/files/presign`, etc.                                                                             |
| `appSpecificSyncable` tables/files     | Optional              | App-private rows and blobs that sync alongside shared records.                                                                                   |
| `compute` handlers + a `bundle` script | Optional (cloud only) | Lambda handlers and the deployment-zip builder for a cloud install.                                                                              |
| Sign-in page + session routes          | Required in cloud     | A `/sign-in` page (`createSignInPage`, or your own) and the `/api/session` routes, so a person can sign in to the cloud surface (§8).            |
| Server-side end-user check             | **Required in cloud** | Nothing upstream of your app checks who the end user is. See §10.                                                                                |

"If the app uses data" means the app reads or writes Starkeep data: shared
records, files, labels or its own app-specific tables. An app that keeps no
data with Starkeep needs none of those rows, and nothing checks for them.

### The smallest app

An existing web app can install on both surfaces before it touches Starkeep
data. The smallest app has these parts:

- **A manifest** with `localRun`, and for the cloud a `compute` block with one
  `static` handler (§2, §7).
- **A Hono server half** that mounts `serveStatic` ahead of its routes for the
  local surface (§7).
- **For the cloud,** a bundle whose entry calls `createWebAppHandler`, a
  `/sign-in` page from `createSignInPage`, and the routes from
  `createSessionRoutes` (§7, §8). Every cloud app page requires sign-in, because
  a cloud app serves the members of one deployment.

Add the data pieces when the app first needs them. An app that keeps state in
the browser's `localStorage` is the common case: that state stays on one
browser, and a new origin loses it. Moving the state into an app-specific
syncable table (§6) syncs it between devices and keeps it through a change of
origin. That move needs the runtime-config route, the signing proxy and a data
client.

---

## 1. Install the SDK packages

```bash
pnpm add @starkeep/app-client       # required at runtime
pnpm add -D @starkeep/admin-manifest # optional — manifest validation in tests
```

`@starkeep/app-client` is the only `@starkeep/*` package the app needs at
runtime. Declare the Starkeep platform packages, the ones published from
`starkeep-core`, by published version range. Never point them at a path into a
core checkout, through `workspace:*`, `link:` or `file:`: a copy of your app
then fails to install anywhere that checkout is absent. See
`example-app/web/package.json`. Your app's own packages are a different
case. The example's flavors depend on `@example-app/common` as `workspace:*`,
which is fine because the dependency never leaves the app's own folder. (To
iterate on core and an app together, use `pnpm link` / `overrides`; that's a
dev-only ergonomics workflow.)

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
- `infraRequirements.labelKeys[]` — the **cross-app labels** this app publishes.
  Each entry is a `key` (lowercase identifier, ≤64 chars) and a `description`
  shown to anyone browsing what your app declares. Max 64 keys per app. Any key
  not declared here is rejected at write time. See §9.
- `localRun` — how admin-web spawns the app's server process (`command`,
  `args`, optional `portFlag`). Without it, the app can't be started from the
  admin UI. With `portFlag`, admin-web appends the app's port. Each installed
  app keeps one port, and so one browser origin, so the app's `localStorage`
  and IndexedDB survive restarts. The app gets a new port, and with it empty
  browser storage, only when it is reinstalled or when the operator moves it
  off a port that another program holds.
  Name the command that serves the built app, never a development server: an
  operator starting the app from the Dashboard is running the product, and a
  compile-on-demand server there costs seconds on every navigation and ships a
  development build of React.
- `installDependencies` and `bundle` (optional) — the commands the installer
  runs in the app's folder: the dependency install at **Install**, and the
  cloud bundle build (§7). Each is `{ command, args, cwd }`, with `cwd`
  relative to the manifest and inside the app's folder. Omit them to let the
  installer infer the commands from your lockfile. A command must match the
  approved list in "Installing it", or the installer does not run it.

**Optional fields** — `description`, `protocolMinVersion`,
`requiredPermissions` / `optionalPermissions`, `homepage`, `author`,
`license`, plus the `appSpecificSyncable` and `compute` blocks covered in
§6–§7.

Validation rejects any key the schema does not declare, at every level of the
manifest, and suggests the declared key when the spelling is close. A
misspelled optional field would otherwise read as a field left out.

`protocolMinVersion` names the lowest platform protocol version the app
needs, and defaults to `"1.0.0"`. The platform's version is `PROTOCOL_VERSION`
in `@starkeep/protocol-primitives`, and both data servers report it on
`GET /health`. The minor version rises when the platform adds something an app
can depend on, such as a file type, a route or a manifest field. The major
version rises when a change breaks apps written for an earlier version. Set
the field to the version that added the newest feature your app uses. Both
installers refuse an app whose requirement the platform does not meet, and
name both versions. A local data server keeps the code it started with, so
after a `git pull` it can report an older version until it restarts.

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
// src/server-app.ts
import { createRuntimeConfigHandler } from "@starkeep/app-client";
const runtimeConfig = createRuntimeConfigHandler();
app.get("/starkeep-runtime-config", () => runtimeConfig());
```

The handler reads the environment on every call, so a Node server gives the
per-request behavior by construction and needs no build-time opt-out.

`getRuntimeConfig()` reads the `STARKEEP_*` env block (API Gateway URL, Cognito
pool ids, S3 bucket/region). A local-only build sees these undefined and falls
back to the same-origin local proxy; a cloud build populates them from the env
its compute handler declares (§7).

## 4. Proxy + sign requests to the data server

The browser must never hold the app's HMAC secret. Add a server-side proxy route
that signs and forwards:

```ts
// src/routes/local-data.ts
import { createDataProxyHandler, sessionAuth } from "@starkeep/app-client";
export const proxy = createDataProxyHandler({ appId: "photos", endUserAuth: sessionAuth() });

// src/server-app.ts — one mount, every verb.
app.all("/api/local-data/*", (c) => {
  const path = c.req.path.slice("/api/local-data/".length).split("/").filter(Boolean);
  return proxy(c.req.raw, { params: Promise.resolve({ path }) });
});
```

`@starkeep/app-client` loads the HMAC secret from
`$STARKEEP_DATA_DIR/app-creds/<appId>.json` (written by admin-web at install
time, mode 0600) and adds `X-Starkeep-App-Id` + signature headers. Same-origin,
so no CORS. The data-server URL (default `127.0.0.1:9820`) is resolved
server-side.

**This same mount is your cloud data path.** There is no second route for the
cloud: the package decides server-side whether to forward to the loopback
local-data-server or, under `STARKEEP_APP_CLIENT_MODE=cloud`, to the shared API
Gateway with the secret pulled from SSM. The `local-data` segment in the URL is
historical and describes only where the route originally pointed.

That is why **`endUserAuth` is required, not optional**. This handler holds
your app's HMAC credential and will sign whatever reaches it, and on the cloud
surface nothing upstream is checking who the caller is (§10). Answer it with
one of:

- `sessionAuth()` — refuse callers with no valid session. This is the answer
  for almost every app, and the example app uses it. It checks the platform's
  session cookie (§8), and the proxy returns `401` before the credential is
  loaded at all. Local mode is exempt by default, because on-device data
  belongs to the person at the keyboard and a sign-in gate there would break
  local-first; pass `sessionAuth({ allowAnonymousLocal: false })` to gate both
  surfaces.
- `{ auth: "session", verifySession }` — the same check with a verifier you
  write. `sessionAuth()` returns this form with the platform's verifier filled
  in. Write your own only if your users do not sign in through the platform's
  session.
- `{ auth: "anonymous", justification }` — sign for anyone. Legitimate only
  when everything behind the proxy is genuinely public. The justification
  string is there to be read by a reviewer, so write one you would defend.

**On the local surface, serve the app with `serveLocal`.** The session check
is exempt there, so whoever reaches the server can make it sign. Pages in the
person's own browser reach it, so the server must refuse two kinds of request
before any route runs:

- **A `Host` that is not a loopback name.** A DNS-rebinding page reaches
  `127.0.0.1` under a hostname it controls, and could otherwise read your
  server's answers as its own.
- **A request from a page on another site.** A page on any site can send a
  blind `no-cors` POST to `127.0.0.1` with a loopback `Host`. Its
  `text/plain` body needs no preflight, and the data server parses it as JSON.
  Every port on one loopback address is one site, so `same-site` is another
  site here. A `GET` or `HEAD` navigation still passes, so a link from
  admin-web opens your app.

`serveLocal` from `@starkeep/app-client/local` makes both checks on every
route. It also reads the port admin-web passes on `--port`, binds `127.0.0.1`
and serves your static files ahead of your routes, as the cloud adapter does.
`serveLocal` reads only `--port`, so set the manifest's `localRun.portFlag` to
`"--port"`. This server is what `localRun` starts:

```ts
// src/server/local.ts — what the manifest's `localRun` starts.
import { serveLocal } from "@starkeep/app-client/local";
import { app } from "./app.js";

serveLocal({
  app,
  static: {
    assetsDir: new URL("../../dist/", import.meta.url),
    staticPaths: ["/", "/_immutable/*"], // the handler's staticAssetPaths
    immutablePaths: ["/_immutable/*"],
    shellPaths: ["/"],
  },
});
```

Probe's `test-apps/probe/src/serve.ts` is a complete local server built this
way. An app that builds its own server mounts `localSurfaceGuard()` from
`@starkeep/app-client/hono` first, ahead of `serveStatic` and every route.
`createDataProxyHandler` checks `Sec-Fetch-Site` for the proxy itself, on both
surfaces, but only the local guard covers your other routes.

## 5. Write a data client

This is where you actually use the platform. Your client resolves the target
(local proxy vs. remote API Gateway + bearer token), then calls the data-server
HTTP API. See `src/lib/data-client.ts` (target resolution + Cognito token
refresh) and `src/lib/data-server-client.ts` (the calls). The key endpoints:

- `POST /files/presign` then S3 `PUT`, then `POST /data/records` — upload large
  file bytes out-of-band, then register the record by content hash (bypasses the
  API Gateway ~7 MB inline-body cap).
- `GET /data/records` — list records, under the query grammar of §9b. **A query
  naming no type is server-scoped to the app's granted types**, so Photos gets
  every image type in one call without hardcoding a filter.
- `GET /data/records/:id/file-url` — presigned download URL.
- `POST /data/records/:id/metadata` — write into the shared metadata table
  (requires `metadataWrite` in the manifest).

For the local target these go through the `/api/local-data` proxy from §4; for a
remote target they go to `<apiGatewayUrl>/apps/<appId>/...` with a
`Authorization: Bearer` header.

The example app's `web/src/browser/api.ts` calls every route this guide lists,
one function per route, and is the quickest place to see a request's exact shape.

**A note on type granularity.** A Starkeep type is a two-level
`<category>/<format>` id (e.g. `image/jpeg`) — it resembles a MIME type but is
the platform's own namespace, with extra categories like `archive`. Two
different granularities are in play, and it's easy to confuse them:

- A **record's `type`** is the full `<category>/<format>` id, and read/write
  access is gated against the exact type. So you set `type` from the file
  (`image/jpeg`, `image/png`, …) and your manifest's `fileAccess.types` lists
  those same full ids. A bare category like `"image"` is **not** a valid record
  type or grant key and won't match anything.
- **Category-namespaced resources** — object-storage keys
  (`shared/<category>/…`) — authorize at the _category_ level. This is why
  `data-server-client.ts` passes the bare `"image"` as the object-key prefix
  while still creating the record with the full `image/jpeg` type. The bare
  value there is the **category**, not a record type.

  The category is a **ceiling**, not a gate. It says what an app could possibly
  reach; the per-type grant says what it may actually read.

- **Per-category metadata now authorizes per type**, not per category.
  `GET /data/records/:id/metadata/:typeId` resolves the record and checks your
  grant against the record's own type; the `typeId` in the path decides nothing
  and is kept only because callers send it. Declaring `image/jpeg` and
  `image/png` no longer reaches an `image/svg` record's metadata. If a type
  matters to your app, declare it.

**A note on advisory labels.** If your app writes shared records that may not be
of interest to _other_ apps that read that same type, include a `label` on
`POST /data/records` so those apps can easily filter them out. The convention is
`<yourAppId>/<purpose>` — e.g. Photos tags each generated thumbnail
`photos/thumbnail`, so a different image-declaring app can skip the thumbnails
and show only the originals. Guidance:

- Only label records that are genuinely lower-interest to _other_ apps (derived,
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

**App-specific syncable data.** Starkeep can sync app-specific data so it's available in the cloud and across devices. Declare it under `infraRequirements.appSpecificSyncable`:

- `tables[]` — each becomes `<appId>_syncable_<name>` locally and syncs row-wise
  (§6b explains how conflicting writes resolve).
  `updated_at` / `deleted_at` are reserved by the sync runtime. Photos declares an
  `image_enriched` table (caption, title, date override).
- `files: true` — opt into an `apps/<appId>/syncable/` object-storage prefix for
  app-private blobs. Leave false for row-only apps. An app names each file by a
  sub-key of its choosing, such as `exports/notes-1.json`:
  - `POST /app-data/files/presign`, the `PUT`, then
    `POST /app-data/files/<subKey>/record` stores one;
  - `GET /app-data/files/<subKey>` and `POST /app-data/file-urls` sign URLs to
    read them;
  - `DELETE /app-data/files/<subKey>` deletes one;
  - `GET /app-data/files?prefix=exports/&limit=…&page_token=…` lists them in
    sub-key order. The response is `{files, truncated, page_token}`, and each
    file carries `sub_key`, `size_bytes`, `mime_type`, `original_filename` and
    `created_at`.
- `indexes[]` on a table — an ordered column list, e.g.
  `{"columns": ["deck_id", "due"]}`. Declare one for every filter and grouping
  your app actually issues. Without a matching index a filter is a full scan
  whatever the query looks like, which moves the cost rather than removing it.
  No uniqueness, no partial indexes: uniqueness is the primary key's job.

Column types are `text`, `integer`, `bigint`, `real`, `blob`, `boolean` and
`timestamp`. A `timestamp` column is physically `text` holding **canonical
ISO-8601 in UTC at millisecond precision** — exactly what JavaScript's
`toISOString()` produces. The write path rejects any other spelling, which is
the point: string comparison equals time comparison only while every writer
emits one format, and that is a correctness property the platform cannot check
unless you declare it.

A `boolean` column takes `true`, `false`, `0` or `1` and **always reads back as
`true` or `false`**, on both backends and over sync. The two backends store one
differently — an integer locally, a native boolean in the cloud — and the
platform converts at each edge so your app never sees the difference. Declare
`boolean` rather than `integer` for a flag: the declaration is what makes `2` or
`"yes"` a rejected write rather than a stored value, and locally it also becomes
a database constraint. A flag has **no ordering**, so `lt`, `lte`, `gt`, `gte`,
`min`, `max` and `order` all refuse a boolean column; use `is`, equality and
`ne`, which is every question a flag answers.

### 6a. Querying your app's tables

`GET /app-data/db/<table>` takes a query grammar. Every top-level parameter
name below is reserved, which is what lets filters live under `where` with no
sigil to keep them apart from column names — an unrecognized parameter is a
400 rather than being ignored.

```
GET /app-data/db/card_state
  ?where={"deck_id":"d1","suspended":0,"due":{"lte":"2026-09-09T00:00:00.000Z"}}
  &select=id,due,strength
  &order=due.asc,id.asc
  &limit=200
  &page_token=<opaque>
```

- **`where`** — strict JSON. A column maps either to a scalar, meaning
  equality, or to an object of operator to value. Operators are `lt`, `lte`,
  `gt`, `gte`, `ne`, `in`, `is`, `prefix` and `like`, joined with AND. `is`
  takes `null`, `true` or `false`; `is true` and `is false` apply to a `boolean`
  column only. `in` takes a JSON array, so nothing needs comma-escaping. There
  is no `or`; issue two requests and merge. The four ordered comparisons refuse
  a `blob` and a `boolean` column, neither of which has an ordering worth
  asking for.
- **`select`** — a comma-separated column list. Omitted means every column.
- **`order`** — `col.asc`, `col.desc`, optionally `.nullsfirst` or
  `.nullslast`. State the null position when it matters: the two backends
  default it differently, so the grammar makes you say.
- **`limit`** — default 30, maximum 500.
- **`aggregate`** — strict JSON, each key naming one output column:
  `{"due_count":{"fn":"count"},"next_due":{"fn":"min","col":"due"}}`. The
  functions are `count` (alone, with `col`, or with `distinct`), `sum`, `avg`,
  `min` and `max`. When `aggregate` is present, **`select` is the `GROUP BY`
  list** — the two are one list, because SQL requires every non-aggregate
  output column to be grouped.

`prefix` and `like` both match text and are not interchangeable. `prefix` takes
a literal and compiles to a half-open range, so it always seeks an index and
`%` or `_` inside your data means nothing. `like` takes a pattern where `%`
matches any run of characters and `_` matches exactly one; write `\%`, `\_` or
`\\` for those characters themselves, and any other backslash sequence is
rejected rather than silently matching the letter after it. Reach for `prefix`
when the question is "starts with"; reach for `like` when the pattern has a
wildcard anywhere else, which is the substring search `prefix` cannot express.
A pattern that starts with `%` cannot use an index and scans, which costs what
an equality filter on an unindexed column costs — declare an index for the
columns you filter on either way.

`like` is case-sensitive on both backends, deliberately and identically. `LIKE`
is case-insensitive for ASCII in stock SQLite and case-sensitive in Postgres, so
the platform pins the local side to the Postgres behaviour; a pattern that
matches in the cloud matches locally and the reverse.

**Five things that surprise people, and are cheaper to read than to discover:**

1. `sum` and `avg` return `null` over zero matching rows, not `0`. A coalesced
   result cannot tell an empty match from a zero total, so the server does not
   coalesce.
2. A grouped aggregate **omits empty groups entirely**. A deck with nothing due
   produces no row rather than a row holding zero; fill the gap from your own
   list.
3. `page_token` is opaque. Do not parse it — its shape is the server's to
   change.
4. A short page is signalled by `truncated`, and it can come from the row limit
   or from a 4 MB response budget. Never treat a short page as a complete
   result.
5. The grammar follows PostgREST's filter spelling and claims conformance to
   nothing. Top-level parameter names are reserved; column names live under
   `where`, `select` and `order`.

The response is `{rows, truncated, page_token}`, or `{groups, truncated}` in
aggregate mode.

### 6b. Writing rows, and how sync resolves conflicts

Each data server accepts writes on its own and syncs with the others later. The
local data server on each machine and the cloud data server are separate
surfaces, so a user can change one row on two surfaces before they sync.

**The newer write wins the whole row.** The platform stamps every write with a
hybrid logical clock (HLC) in `updated_at`, ships each changed row in full, and
keeps the row with the later stamp. The platform never merges columns, so the
earlier write's changes disappear, including changes to columns that the later
write never touched. Suppose a user renames an item on the desktop and archives
the same item in the cloud before the two sync. After sync, both surfaces keep
the rename or the archive, not both.

The rest of this section lists the patterns that keep the rule from losing data.

**Create with `POST`, edit with `PATCH`.** Three routes write to
`/app-data/db/<table>`:

- `POST` with `{"row": {...}}` upserts a row. On an existing key, the write
  overwrites every column the body names and clears any deletion. Add
  `"ifAbsent": true` to write only when no row holds the key (see "Seed with
  `ifAbsent`" below).
- `PATCH` with `{"where": {...}, "patch": {...}}` writes only the columns in
  `patch`. The `where` must name the whole primary key.
- `DELETE` with `{"where": {...}}` records a deletion, and the deletion syncs.
  The `where` must name the whole primary key.

Each route reports what the write did:

| Route                                  | Answer                                                 | Meaning                                                                              |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `POST`                                 | 200 `{"ok": true, "changes": 1}`                       | The row was written.                                                                 |
| `POST` with `ifAbsent`                 | 200 `{"ok": true, "changes": 0, "skipped": "live"}`    | A live row holds the key. Nothing was written.                                       |
| `POST` with `ifAbsent`                 | 200 `{"ok": true, "changes": 0, "skipped": "deleted"}` | A deleted row holds the key. Nothing was written.                                    |
| `PATCH`                                | 200 `{"changes": 1}`                                   | The live row was patched.                                                            |
| `PATCH`                                | 404 `{"changes": 0, "skipped": "missing"}`             | No live row holds the key. A deleted row answers the same as a missing one.          |
| `DELETE`                               | 200 `{"changes": 1}`                                   | The live row was deleted.                                                            |
| `DELETE`                               | 200 `{"changes": 0, "skipped": "deleted"}`             | The row was already deleted, so a retried delete succeeds.                           |
| `DELETE`                               | 404 `{"changes": 0, "skipped": "missing"}`             | No row, live or deleted, ever held the key.                                          |
| `PATCH` or `DELETE` with `ifUpdatedAt` | 409 `{"changes": 0, "skipped": "stale"}`               | The row changed since the read (see "Guard a read-modify-write" below).              |
| Any of the three                       | 409 `{"changes": 0, "skipped": "superseded"}`          | The row carries a newer stamp than the write, so the write lost and changed nothing. |

Each route takes only its own condition: `POST` takes `ifAbsent`, and `PATCH`
and `DELETE` take `ifUpdatedAt`. A route answers 400 for the other condition and
writes nothing, so a guard never silently goes missing.

An MCP tool or an API built on these routes can pass the 404 straight through
as "not found". No read beforehand is needed, and a read beforehand would race
the write anyway. The route answers other 404s too, such as for an app that
declares no app-syncable tables. Only a row 404 carries `"skipped": "missing"`,
so check `skipped` before reading a 404 as "no row".

A `superseded` answer is rare. A row that synced from a surface whose clock
runs ahead can carry a stamp above the stamp of this surface's next write. Read
the row again to see the state that won, and decide from there whether to write
again.

Edit with `PATCH`, and name only the changed columns. Never read a row, change
one field and `POST` the whole row back. Two clients of one data server, such as
two browser tabs or a browser and a headless client on the cloud surface, then
overwrite each other's edits. `PATCH` prevents that loss on one surface. Across
surfaces, the whole-row rule above still applies.

**Split fields that change independently into their own table.** Two fields of
one row may get edited on different surfaces at about the same time, such as an
item's name and its archived flag. Keep the second field in a separate table
keyed by the parent's id. Each table resolves conflicts on its own, so both
edits survive. Starkeep's own labels follow this pattern (`system-design.md`,
section "Sync semantics"). A split costs an extra write and an extra read, so
split only fields that face a real chance of concurrent edits.

**Expect duplicates wherever the app assumes uniqueness.** The platform enforces
no uniqueness beyond the primary key, and no platform could enforce it across
surfaces that write offline. Two surfaces can each create a row that breaks an
app-level rule before they sync. Write reads that tolerate the duplicate.

**Give starter rows deterministic ids.** An app that seeds starter rows on first
launch should compute each starter row's primary key from something every
surface shares, never from a random generator. Every surface then computes the
same id for the same starter row, so every surface seeds the same rows, and sync
keeps one copy. Two sources work:

- **A hash of the row's content.** This option needs nothing extra. A later app
  version that edits a starter row's content changes the hash, though, so the
  edited row seeds next to the old one instead of replacing it.
- **A constant key in the app's code**, such as `"getting-started"`, used as the
  id directly or through a name-based UUID (UUIDv5). The key exists only to
  compute the id and needs no column. The id survives content edits in later
  app versions.

**Seed with `ifAbsent`.** Reads hide deleted rows, so an app cannot tell "the
user deleted this starter row" from "this starter row was never written". A plain
`POST` of a starter row therefore brings a deleted starter back. Post each
starter row with `"ifAbsent": true` instead. The write lands only when no row,
live or deleted, holds the key, so a reseed adds new starter rows and leaves
deleted and edited ones alone. Every app version can then reseed on launch
without a "seeded" flag. The guarantee holds on one surface. A surface that has
not yet received a deletion from another surface still writes the seed, and the
later write wins at sync.

**Guard a read-modify-write with `ifUpdatedAt`.** `PATCH` protects the columns
a patch leaves out, but two clients that change the same column from one read
still lose one change. Appending to a notes column and incrementing a counter
both fail this way. To guard such a change, read the row with `updated_at` in
`select`, compute the new value, and send the stamp back:

```
PATCH /app-data/db/exercises
{"where": {"id": "e1"}, "patch": {"notes": "…"}, "ifUpdatedAt": "<updated_at as read>"}
```

A 409 means another write landed first. Read the row again, recompute, and
retry. `DELETE` accepts `ifUpdatedAt` too. The guard covers clients of one data
server only. A row arriving over sync also changes `updated_at`, and two
surfaces never compare stamps with each other, so the whole-row rule above
still decides conflicts across surfaces.

**Sort ordered lists with a primary-key tiebreak.** Two surfaces that each
append to a list before syncing can write the same position. Sort by the
position column and then the primary key, for example
`order=position.asc,id.asc`, so every surface shows duplicates in the same
order. Compute display numbers such as "Day 3" from the sorted order rather than
storing them.

**Use fractional order keys for lists that users reorder often.** Renumbering
integer positions rewrites every row in the list. A reorder on one surface then
overwrites any concurrent edit to any item on another surface, and two
concurrent reorders can interleave row by row into an order nobody chose. A
fractional order key is a string that sorts between its two neighbors, so a move
rewrites only the moved row with one `PATCH`. A fractional-indexing library
generates the keys. Keep the primary-key tiebreak, since two surfaces that
insert into the same gap can generate equal keys.

### 7. Cloud compute + the bundle (cloud target only)

To install to the cloud, declare compute handlers and ship a bundler.

In the manifest, `infraRequirements.compute`:

```jsonc
"compute": {
  "enabled": true,
  "handlers": [
    { "name": "static", "handler": "index.handler",
      "memoryMb": 256, "timeoutSeconds": 10,
      "routes": ["GET /", "ANY /{proxy+}"],
      "auth": "session",
      "publicPaths": ["/", "/_immutable/*", "/sign-in", "/api/session/*", "/starkeep-runtime-config"],
      "staticAssetPaths": ["/", "/_immutable/*"],
      "bundleAssetsDir": "assets",
      "env": { "STARKEEP_API_GATEWAY_URL": "", "STARKEEP_USER_POOL_ID": "", ... } },
    { "name": "api", "handler": "api.handler",
      "memoryMb": 256, "timeoutSeconds": 10,
      "routes": ["POST /api/echo"] }
  ]
}
```

This is the example app's manifest. Each handler names a Lambda entry point
**inside your `dist.zip`**, its routes, memory/timeout, `auth`, and the `env`
keys the platform fills in (these feed `getRuntimeConfig()` from §3).

`auth` decides how the gateway gates a handler's routes:

- `"session"` — the platform's session cookie, checked by the gateway's
  session authorizer. This is the answer for a browser app, because a
  navigation carries the cookie but cannot send an `Authorization` header. The
  authorizer gates every route on the handler, and each `publicPaths` entry
  becomes its own more specific route with no authorizer. The validator
  refuses a `session` handler with no `publicPaths`, because nobody could
  reach the sign-in page (§8). The example's `static` handler uses this mode.
- `"jwt"`, the default — a bearer token in `Authorization`, checked by the
  gateway's Cognito JWT authorizer. Use it for a route your page's own code
  calls, such as the example's `POST /api/echo`, and never for a page a
  browser navigates to.
- `"public"` — no gate at all.

**`auth: "public"` is wider than it looks, and the manifest makes you say so.**
It removes the authorizer from the route, and a handler that owns a catch-all
_is_ the whole app — every server route your bundle mounts, including the
signing proxy from §4, becomes reachable by anyone on the internet. A browser
app does not need it: `session` serves the shell and the sign-in page through
`publicPaths` and gates the rest. If you use `public` anyway, three things
narrow it:

- **`publicPaths`** — required whenever an anonymous route is a catch-all.
  List the sub-paths the opt-out was actually _for_. The installer checks the
  list against your real route table and refuses the install if it names a path
  you do not serve, or one the gateway would route somewhere authenticated.
  The declaration does not enforce anything; it is what makes the decision
  reviewable, and the installer prints it at install time.
- **A per-route `auth` override** — the object form of a route entry. API
  Gateway prefers a more specific route over `{proxy+}`, so a `"jwt"` route for
  your data subtree, pointed at the same Lambda, puts the authorizer back in
  front of it while the document at `/` stays open. Use this when your client
  can send a bearer token on its XHR; a session cookie is not a bearer token,
  so this composes with, rather than replaces, the check in §4.
- **The `endUserAuth` decision on your proxy (§4)** — the origin check, and the
  one that actually holds. See §10.

Then provide a `bundle` script — the app-owned half of the install contract.
The installer runs `<manager> run bundle` in the app's folder, with the package
manager your lockfile names (pnpm when there is none). To run another script or
from a subfolder, set the manifest's `bundle` field, for example
`{ "command": "pnpm", "args": ["run", "build:cloud"], "cwd": "web" }`. The
installer runs only `<manager> run <script>` and refuses any other command. It
invokes the script with two env vars and consumes the zip it writes:

```
env in:  STARKEEP_APP_BASE_PATH = /apps/<appId>   (route prefix to bake in)
         STARKEEP_BUNDLE_OUT    = <abs path>       (where to write dist.zip)
out:     dist.zip at STARKEEP_BUNDLE_OUT
```

See `photos/infra/build-bundle.ts` for the contract and a full worked example:
`vite build` for the browser half, `esbuild` for the Lambda entries, and a
platform-matched `sharp` binary staged by hand. Knowledge of your build, your
native deps and your asset layout lives entirely in this script — the platform
only ever sees a `dist.zip`.

**Your handler must load its module graph during Lambda's INIT phase.** INIT
runs at elevated CPU, is not billed, and has a budget separate from the
invocation timeout. A handler that defers the load into the first request pays
for the same work in the billed, timeout-bounded invocation instead. The
telemetry hides the trade: `Init Duration` still reads healthy, because the
entry module itself loaded quickly, and the seconds sit inside the request where
nothing labels them. Memo shipped that defect, reported `Init Duration` of
120–171 ms with 7766–8015 ms in the handler, and touched its ten-second timeout
before anyone looked.

Get the guarantee from the platform rather than by remembering it:

```js
import { createLambdaEntry } from "@starkeep/app-client/lambda";

export const handler = await createLambdaEntry({
  upstream: import("./app/index.mjs"),
});
```

`upstream` takes a **promise, not a thunk**. A thunk can be called at any time,
so a thunk-shaped API would permit exactly the defect above; a promise handed to
a top-level `await` has already started and must settle before the entry module
finishes evaluating, which is to say during INIT. Write your entry as an `.mjs`
file so top-level `await` is available.

The installer measures this. The post-install probe times the first request to a
declared public path against that handler's `timeoutSeconds`. It warns when
that request consumes more than half of the timeout and fails the install when
it consumes more than four fifths.

#### The web adapter, if your app serves a browser

Everything a browser-facing shell needs in front of its server half is the same
for every app, so the platform provides it:

```js
import { createWebAppHandler } from "@starkeep/app-client/web";
import { honoUpstream } from "@starkeep/app-client/hono";
import manifest from "./starkeep.manifest.json" with { type: "json" };

const shell = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");

export const handler = await createWebAppHandler({
  basePath: process.env.STARKEEP_APP_BASE_PATH,
  assetsDir: new URL("./assets/", import.meta.url),
  staticPaths: shell.staticAssetPaths,
  immutablePaths: ["/_immutable/*"],
  shellPaths: ["/", "/browse", "/settings"],
  requestUpstream: import("./app.js").then((m) => ({ handler: honoUpstream(m.app) })),
});
```

It owns six things: stripping the `/apps/<appId>` mount prefix (and treating the
bare prefix and its trailing-slash spelling as your app root), converting API
Gateway v2 events to and from web `Request`/`Response`, carrying cookies across
that conversion in both directions, serving your declared paths from a staged
directory with MIME resolution, refusing a path that escapes that directory, and
answering `immutable` for content-addressed assets and `must-revalidate` for
everything else. Every static response carries an `ETag`, so a browser
revalidates an unchanged file with a `304` instead of downloading it again. It
composes with `createLambdaEntry`, so adopting it gets you the INIT guarantee
without having to know the invariant exists.

The local surface serves the same files through the same responder.
`serveLocal` from `@starkeep/app-client/local` takes the static options above
and answers static paths ahead of your routes, which is where the cloud adapter
serves them (§4 shows the call). An app that builds its own server mounts
`serveStatic` from `@starkeep/app-client/hono`, the same responder as Hono
middleware, after `localSurfaceGuard()` and ahead of its routes. Probe's
`test-apps/probe/src/serve.ts` passes the static options to `serveLocal`.
Build those options in one module that the local entry and the cloud entry
both import, as the example app's `web/src/server/static-options.ts` does, so
the two surfaces cannot disagree about which paths are files.

`requestUpstream` hands your handler a web `Request` and the app-relative path.
`honoUpstream` rewrites the request's URL to that path before Hono routes it, so
**your routes never name the mount**, and one route table matches locally and
under `/apps/<appId>` in the cloud. When you need the origin-facing prefix, to
build an absolute redirect or print a link, call `appBasePath()`; nothing
derives the prefix from a request. Pass `upstream` instead of `requestUpstream`
only for a server half that emits a Lambda handler and cannot speak `Request`;
no Starkeep app does today.

The platform reserves two prefixes for build output:

- **`/_immutable/*`** holds content-addressed files, whose bytes never change
  at a given name. Responses say `max-age=31536000, immutable`. Set Vite's
  `build.assetsDir` to `_immutable` and pass the prefix as `immutablePaths`.
- **`/_static/*`** holds files with stable names, such as Flutter's
  `main.dart.js` or a font a stylesheet names. Responses say `max-age=0,
must-revalidate` with an `ETag`, so a browser revalidates each one and gets a
  304 when the file has not changed.

In the cloud, CloudFront serves both prefixes from the platform's app assets
bucket, and no request for them reaches your Lambda. The files therefore cost
no Lambda concurrency and have no size limit. At install, the platform copies
the files under `<bundleAssetsDir>/_immutable/` and `<bundleAssetsDir>/_static/`
that `staticAssetPaths` declares out of your `dist.zip` into the bucket. An
undeclared file stays out of the bucket, because the bucket serves anyone,
signed in or not. Locally, `serveStatic` answers the same paths with the same
headers. The manifest schema refuses a handler that declares
`staticAssetPaths` without a `bundleAssetsDir`.

Two settings name your build output, and they answer different questions:

- **`bundleAssetsDir`**, in the manifest, names the directory inside
  `dist.zip`, such as `"assets"`. The installer reads it before anything runs,
  to copy the S3-served files and to check file sizes.
- **`assetsDir`**, passed to `createWebAppHandler` or `serveStatic`, is where
  your running server reads files on disk, as a path or a `file:` URL. In the
  cloud it points at the same directory as `bundleAssetsDir`, unpacked beside
  your handler. Locally it points wherever your build writes, which is often a
  different directory.

Both prefixes are public. CloudFront serves them to anyone who has the URL,
signed in or not. Keep secrets out of build output: an API key, a token or a
private configuration value belongs in the server half's `env` or behind a
route that checks the session, never in a file under either prefix.

An update keeps the previous deployment's `/_immutable/` files in the bucket,
so a tab opened before the update still loads the hashed files its page names.
The update after that removes them. A `/_static/` file keeps its name across
deployments, so the update overwrites it in place, and an open tab gets the new
bytes on its next request. The installer uploads the files before it updates
the Lambda, so `/_static/` changes slightly before the shell does. Keep a
stable-named file compatible with the shell before it, or move it to
`/_immutable/` with a hash in its name.

`immutablePaths` is required and has no default. A default would decide your
cache headers for you, and a path cached forever by mistake stays wrong at the
edge until its TTL expires. Pass `[]` for a build that hashes nothing.

An app whose browser half is a bundler-built SPA also passes `shellPaths` — the
client routes the router owns — and the adapter answers each of them with
`index.html` from disk, ahead of your server half. Those paths are declared
rather than inferred for the same reason `staticPaths` is.

`staticPaths` comes from the manifest rather than from a hand-written predicate,
because **the static branch runs before your own gate**. Anything it answers is
answered anonymously, which makes the list an enforcement bypass by
construction. Declare it as `staticAssetPaths` on the handler:

```jsonc
"publicPaths": ["/", "/_immutable/*", "/manifest.webmanifest", "/sign-in", "/api/session/*"],
"staticAssetPaths": ["/_immutable/*", "/manifest.webmanifest"]
```

The manifest schema refuses a `staticAssetPaths` entry that `publicPaths` does
not already cover, so a path your bundle serves from disk can never be one the
manifest failed to declare — or, equivalently, one the gateway refuses while
your bundle stands ready to serve it.

#### Build tools that emit stable names

A build tool that cannot hash its output's names puts that output under
`/_static/`, and keeps the shell at the app's root. Two common setups:

- **Vite.** Hashed output goes to `_immutable/` through `build.assetsDir`.
  Files in Vite's `public/` directory keep their names, so put them in
  `public/_static/`, and Vite copies them to `<outDir>/_static/`.
- **Flutter.** Build with `flutter build web --base-href
"$STARKEEP_APP_BASE_PATH/"`, so the page resolves relative URLs against the
  app's root on either surface. Move everything in `build/web/` except
  `index.html` into `_static/`. In a custom `web/flutter_bootstrap.js`, pass
  `entrypointBaseUrl: "_static/"`, `assetBase: "_static/"` and
  `canvasKitBaseUrl: "_static/canvaskit/"` in the `config` object of
  `_flutter.loader.load()`, and point `index.html`'s script tag at
  `_static/flutter_bootstrap.js`.

Declare the prefix in both lists, and name the directory:

```jsonc
"publicPaths": ["/", "/_static/*", "/sign-in", "/api/session/*"],
"staticAssetPaths": ["/_static/*"],
"bundleAssetsDir": "assets"
```

#### Limits on what your Lambda can return

Every request that does not hit the CloudFront cache reaches your Lambda through
API Gateway, and these limits apply to each one:

- **Response size:** 6 MB per response. The adapter base64-encodes a binary
  body, so the largest binary response is about 4.5 MB. The installer refuses a
  bundle whose Lambda would serve a static file over 4 MB, and names the file.
  Move such a file under `/_static/` or `/_immutable/`.
- **Request size:** 6 MB per request body, with the same base64 cost for a
  binary upload.
- **Time:** API Gateway ends any request that runs longer than 30 seconds,
  whatever your handler's `timeoutSeconds` says.
- **Concurrency:** every running request counts against one Lambda concurrency
  pool per AWS account and region, which every app in the deployment shares. A
  new AWS account usually starts at 10 concurrent executions, although AWS's
  documented regional default is 1,000. Ask AWS to raise the limit through a
  Service Quotas request in the AWS console. AWS also raises the limit over time
  as the account's usage grows.

Keep large bytes off the Lambda path:

| Bytes                                              | Where they belong                | How the browser gets them                                                                 |
| -------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| Build output: code, WebAssembly, fonts, models     | `/_immutable/` or `/_static/`    | CloudFront serves each file from S3, with no Lambda and no size limit                     |
| A person's shared data                             | Shared records with files (§5)   | `POST /files/presign` to upload, a signed file URL to download                            |
| App-private bytes that the app or a person creates | `appSpecificSyncable.files` (§6) | `POST /app-data/files/presign` to upload, `GET /app-data/files/<subKey>` for a signed URL |
| A large result your server half computes           | `appSpecificSyncable.files` (§6) | Write the file, then answer with a signed URL instead of the bytes                        |

App-private storage holds data. Do not use it for files that ship with your
build: every node syncs every app-private file and keeps it, an uninstall that
keeps data keeps those files too, and each fetch needs a fresh signed URL.

What is still yours: which bundler and server library (the platform's answers
are Vite and Hono, and neither is enforced), the build command that produces
your output, native dependencies, any handler beyond the shell, and which of
your public paths are files on disk rather than routes your server answers.

### 8. Sign-in (cloud target only)

A person signs in to a cloud app on the platform's managed login page, never on
a form your app draws. Your app never receives a password: a password a cloud
app held would sign in to every other app too. The platform runs the sign-in
flow and sets the session cookies. Your app supplies four small pieces, and the
example app's `web/src/server/app.ts` shows all four.

1. **A sign-in page at `/sign-in`.** `createSignInPage({ appId, appName })`
   from `@starkeep/app-client/auth` builds the whole page, including the
   session restore described below. Mount it with
   `app.get("/sign-in", () => signInPage())`, as Probe does. To draw your own
   page instead, mount it at `/sign-in` and follow the rest of this item. The
   page needs one form or link to
   `SIGN_IN_START_PATH` (`/auth/start`) from `@starkeep/app-client/auth`, with
   your app id as `app` and the path to return to as `return`. After the
   managed login page, the platform's `/auth/callback` sets two cookies scoped
   to your app's path. `sk_session` holds the refresh token and lasts weeks.
   `sk_token` holds an ID token and lasts about an hour. The page must first
   try `POST /api/session/refresh`, and return to your app when the refresh
   answers `signedIn: true`. The platform sends a browser to `/sign-in`
   whenever `sk_token` has expired, so about an hour after the last page load
   every signed-in person lands there with a live `sk_session`. Without the
   refresh, each of them goes back through the managed login. Show the button
   at once, and guard against a loop: a second visit within a few seconds of
   a successful refresh should show the button instead of refreshing again.
   The example's `restoreSessionScript` and Photos' `src/SignInPage.tsx` both
   do this.
2. **The session routes under `/api/session`.** Mount the routes that
   `createSessionRoutes({ appId })` from `@starkeep/app-client/auth` returns.
   `GET /api/session` reports who is signed in. `POST /api/session/refresh`
   trades `sk_session` for a fresh `sk_token`. `POST /api/session/sign-out`
   clears both cookies and names the platform's sign-out page for the browser
   to visit next. `GET /api/session/token` hands the page a short-lived bearer
   token for a `jwt` route.
3. **`publicPaths` that cover both.** List `/sign-in` and `/api/session/*` in
   the handler's `publicPaths`, and `/starkeep-runtime-config` if your page
   reads it before sign-in. Otherwise the gateway refuses the requests that
   sign a person in. The example's `static` handler declares
   `"auth": "session"`, so the gateway's session authorizer checks `sk_token`
   on every other path.
4. **The origin gate.** `honoOriginGate({ publicPaths, signInPath: "/sign-in" })`
   from `@starkeep/app-client/hono` sends a navigation without `sk_session` to
   `/sign-in`, and answers any other such request with `401`. Read
   `publicPaths` from the manifest, as the example does, so that the gate and
   the gateway use one list.

None of this runs on the local surface. The origin gate is inert there,
`GET /api/session` reports no session, and the signing proxy exempts local
callers (§4).

**The sign-in page must live at `/sign-in`.** The platform's CloudFront
distribution runs a viewer-request function, `signed-out-redirect` in
`packages/admin-installer/src/builtin-programs/cloud-data-server-program.ts`,
in front of every app. The function sends a document navigation under
`/apps/<appId>/` that carries no `sk_token` to `/apps/<appId>/sign-in`, before
the request reaches your Lambda. The path is fixed, so a sign-in page anywhere
else is unreachable for a signed-out visitor. The function does not read your
`publicPaths`, so a signed-out navigation to a page your manifest declares
public lands on sign-in too. The function leaves four kinds of request alone:

- a request that is not a navigation, so a fetch from your page still gets
  the gateway's `401` rather than an HTML page;
- the data-plane prefixes `/data`, `/files`, `/sync`, `/app-data` and
  `/health`, which signed-in devices call with a bearer token and no cookie;
- `/starkeep-runtime-config`;
- `/p/*`, the public-share viewer every app reserves, because a visitor
  holding a link has no session.

The function is an optimization, not a gate: it keeps signed-out traffic off
your Lambda, and the gateway origin stays directly reachable (§10).

The platform checks the page twice. Install refuses a manifest with a
`session` handler when no handler lists `/sign-in` in `publicPaths`. After a
cloud install, the post-install probe requests `/sign-in` and warns when the
page answers with an error status, such as the 404 of a page the bundle never
mounted.

**A session can expire while the page is open.** `sk_token` lasts about an
hour, and the gateway then refuses the page's requests with `401`. Call
`POST /api/session/refresh` once and retry the request. If the refresh fails
too, send the browser to `/sign-in`. Photos does this in
`photos/src/lib/data-client.ts`. The example app offers a **Refresh session**
button instead, which keeps its page small.

**A client-side gate is optional, and it enforces nothing.** Photos wraps its
UI in an `AuthGate` component that probes `GET /api/session` and goes to
`/sign-in` when nobody is signed in. Such a gate is a usability
feature, not a security boundary: an attacker never runs your JavaScript. Ship
one for the user experience if you like, and do the enforcement in §4 and §10.

### 9. Cross-app labels

A label is an **assertion your app makes about a shared record** — including
records another app created. It's how you publish something other apps can act
on without them having to call you about every file: "I have OCR text for this
image", "this one needs review", "I counted 3 faces here".

**Writing a label needs only a `read` grant** on the record's type. An OCR
service shouldn't need destructive power over photos it only reads.

Declare your keys in the manifest (§2), then:

```ts
// Add. `value` is optional — omit it for a bare flag (stored as "").
await fetch("/api/local-data/data/labels", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    labels: [
      { recordId, key: "faces-detected" },
      { recordId, key: "face", value: "Alice" },
      { recordId, key: "face", value: "Bob" },   // same key, second row
    ],
  }),
});

// Make a key hold exactly these values: adds what's missing, retracts what's
// present and absent from the list, atomically. This — not the add above — is
// how you *update* a key. An empty `values` clears it.
await fetch("/api/local-data/data/labels/values", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    labels: [{ recordId, key: "face-count", values: ["4"] }],
  }),
});

// Retract (a tombstone, so it syncs). Omitting `value` retracts every value of
// that key on that record; `value: ""` retracts the bare flag alone.
await fetch("/api/local-data/data/labels/retract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ labels: [{ recordId, key: "face" }] }),
});

// Read them back with a record listing.
GET /data/records?include=metadata,labels
GET /data/records?include=labels&labelApps=alpha,gamma   // only these namespaces

// Find records another app labelled — the query labels exist for.
GET /data/records?label=alpha/faces-detected
GET /data/records?label=alpha/face&labelValue=Alice
GET /data/records?label=alpha/faces-detected&labelValue=   // bare flags only

// See what every installed app publishes.
GET /data/label-keys
```

Things worth knowing before you design around them:

- **A key holds a set, and a plain write adds to it.** `key: "face"` twice with
  different values is two rows, which is what makes `?labelValue=Alice` an
  indexed lookup instead of a substring scan over a packed `"Alice,Bob"`. The
  corollary is the one that bites: writing `face-count=4` over an existing
  `face-count=3` leaves _both_, and the key then reads back as two answers with
  nothing to say which is current. Use `/data/labels/values` whenever you mean
  "this is my current answer" — including for keys you think of as single-valued.
- **Your `app_id` is never something you send.** The server takes it from your
  authenticated identity. You cannot write into another app's namespace, and a
  body claiming otherwise changes nothing.
- **Everyone who can read the type sees every app's labels on it.** Labels are
  for talking to other apps. If it's your app talking to itself, it belongs in
  app-specific data (§6), not here.
- **Values are small and dumb by design** — 128 bytes, matched by equality
  only, at most 32 per key per record. An enum, an id pointing back at your own
  API, a count, a timestamp, a name. Never a sentence, and never a pointer into
  the shared data model. There is no null: a bare flag is the empty string, and
  the thing that carries meaning is the row existing at all.
- **Page until `nextCursor` is null.** A short page does _not_ mean the end of
  the results; only a null cursor does. Stopping early silently misses matches,
  and only under load — which is worse than an obvious bug.
- **Disagreement is fine.** `alpha/quality=high` and `gamma/quality=low` coexist
  as two rows. You decide whom to believe.

> **Positive filters are unsafe by default — and that's still the right choice.**
> Filtering _for_ a label (`?label=photos/original`) only works if the labelling
> app labels everything, and images written by a _different_ app won't carry it.
> The failure mode is silently hidden records. Filtering _against_ one is safe by
> default (unlabelled ⇒ included) but pays a scan proportional to how much you're
> excluding, forever. Prefer the positive filter and treat coverage as an
> obligation on the labelling app — but know which way it fails.

### 9a. Querying metadata and labels

The same grammar §6a describes over your own tables also answers two shared
tables. Every parameter means what it means there — `where`, `select`, `order`,
`limit`, `page_token` and `aggregate` — and the response is the same
`{rows, truncated, page_token}` or `{groups, truncated}`.

```
# One category's derived metadata, ordered by when the shutter fired.
GET /data/metadata/image
  ?where={"captured_at":{"gte":"2026-01-01T00:00:00.000Z"}}
  &order=captured_at.desc
  &limit=200

# How many photos per person, most-tagged first — one index scan.
GET /data/labels
  ?where={"app_id":"faces","key":"person"}
  &select=value
  &aggregate={"n":{"fn":"count"}}
  &order=n.desc
```

The category in the path picks the table, and the columns you may name are that
category's declared metadata columns. `image` and `video` carry `captured_at`
and are indexed on it; the other categories carry what
`CATEGORIES` declares for them.

Four rules govern both routes, and each of them is load-bearing:

1. **You see exactly the rows whose record type you were granted.** The server
   ANDs `record_type IN (…your readable types…)` into every query, so a
   category you hold three of nineteen types in answers about those three. The
   column is not yours to name — filtering it, ordering by it or projecting it
   is a 400 on the metadata route — because it carries the authorization
   decision rather than data.
2. **A category you hold no type in is a 403,** not an empty page. An empty
   page would say the library is empty where the truth is that it is not yours.
3. **A label query must pin `app_id` and `key` in `where`.** The reverse index
   is `(app_id, key, deleted_at, value, record_id)`, so a query that pins
   neither reads every app's assertions about every record. Pinning both leaves
   `value` as an ordered key column, which is why a range or an `in` list on
   `value` is a seek rather than a scan.
4. **A label query reads every app's labels, yours included.** Labels are
   cross-app assertions and `app_id` selects whose to read; what restricts the
   answer is the labelled record's type. Reading another app's namespace is the
   ordinary case rather than the exception.

`GET /data/records?label=…` keeps its shape and is still the way to fetch the
_records_ a label selects. This route returns label rows, which is the
different question: what values exist, how many carry each, and on which record
ids.

### 9b. Querying records

`GET /data/records` takes the same grammar, over the columns of the shared
records table. It answers a _rendered record_ rather than a row — a category, an
availability, a stand-in summary, a hydrated metadata row — so `select` is
the one parameter that does not apply to it, except as an aggregate's grouping
list.

```
# The library in capture order, originals only, ready to paint.
GET /data/records
  ?order=captured_at.desc
  &limit=100
  &include=metadata,labels
  &notLabel=photos/rendition

# One bounded batch of records by id.
GET /data/records
  ?where={"id":{"in":["rec-a","rec-b"]}}
  &limit=2

# The children of one record.
GET /data/records?where={"parent_id":"rec-a"}

# How many records you can read, without paging through them.
GET /data/records?aggregate={"total":{"fn":"count"}}
```

Five things about this route specifically:

1. **A page holds 100 records by default** (50 from the cloud data server),
   rather than the grammar's 30, and a `limit` above the grammar's ceiling is
   clamped rather than refused. Page until `nextCursor` is null either way.
2. **The continuation is `page_token`,** and the response still names it
   `nextCursor`. Hand back what you were given; its shape is the server's.
3. **`captured_at` is an ordering key and not a column.** It lives in the
   per-category metadata table, and this route reads it through a join it builds
   only to sort, so it can be named in `order` and nowhere else. To _filter_ on
   it, query `/data/metadata/image` and hydrate by id.
4. **`created_at` and `updated_at` are serialized HLCs.** You can order by them
   and read them back; you cannot filter on them, because a sync-internal clock
   is not a promise the platform makes. `updated_after=<iso>` is the supported
   question, and the server converts the instant into the bound. These columns
   say when Starkeep made and changed the record. The source file's own dates
   sit in `original_created_at` and `original_updated_at`, as ISO 8601 text
   that you can filter and order on. Only the folder watcher fills them, and
   either one is null when the source reported no date.
5. **The access paths are not grammar and stay named parameters.** `label` and
   `labelValue` select through the reverse index, which is a join; `notLabel`
   is an anti-join; `variant`, `labelApps` and `include`
   hydrate the page after it is cut. None of them is a predicate over the
   records table, and expressing them as one would be a worse API rather than a
   more uniform one.

Naming a type you were not granted is a 403 rather than an empty page, for the
reason rule 2 of §9a gives. Naming a parameter this route does not have is a
400: the parameter set it replaced — `type`, `ids`, `parentId` and `cursor` —
read named parameters as filters, so silently ignoring an unrecognized one would
answer the whole library to a caller that asked for one record's children.

### 9c. Finding out what was deleted

The platform announces nothing to your app. When a record is deleted — by your
app, by another app, or by the person in Drive — your app learns about it by
asking, and the question is one more parameter on the route you already use.

```
# Every record deleted since your app last reconciled.
GET /data/records
  ?deleted=only
  &updated_after=<the instant you last reconciled>
  &limit=100

# The library, and the tombstones, together.
GET /data/records?deleted=include

# How long a deleted item is kept, and therefore how often you must reconcile.
GET /data/trash
```

`deleted` takes three values. `exclude` is the default, so a request that never
names it answers live records exactly as it always did. `only` answers
tombstones, and `include` answers both — which is what you need in order to tell
"no such record" from "deliberately deleted". A misspelled value is a 400 rather
than a silent `exclude`, because a reconciliation that asked for tombstones and
received the live library would look like a library with nothing deleted.

A tombstone is an ordinary record whose `deleted_at` carries the moment of
deletion and whose `updated_at` carries the same clock reading, so
`updated_after` works over it like any other row and no second feed exists to
fall out of step with this one.

**The guarantee, and its limit.** Deleted records are reaped after the library's
retention window: the record row stays, and its files, its metadata row and its
labels are removed. So the feed is complete for an app that reconciles **at
least once per that window**, and an app that falls further behind must do a full
reconcile against the live set instead — list what the library holds, and treat
everything of yours that is not in it as gone.

The window is a setting rather than a constant. `GET /data/trash` answers
`retention_days` on both data servers, so a cloud-only app and a phone app read
it the same way a local one does. Your app should read it rather than compile in the default
of 30: a library whose owner chose a year is making a longer promise than your
app would assume, and one who chose a week is making a shorter one.
`retention_days: null` means that machine cannot read the library's settings file
yet and so does not know the value; nothing is reaped while that is true, so an
app can treat it as "no deadline right now" rather than as an error.

**Your own housekeeping is yours.** The platform deletes the shared record and
everything the platform owns about it. A row in your app's own table keyed by
`record_id` is yours to remove, in the same route that deletes the record if your
app is doing the deleting, and from this feed if another app or the person did.

## 10. Who authenticates the end user in your app

**You do.** This is the single most important thing to know before you deploy
an app to the cloud, and until 2026-08-23 it was written down only in a comment
inside the installer's source.

The platform authenticates _apps_, not people. Every request your server code
makes to the cloud data server carries an HMAC signature that says "this is
Photos"; the data server checks that signature, assumes your app's role, and
serves anything your manifest's grants allow. It does not know or ask which
person is on the other end of the browser. That was a deliberate decision — a
gateway-level end-user check is incoherent with per-app credentials, so it was
removed from the data plane in June 2026 — and it means **the only place an end
user can be checked is your app's own server code**.

Concretely, in a cloud install:

- The **API Gateway authorizer** is on your routes unless you opted out (§7).
  A `jwt` route needs a bearer token, so it suits XHR-only routes your client
  can attach one to (Photos' `POST /api/resize` uses it correctly). A
  `session` handler checks the platform's cookie, so it gates documents too,
  except the `publicPaths` you list.
- **CloudFront is not a boundary.** The gateway origin stays directly
  reachable, and `data-roles-and-permissions.md` says so explicitly. An edge
  check is an optimization that keeps anonymous traffic off your Lambda; it is
  never enforcement.
- **A client-side gate such as `AuthGate` is not a boundary** (§8). It runs
  in the browser.
- **Your signing proxy is the boundary** (§4). It is the one place every cloud
  request passes through and the only place that holds your HMAC credential.
  `endUserAuth` is where you say whether it checks.

The checklist before a cloud install:

1. Every handler's `auth` and `publicPaths` reflect what you actually intend to
   be anonymous, and the installer's anonymous-route report at install time
   matches what you expected.
2. Your proxy's `endUserAuth` is `sessionAuth()` or another
   `{ auth: "session", … }` form, or you can defend
   the `justification` string you wrote instead.
3. An unauthenticated `curl` against your data path returns `401` or `403`.
   Do this by hand once; the platform's tier-3 e2e asserts it too, and that
   assertion is the last line of defense for every app.

---

## Installing it

The install path is identical for first-party and third-party apps.

### Install locally

1. Add the app's folder, or a folder that holds it, in **Discover apps** on
   the Dashboard. A new install registers core's `example-app/` by default. A folder
   that holds `starkeep.manifest.json` is one app. In any other folder, each
   direct subfolder that holds a manifest is an app; the scan skips
   `node_modules` and dot-folders and goes no deeper. Discover apps shows what
   each folder contributed and why any folder was skipped.
2. Click **Install** on the app's card. Admin reads and validates the manifest
   and prompts you to approve the requested grants. The dialog names the
   command that installs the app's dependencies, which runs the app's own
   install scripts.
3. Install runs that command in the app's folder and shows its output. The
   command is the manifest's `installDependencies`, or the frozen install your
   lockfile implies: `pnpm install --frozen-lockfile`, `npm ci`,
   `yarn install --immutable` (`--frozen-lockfile` for a Yarn 1 lockfile) or
   `bun install --frozen-lockfile`. An app that a pnpm workspace lists
   installs at the workspace root. A pnpm install inside a workspace that does
   not list the app gains `--ignore-workspace`. An app inside an npm, Yarn or
   Bun project with no lockfile of its own installs nothing; the dialog names
   the project's install for you to run. A folder with no `package.json`
   installs nothing. Then Admin POSTs to
   `local-data-server` to register the app and provision its per-app HMAC
   credential. Install pins
   the app's folder and the manifest you approved: **Start** runs that folder
   with that manifest whatever the scan finds later. When the folder's manifest
   changes, the card offers **Update from folder**, which asks for approval
   again only when the app's file access changed.
4. For a cloud target, see "Install in your cloud" below.

Install runs only these command shapes, matched by the program's bare name on
`PATH` and never through a shell:

| Program | Install                                                             | Bundle         |
| ------- | ------------------------------------------------------------------- | -------------- |
| `pnpm`  | `install`, with `--frozen-lockfile`, `--ignore-workspace`, `--prod` | `run <script>` |
| `npm`   | `ci`, or `install` with `--omit=dev`                                | `run <script>` |
| `yarn`  | `install`, with `--immutable`, `--frozen-lockfile`                  | `run <script>` |
| `bun`   | `install`, with `--frozen-lockfile`, `--production`                 | `run <script>` |

A script name holds only letters, digits, `:`, `_` and `-`. When the manifest
names any other install command, Install does not run it: the dialog shows the
command and its folder, and you run it yourself before **Start**. **Start**
still refuses an app whose declared dependencies do not resolve, and names the
missing packages. Any other bundle command stops the cloud install before it
deploys anything.

### Install in your cloud

An app whose manifest lists `cloud` in `targets` installs in the cloud from
the same Dashboard. The cloud install does not need a local install first.

1. **Prepare the cloud.** Deploy Starkeep Cloud and sign in to admin-web as
   its admin, as the root [`README.md`](../README.md) describes in "Part B".
   The **Cloud** section lists one card per surface the manifest offers: a web
   card for an app with compute, and a mobile card for an app with a `mobile`
   block. Both cards come from the same Discover apps folder as the local card.
2. **Approve.** Click **Install <name> in cloud** on the web card, or
   **Register <name> Mobile** on the mobile card. The consent dialog from
   the local install opens first and lists the app's file access and public
   links, unless an earlier approval covers the install. Two records count as an
   earlier approval: an active local install, whose pinned manifest the cloud
   deploys, and the manifest the last cloud install recorded in the app
   registry. A redeploy or a second surface asks again only when the folder's
   manifest asks for file access or public links that the recorded manifest
   did not.
3. **Watch the install.** The installer installs the app's dependencies the
   same way a local install does, runs the manifest's `bundle` command with
   `STARKEEP_APP_BASE_PATH` and `STARKEEP_BUNDLE_OUT` set (§7), creates the
   app's signing credential and its tables, uploads the `/_immutable/` and
   `/_static/` files that `staticAssetPaths` declares to the app assets
   bucket, and deploys the handlers. The
   install takes a few minutes, and a failed install usually succeeds on
   **Retry**.
4. **Read the end of the log.** The installer lists the routes it created
   without an authorizer, then requests the live app without credentials:
   - `EXPOSED` marks a data path that answered. The install fails, and the
     log names the command that takes the app down.
   - `declared public but refused` marks a path in `publicPaths` that the
     gateway refused, most often a sign-in page nobody can reach.
   - `sign-in page does not answer` marks a `/sign-in` that returned an error
     status, usually because the bundle never mounted the page (§8).
   - `refused in this spelling only` marks a path that answers without its
     trailing slash only, which is expected for every path but the app root.
   - A cold-start line warns when the first request used half or more of the
     handler's timeout.
5. **Open the app.** When the card reads **Installed**, click
   **Open <name> ↗** and sign in on the managed login page with your Starkeep
   account.
6. **Sync.** Your cloud app shares one set of tables with each of your
   machines. A machine's rows reach the cloud once that machine is signed in to
   sync, which the root README describes in "Part B", step 5.
7. **Update.** **Redeploy <name>** in the web card's menu rebuilds and
   redeploys from the folder. When the folder's manifest has changed for an app
   installed locally, choose **Update from folder** on the local card first;
   the cloud card refuses until you do.

See [`starkeep-apps/README.md`](../../starkeep-apps/README.md) for the install steps
from the app-author's side, and the root [`README.md`](../README.md) for the
end-user local/cloud setup walkthrough.

## Testing your app

Test an app against a real platform at two tiers. The example app carries both
set up, in `example-app/e2e/` and `example-app/scripts/`.

**Tier 2, a local platform.** core's harness, `@starkeep/e2e`, boots
local-data-server, admin-web and Drive from a starkeep-core checkout. Your suite
installs the app through admin-web, starts it from the manifest's `localRun`,
and drives its page with Playwright. `startPlatformStack({ appParentDirs })`
takes the folder that holds your app, which admin-web scans as it would on an
operator's computer.

The harness is not published, because it boots the platform from source. Your
`package.json` therefore never names it. Copy the example's
`scripts/link-core-harness.mjs` into your app and run it before every e2e
command. The script finds core, checks that core's dependencies are installed,
and links the harness into `node_modules/@starkeep/`. It looks in three places:

1. `STARKEEP_CORE_DIR`, when set;
2. an enclosing starkeep-core checkout;
3. `starkeep-core` beside your repository's root.

When none holds a usable checkout, the script stops with one message naming the
path it tried. The example's `test:e2e` script is
`node scripts/link-core-harness.mjs && pnpm --filter @example-app/e2e test`.

**Tier 3, a real cloud.** core's second harness, `@starkeep/e2e-aws`, deploys a
throwaway cloud and runs the platform's journey against an app: install, the
shell, sign-in, the data plane, the browser upload and uninstall. The same link
script links it beside `@starkeep/e2e`. Your suite runs from your own
repository: it describes your app as a `JourneyApp` and passes it to
`defineCloudJourney`, then adds steps for what is true of your app alone.
Photos' `photos/e2e-aws/photos-journey.test.ts` in `starkeep-apps` is the worked
example, and its `vitest.config.ts` adds the core checkout from the script's
`coreDir()` to Vite's `server.fs.allow`. The journey deploys real AWS resources,
so read core's `e2e-aws/README.md` first.

## Structuring an app with several flavors

An app can have several flavors: a local web app, a cloud web app, a phone app,
and later a desktop app. The platform treats them as one app when they share one
app id and one manifest. It then syncs the app's data among them with no work
from the app:

- **App-specific rows and files** travel on the app's own channel, between
  every computer with the app installed, the cloud and the phone.
- **Shared records, metadata and labels** travel on Drive's channel, whichever
  flavor wrote them.

The flavors must still agree on the data itself: the table schemas, the row
encoding, the label keys, and how any metadata is computed. The manifest
declares the schemas once. Put the rest in one package every flavor imports.

The example app shows the layout:

```
example-app/
  starkeep.manifest.json   one manifest for every flavor
  package.json             the scripts the platform calls: start, bundle
  pnpm-workspace.yaml      one workspace holding every flavor
  common/                  the data contract; no DOM or Node imports
  web/                     local web and cloud web: one Hono app, two entries
  e2e/                     the tier-2 suite
  mobile/                  reserved for a React Native flavor
  desktop/                 reserved for a desktop flavor
```

Three details make the root manifest work. `localRun.cwd` is relative to the
manifest, so `"cwd": "web"` starts the server in the web folder. The installer
runs `pnpm run bundle` in the manifest's folder, the command the example's
lockfile implies, so the root `bundle` script delegates to `web`. And `workspace:*` between the flavors is legitimate, because
the dependency never leaves the app's folder. Keep `common/` free of DOM and Node
imports, so a phone bundler and both halves of a desktop app can all build it.
