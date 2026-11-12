# @starkeep/app-client

The platform-provided client library every local Starkeep app uses to talk to the
local-data-server. Owns three things so apps don't have to reimplement them:

1. Loading the app's installed credentials.
2. HMAC-signing requests to the local-data-server.
3. Same-origin proxying for browser-driven apps so the HMAC secret stays
   server-side.

## 0.9.0

Renames the last three exported names that claimed a framework the platform no
longer uses. All four apps now build with Vite and serve with Hono, so nothing
in this package has a Next.js call site left to accommodate. Every change is a
compile error rather than a behavior change; no runtime behavior moved.

- **`createNextProxyHandler` is now `createDataProxyHandler`.** Same function,
  same signature, same `endUserAuth` contract. The old name described the mount
  point of a framework no app uses; the new one describes what the handler
  does, which is proxy to the data server.
- **`MinimalNextRequest` is now `MinimalRequest`.** The type never referenced
  Next — it is the narrow slice of the web `Request` interface this package
  reads, and it types the whole `@starkeep/app-client/auth` surface as well as
  the proxy.
- **`NextProxyOptions` and `NextProxyParams` are now `DataProxyOptions` and
  `DataProxyParams`.**
- No aliases. An app upgrading from 0.8.0 changes the import and the call, and
  the compiler names every site.

## 0.8.0

Retires the migration aids the four apps needed while they still built with
Next.js. Two breaking changes, both a compile error rather than a behavior
change, and neither reached by any app in this codebase.

- **`immutablePaths` is required on `createWebAppHandler`.** The old default
  named `/_immutable/*` and `/_next/static/*` together so a half-migrated tree
  cached correctly on every app at once. No app emits the second prefix now, and
  a default that decides an app's cache headers is the wrong shape regardless: a
  path cached forever by mistake stays wrong at the edge until its TTL expires.
  Pass `["/_immutable/*"]`, or `[]` for a build that hashes nothing.
- **`createAuthGateMiddleware` is gone.** `createOriginGate` is the same
  function under the name it should always have had. The alias existed for Next
  `middleware.ts` call sites, and there are none.
- **`/_immutable/*` is the only forever-cached prefix.** The platform's
  CloudFront distribution no longer carries an ordered cache behavior for
  `/apps/*/_next/static/*`. A cloud install therefore needs its app redeployed
  onto a `/_immutable/*` build before the distribution is redeployed, or that
  app's assets stop being cached at the edge.

## 0.7.1

One fix, found by driving a real app's packaged Lambda: **`honoOriginGate`
defaults `basePath` to `appBasePath()`.**

`createOriginGate` uses `basePath` for two jobs — stripping the mount off the
pathname it matches, and prefixing the sign-in path in the `Location` it
redirects to. Under `honoUpstream` the first job is already done, which made the
option look unnecessary; the second is not. A gate mounted without it sent a
signed-out browser to `/sign-in` at the distribution root, outside the app.
Passing `basePath` explicitly still overrides the default.

Reaching this needs a document navigation to an undeclared path that carries no
`sk_session` — CloudFront's `signed-out-redirect` function answers most of those
before the gateway is consulted, which is why it survived a tier-3 run.

## 0.7.0

Carries the platform work that precedes the four apps leaving Next.js behind.
Nothing here is a breaking change; the old names are aliases.

- **`@starkeep/app-client/hono`** — `honoUpstream`, `honoOriginGate` and
  `appBasePath`. See "The server half: Hono" below. The mount prefix stops being
  each app's problem.
- **`createOriginGate`** replaces `createAuthGateMiddleware`, which stays as an
  alias. Same function; the name no longer claims a framework.
- **`createWebAppHandler` gains `shellPaths`** — a declared client route is
  answered with `index.html` from the assets directory, so a bundler-built SPA's
  shell is a file on disk rather than a response the app renders.
- **`/_immutable/*` is the platform's prefix** for content-addressed build
  output. `DEFAULT_IMMUTABLE_PATHS` carries it alongside `/_next/static/*` for
  the length of the migration; pass `immutablePaths` explicitly rather than
  relying on either.
- **`STARKEEP_APP_BASE_PATH` is now set on an installed app's Lambda**, which is
  what `appBasePath()` reads. An app needs a cloud reinstall to pick it up.

## Install

```sh
pnpm add @starkeep/app-client
```

Published to npm. Apps inside `starkeep-core` take it as `workspace:*`;
`starkeep-apps` and `memo` pin a released version.

## The HMAC contract

The local-data-server authenticates every per-app request by HMAC-SHA256 over
the request body, keyed on the app's `hmacSecret`. The wire contract that every
local app must implement byte-for-byte (a `timingSafeEqual` mismatch returns 401) is:

| Header               | Value                                               |
| -------------------- | --------------------------------------------------- |
| `X-Starkeep-App-Id`  | Your `appId`.                                       |
| `X-Starkeep-App-Sig` | `hex(hmac_sha256(hmacSecret, "<appId>:" ++ body))`. |

The signature input is the bytes `appId`, then a literal `:` byte, then the raw
request body bytes. For `GET` and `HEAD` requests, the body is the empty string
(zero bytes appended after the colon). For `POST` / `PATCH` / `PUT` / `DELETE`
the body is the exact bytes that hit the wire — text bodies are signed as UTF-8
encoded bytes, binary bodies are signed as their raw bytes. Don't introduce a
string detour for binary content; signing through a Latin-1 round-trip happens
to work for ASCII but disagrees with the server on non-ASCII bytes.

Loopback-gated routes (`/health`, `/config`, `/auth/*`, `/admin/*`, `/watches/*`,
`/events`) and file-URL routes (token-in-URL) don't use this scheme. Per-app
data routes (`/data/*`, `/app-data/*`, `/files/presign`) all do.

## Credentials file

Credentials live at `$STARKEEP_DIR/app-creds/<appId>.json` (default
`~/.starkeep/app-creds/`), written at mode `0o600` by admin-web at install
time. Shape:

```json
{ "appId": "my-app", "hmacSecret": "<hex>", "dataServerUrl": "http://127.0.0.1:9820" }
```

`loadAppCredentials(appId)` reads and caches this; the file is rewritten only
on uninstall+reinstall (which restarts your app process), so the in-process
cache is safe.

## API

```ts
import {
  loadAppCredentials,
  signRequest,
  signedFetch,
  createDataProxyHandler,
  createRuntimeConfigHandler,
} from "@starkeep/app-client";
```

- **`loadAppCredentials(appId): AppCredentials | null`** — server-side only.
  Returns `null` if the app isn't installed locally.
- **`signRequest({ appId, hmacSecret, body? }): { headers }`** — pure; produces
  the two HMAC headers. Body may be `string | Buffer | Uint8Array | undefined`.
- **`signedFetch(creds, path, init?): Promise<Response>`** — `fetch` wrapper
  that adds the headers and resolves `path` against `creds.dataServerUrl`.
- **`createDataProxyHandler({ appId, endUserAuth })`** — returns a handler of
  `(Request, { params }) => Promise<Response>`. Mount it on one catch-all route
  for every verb (`app.all("/api/local-data/*", …)`) to give the browser a
  same-origin URL with HMAC added server-side.

  `endUserAuth` is **required**, and is either
  `{ auth: "session", verifySession }` or
  `{ auth: "anonymous", justification }`. It is required because this handler
  holds the app's HMAC credential and will sign whatever reaches it: on the
  cloud surface nothing upstream checks who the caller is (the data plane
  authenticates the _app_, and a browser navigation cannot carry a bearer
  token), so if the app does not check, nobody does. In local mode the session
  check is skipped by default — on-device data belongs to the person at the
  keyboard, and a sign-in gate there would break local-first — which
  `allowAnonymousLocal: false` overrides.
  The documented way to answer it for a cloud app is **`sessionAuth()`**, which
  wires in this package's own cookie-session verifier. The explicit
  `verifySession` form stays for an unusual verifier; every app in this
  codebase wants what `sessionAuth()` returns.

- **`createRuntimeConfigHandler()`** — returns a `() => Response` that serves
  the cloud-config env vars (`STARKEEP_API_GATEWAY_URL`,
  `STARKEEP_USER_POOL_ID`, etc.) as JSON. Mount it on any GET route. It reads
  the environment on every call, so a Node server needs no build-time opt-out.

## Analysis reads in SQL: `@starkeep/app-client/snapshot`

The row grammar answers what a screen lists. An analysis view, such as weekly
volume per lift, needs expression aggregates, date buckets and joins, which the
grammar does not offer. The snapshot helper loads the app's own rows through
the row API into an in-memory SQLite in the app's server, and runs any
read-only statement the app writes against the copy.

The data server never runs app SQL. Cloud users share each app table, the two
engines speak different SQL, and raw SQL would see tombstones and system
columns. The row API removes all three, so the copy holds only the caller's
live rows, and every surface runs the same SQLite dialect.

```ts
import { createSnapshotSql, SnapshotAccessError } from "@starkeep/app-client/snapshot";

const snapshots = createSnapshotSql({
  appId: APP_ID,
  tables: manifest.infraRequirements.appSpecificSyncable.tables,
});

app.get("/api/weekly-volume", async (c) => {
  const result = await snapshots.query(c.req.raw, {
    tables: ["sets"],
    sql: `SELECT strftime('%Y-%W', done_at) AS week, sum(reps * weight) AS volume
          FROM sets GROUP BY week ORDER BY week`,
    maxAge: 5 * 60_000,
    freshAfter: Number(c.req.query("freshAfter") ?? 0),
  });
  const res = Response.json({ rows: result.rows, loadedAt: result.loadedAt });
  if (result.setCookie) res.headers.append("Set-Cookie", result.setCookie);
  return res;
});
```

- **`maxAge`** sets how long, in milliseconds, a snapshot answers before the
  helper reloads it. Zero reloads on every query.
- **`freshAfter`** sets a floor in epoch milliseconds. The helper reloads any
  snapshot loaded before the floor. A Refresh action in the browser sets the
  floor to `Date.now()` and sends it with every later request. In the cloud each
  warm Lambda holds its own snapshot, and the floor reaches whichever one
  answers.
- **`loadedAt`** on each result is the time the snapshot's load started. Show
  it beside the Refresh action as "as of 14:32". Changes another device has not
  synced yet are not in the copy.
- **`setCookie`** appears when the user's ID token was re-minted. Append it to
  the response.

The helper applies the signing proxy's rules. A request from another site
fails with `SnapshotAccessError` status 403. In the cloud, a request without a
session fails with status 401. A missing app credential fails with status 503.
A failed page of the load raises `SnapshotLoadError` with the data server's
status.

Limits and guarantees:

- Each snapshot belongs to one user and one set of tables. In the cloud the key
  is the ID token's `sub`, so one user's rows never answer another user's query.
- The cache keeps 16 snapshots by default (`maxEntries`) and evicts the least
  recently used. A snapshot over 200,000 rows (`maxRows`) raises
  `SnapshotTooLargeError`. Aggregate on the data server with the row grammar
  for tables that large.
- A statement must begin with `SELECT`, `WITH` or `VALUES`. A statement that
  changes the copy raises `SnapshotReadOnlyError`, and the helper drops the
  copy. On Node 24.10 and later, a SQLite authorizer also refuses every action
  but a read.
- Write the SQL in the app's server code. Never run SQL text that arrived from
  the browser: the copy holds only the caller's rows, but an arbitrary
  statement has no cost bound.
- No transaction spans the pages and tables of one load. A write during a load
  can leave a child row without its parent until the next load.

`createSnapshotCache` is the cache underneath, for a server that loads rows
some other way. Each query then passes a `scope` and a `load` function.

## The server half: Hono

A Starkeep app's server half is a [Hono](https://hono.dev) app, and
`@starkeep/app-client/hono` holds the joint between Hono and the platform.

```ts
import { honoUpstream, honoOriginGate, appBasePath } from "@starkeep/app-client/hono";
```

- **`honoUpstream(app)`** — adapts a Hono app to `createWebAppHandler`'s
  `requestUpstream`.
- **`honoOriginGate(opts)`** — `createOriginGate` as Hono middleware, for
  `app.use("*", ...)`.
- **`appBasePath()`** — the app's mount prefix, read from
  `STARKEEP_APP_BASE_PATH`.

**The mount prefix never reaches app code.** The platform mounts an installed
app at `/apps/<appId>`, and the Lambda sees that prefix on every path. A router
matches on the request's own pathname, so something has to reconcile the two.
`honoUpstream` rewrites the request's URL to the app-relative path before
calling `app.fetch`, which means an app route is written `/api/records` and
matches unchanged on the local surface and in the cloud. The alternative —
every app calling `app.basePath(process.env.STARKEEP_APP_BASE_PATH)` — puts a
copy of the platform's own mount choice in each app repository, so it is not
the convention here.

An app that genuinely needs the origin-facing URL, to build an absolute
redirect or print a link, calls `appBasePath()`. That is the single place the
mount is stated, and nothing derives it from a request.

Neither the platform nor this module imports Hono: the two shapes it touches —
an app with a `fetch`, and a middleware `(c, next)` — are structural, so the
integration adds nothing to an app's Lambda bundle.

## Cross-target apps

Apps with `targets: ["local", "cloud"]` in their manifest use this package on
**both** sides: the same proxy mount serves both surfaces, and the package
decides server-side whether to forward to the loopback local-data-server or,
under `STARKEEP_APP_CLIENT_MODE=cloud`, to the shared API Gateway with the
HMAC secret fetched from SSM. The browser calls one same-origin path either
way; keep that behind a single data-source resolver in your client (see
Photos's `data-client.ts`).

Because the mount is shared, the cloud surface inherits whatever the local one
does — which is exactly how a proxy written for loopback ended up answering the
internet. `endUserAuth` is the field that forces the two surfaces to be
considered separately.

## The session layer

A cloud app gets sign-in, sign-out, refresh and an origin gate from the
platform rather than writing them. A person signs in on Cognito's managed login
page, never in app code: the app's sign-in page links to the platform's
`/auth/start` (`signInAddress(appId)`), the managed login page takes the
password, and the platform's `/auth/callback` sets the app's cookies. App code
is untrusted, and a password it held would sign in to every other app and, for
an admin, to the deployment itself. The app owns the sign-in _page_ — its
route, markup, copy and styling — and the platform owns everything the page
talks to, because cookie names, flags, path scoping, the Cognito flow and token
verification are properties of the deployment rather than of any app. The
operational rule is that this package ships no React and names no app; a
component appearing in it means the boundary has been crossed.

Three entry points:

- **`@starkeep/app-client/edge`** — `createOriginGate({ publicPaths,
signInPath, basePath })`, one function of `Request -> Response | undefined`.
  It is deny-by-default: a path the manifest has not declared public is
  refused, so a route added later is gated until someone says otherwise. Pass
  `publicPaths` from the manifest itself, never as a second hand-maintained
  copy. Dependency-free, so it mounts anywhere: `honoOriginGate` wraps it as
  Hono middleware. The gate is a cloud gate — its first line returns
  `undefined` unless `STARKEEP_APP_CLIENT_MODE` is `cloud`.
- **`@starkeep/app-client/auth`** — `createSessionRoutes({ appId })`, mounted
  at `app/api/session/[[...action]]/route.ts`. It serves `refresh`, `sign-out`
  (which answers with the platform's `/auth/sign-out` address for the page to
  visit next), a `GET` probe, and `GET token` for the one case a cookie cannot
  serve (a call made directly against the gateway, where a bearer token is
  required). Also exports `verifyIdToken`, `requireSession`, `signInAddress`,
  `signOutAddress` and the cookie helpers.
- **`@starkeep/app-client/session-cookies`** — the cookie helpers alone, with
  no imports, so the broker can set an app's cookies at `/auth/callback`.
- **`sessionAuth()`** from the root entry, for the proxy's `endUserAuth`.

Two cookies, both `HttpOnly; Secure; SameSite=Lax; Path=/apps/<appId>`:
`sk_session` holds the Cognito refresh token and `sk_token` holds a minted ID
token, re-minted from `sk_session` as it nears expiry. The browser holds no
Cognito credential at any point, so an XSS on the page has nothing durable to
take.

This package does **not** depend on `@aws-sdk/client-cognito-identity-provider`
and must not grow that dependency. The refresh (`InitiateAuth` with
`REFRESH_TOKEN_AUTH`) is an unauthenticated operation that needs no SigV4, so it
is a plain `fetch` —
which is also what keeps the verifier loadable in an edge runtime, where the
origin gate can be deployed.
