# @starkeep/app-client

The platform-provided client library every local Starkeep app uses to talk to the
local-data-server. Owns three things so apps don't have to reimplement them:

1. Loading the app's installed credentials.
2. HMAC-signing requests to the local-data-server.
3. Same-origin proxying for browser-driven apps so the HMAC secret stays
   server-side.

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

This package is workspace-internal today; it's not yet published to npm.

## The HMAC contract

The local-data-server authenticates every per-app request by HMAC-SHA256 over
the request body, keyed on the app's `hmacSecret`. The wire contract that every
local app must implement byte-for-byte (a `timingSafeEqual` mismatch returns
401) is:

| Header | Value |
|---|---|
| `X-Starkeep-App-Id` | Your `appId`. |
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
  createNextProxyHandler,
  createRuntimeConfigHandler,
} from "@starkeep/app-client";
```

- **`loadAppCredentials(appId): AppCredentials | null`** — server-side only.
  Returns `null` if the app isn't installed locally.
- **`signRequest({ appId, hmacSecret, body? }): { headers }`** — pure; produces
  the two HMAC headers. Body may be `string | Buffer | Uint8Array | undefined`.
- **`signedFetch(creds, path, init?): Promise<Response>`** — `fetch` wrapper
  that adds the headers and resolves `path` against `creds.dataServerUrl`.
- **`createNextProxyHandler({ appId, endUserAuth })`** — returns a Next.js
  route handler. Mount at `app/api/local-data/[...path]/route.ts` and re-export
  it for every verb to give the browser a same-origin URL with HMAC added
  server-side.

  `endUserAuth` is **required**, and is either
  `{ auth: "session", verifySession }` or
  `{ auth: "anonymous", justification }`. It is required because this handler
  holds the app's HMAC credential and will sign whatever reaches it: on the
  cloud surface nothing upstream checks who the caller is (the data plane
  authenticates the *app*, and a browser navigation cannot carry a bearer
  token), so if the app does not check, nobody does. In local mode the session
  check is skipped by default — on-device data belongs to the person at the
  keyboard, and a sign-in gate there would break local-first — which
  `allowAnonymousLocal: false` overrides.
  The documented way to answer it for a cloud app is **`sessionAuth()`**, which
  wires in this package's own cookie-session verifier. The explicit
  `verifySession` form stays for an unusual verifier; every app in this
  codebase wants what `sessionAuth()` returns.
- **`createRuntimeConfigHandler()`** — returns a Next.js GET handler that
  serves the cloud-config env vars (`STARKEEP_API_GATEWAY_URL`,
  `STARKEEP_USER_POOL_ID`, etc.) as JSON. Mount at any route and add
  `export const dynamic = "force-dynamic"` so env is read at request time.

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

A cloud app gets sign-in, sign-out, refresh and an origin gate from this
package rather than writing them. The division is deliberate: the app owns the
sign-in *page* — its route, markup, copy and styling — and the platform owns
everything the page talks to, because cookie names, flags, path scoping, the
Cognito flow and token verification are properties of the deployment rather
than of any app. The operational rule is that this package ships no React and
names no app; a component appearing in it means the boundary has been crossed.

Three entry points:

- **`@starkeep/app-client/edge`** — `createOriginGate({ publicPaths,
  signInPath, basePath })`, one function of `Request -> Response | undefined`.
  It is deny-by-default: a path the manifest has not declared public is
  refused, so a route added later is gated until someone says otherwise. Pass
  `publicPaths` from the manifest itself, never as a second hand-maintained
  copy. Dependency-free, so it mounts anywhere: `honoOriginGate` wraps it as
  Hono middleware, and `createAuthGateMiddleware` is the old name kept for Next
  `middleware.ts` call sites. The gate is a cloud gate — its first line returns
  `undefined` unless `STARKEEP_APP_CLIENT_MODE` is `cloud`.
- **`@starkeep/app-client/auth`** — `createSessionRoutes({ appId })`, mounted
  at `app/api/session/[[...action]]/route.ts`. It serves `sign-in`,
  `new-password`, `refresh`, `sign-out`, a `GET` probe, and `GET token` for the
  one case a cookie cannot serve (a call made directly against the gateway,
  where a bearer token is required). Also exports `verifyIdToken`,
  `requireSession` and the cookie helpers.
- **`sessionAuth()`** from the root entry, for the proxy's `endUserAuth`.

Two cookies, both `HttpOnly; Secure; SameSite=Lax; Path=/apps/<appId>`:
`sk_session` holds the Cognito refresh token and `sk_token` holds a minted ID
token, re-minted from `sk_session` as it nears expiry. The browser holds no
Cognito credential at any point, so an XSS on the page has nothing durable to
take.

This package does **not** depend on `@aws-sdk/client-cognito-identity-provider`
and must not grow that dependency. `InitiateAuth` and `RespondToAuthChallenge`
are unauthenticated operations that need no SigV4, so they are a plain `fetch` —
which is also what keeps the verifier loadable in the edge runtime that
OpenNext runs middleware in.
