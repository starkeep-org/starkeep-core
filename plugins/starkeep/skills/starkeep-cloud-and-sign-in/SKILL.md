---
name: starkeep-cloud-and-sign-in
description: Use when a Starkeep app targets the cloud — its compute handlers and bundle, the /sign-in page and session routes, publicPaths, who checks the end user, and an MCP route — or when a cloud install answers 401.
when_to_use: Adding the cloud target or `compute` handlers; writing the `bundle` script or web adapter; building `/sign-in` and `/api/session/*`; choosing `publicPaths` or `auth`; local vs cloud sessions; a 401, `{"message":"Unauthorized"}` or `Missing X-Starkeep-User-Token`; choosing `endUserAuth`; exposing an MCP server from the app.
---

# Starkeep cloud target and sign-in

A router into the authoring docs for the cloud half of an app, plus the gotchas
that cost earlier installs a round trip. The docs are the source of truth: open
the linked section before you change anything. Where a fact is stated only in
source, the file is linked and named.

## Router

| You are doing                                  | Read                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declaring handlers, `routes`, `auth`, the zip  | [7. Cloud compute + the bundle](../../ref/docs/authoring-an-app.md#7-cloud-compute--the-bundle-cloud-target-only)                                                                                                       |
| Serving a browser from the Lambda              | [The web adapter](../../ref/docs/authoring-an-app.md#the-web-adapter-if-your-app-serves-a-browser)                                                                                                                      |
| Large responses, uploads, slow requests        | [Limits on what your Lambda can return](../../ref/docs/authoring-an-app.md#limits-on-what-your-lambda-can-return)                                                                                                       |
| Overriding the bundle command                  | the `bundle` field in [2. Write `starkeep.manifest.json`](../../ref/docs/authoring-an-app.md#2-write-starkeepmanifestjson)                                                                                              |
| The sign-in page and session routes            | [8. Sign-in](../../ref/docs/authoring-an-app.md#8-sign-in-cloud-target-only)                                                                                                                                            |
| Deciding who checks the end user               | [10. Who authenticates the end user](../../ref/docs/authoring-an-app.md#10-who-authenticates-the-end-user-in-your-app), [4. Proxy + sign](../../ref/docs/authoring-an-app.md#4-proxy--sign-requests-to-the-data-server) |
| The request path end to end                    | [How a request flows](../../ref/docs/system-design.md#how-a-request-flows)                                                                                                                                              |
| What the session cookies are and who sets them | [A cloud app's session](../../ref/docs/data-roles-and-permissions.md#a-cloud-apps-session)                                                                                                                              |
| An MCP server in the app                       | [11. Exposing an MCP server](../../ref/docs/authoring-an-app.md#11-exposing-an-mcp-server-from-your-app)                                                                                                                |

## The bundle contract

Source: [7. Cloud compute + the bundle](../../ref/docs/authoring-an-app.md#7-cloud-compute--the-bundle-cloud-target-only).

- Declare `infraRequirements.compute.handlers`. Each handler has `routes`,
  `auth`, and for a `session` handler `publicPaths`; `staticAssetPaths` must sit
  inside `publicPaths` (a schema rule in
  [`schema.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/schema.ts)).
  Copy the example's `static` handler shown in §7
  rather than starting blank.
- The installer runs `<manager> run bundle` in the app folder with
  `STARKEEP_APP_BASE_PATH=/apps/<appId>` and `STARKEEP_BUNDLE_OUT=<abs path>`,
  and consumes the `dist.zip` written there (§7).
- Another script or a subfolder goes in the manifest's `bundle` field; the
  installer refuses anything but `<manager> run <script>`
  ([§2](../../ref/docs/authoring-an-app.md#2-write-starkeepmanifestjson), §7).
- Load the module graph during Lambda INIT: `createLambdaEntry`'s `upstream`
  takes a promise, not a thunk (§7). The installer's probe
  fails an install whose first request uses more than four fifths of
  `timeoutSeconds`.
- A browser-facing app uses `createWebAppHandler`; it strips the
  `/apps/<appId>` mount and serves `staticAssetPaths`
  ([The web adapter](../../ref/docs/authoring-an-app.md#the-web-adapter-if-your-app-serves-a-browser)).
- 6 MB per response (about 4.5 MB binary), 30 s per request, one shared
  concurrency pool; a static file over 4 MB is refused at install
  ([Limits](../../ref/docs/authoring-an-app.md#limits-on-what-your-lambda-can-return)).

## Sign-in: the four pieces

Source: [8. Sign-in](../../ref/docs/authoring-an-app.md#8-sign-in-cloud-target-only).
The example app's `web/src/server/app.ts` wires all four.

1. **A page at `/sign-in`**, usually `createSignInPage({ appId, appName })`
   from `@starkeep/app-client/auth`. It must try `POST /api/session/refresh`
   first (§8).
2. **The session routes**, from `createSessionRoutes({ appId })`, mounted
   under `/api/session`.
3. **`publicPaths` that list `/sign-in` and `/api/session/*`**, plus
   `/starkeep-runtime-config` if the page reads it before sign-in.
4. **The origin gate**, `honoOriginGate({ publicPaths, signInPath: "/sign-in" })`
   from `@starkeep/app-client/hono`, reading `publicPaths` from the manifest so
   gate and gateway share one list.

**The path is fixed at `/sign-in`.** CloudFront's `signed-out-redirect`
function sends every signed-out document navigation under `/apps/<appId>/` to
`/apps/<appId>/sign-in`, whatever your `publicPaths` say (§8; defined in
[`cloud-data-server-program.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-installer/src/builtin-programs/cloud-data-server-program.ts)).
A sign-in page mounted anywhere else is unreachable for a signed-out visitor.

## Who checks the end user

Source: [10. Who authenticates the end user](../../ref/docs/authoring-an-app.md#10-who-authenticates-the-end-user-in-your-app)
and [4. Proxy + sign](../../ref/docs/authoring-an-app.md#4-proxy--sign-requests-to-the-data-server).

- **Your app does.** The platform authenticates apps, not people; your signing
  proxy is the boundary. CloudFront and a client-side `AuthGate` are not (§10).
- **`endUserAuth` is required** on `createDataProxyHandler`. Use
  `sessionAuth()`; it returns `401` before the HMAC credential is loaded (§4).
- The proxy forwards the person's ID token with the app's signature; the cloud
  data server verifies both and assumes the app's data role for that user
  ([How a request flows](../../ref/docs/system-design.md#how-a-request-flows)).
- `sk_session` (refresh token) and `sk_token` (ID token) are `HttpOnly`
  cookies at `/apps/<appId>`, set by the platform's `/auth/callback`
  ([A cloud app's session](../../ref/docs/data-roles-and-permissions.md#a-cloud-apps-session)).

## Local has no session

Source: §8, "None of this runs on the local surface", and §4.

- Locally the origin gate is inert, `GET /api/session` reports no session, and
  the proxy exempts local callers from `sessionAuth()`.
- The exemption is `allowAnonymousLocal`, default `true`; the check runs only
  when `isCloudMode()` or the flag is `false`
  ([`data-proxy.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/app-client/src/data-proxy.ts)).
- So a sign-in flow that "works locally" has not been exercised. Locally,
  protect the server with the loopback `Host` and `Sec-Fetch-Site` checks (§4).
  Sign-in is tested only on a cloud install.

## `X-Starkeep-User-Token`

- The cloud data server refuses every data call without it:
  `401 Missing X-Starkeep-User-Token`, with no route or manifest opt-out
  (`/health` aside;
  [`api-handler.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts),
  around line 3197; also stated in §11 "Identity").
- The proxy mints it from the `sk_session` cookie in cloud mode (`mintIdToken`,
  [`data-proxy.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/app-client/src/data-proxy.ts)).
  No cookie, no token.
- Consequence: a cloud caller with no session cookie (a script, a cron, an MCP
  client, or a proxy configured `{ auth: "anonymous" }`) is signed by your app
  but still gets this `401` from the data server. Obtain an ID token another
  way, as §11 describes, rather than loosening `endUserAuth`.

## Gotchas

**`publicPaths` widens a route to `ANY`.** Under `auth: "session"`, each
entry becomes its own anonymous `ANY <path>` route and replaces any declared
route on that path. Listing `/api/thing` when you declared `POST /api/thing`
makes every method on it anonymous (`resolveHandlerRoutes` and
`anonymousRoutes` in
[`routes.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-manifest/src/routes.ts)).
Make public only paths safe for anyone to call with any method, and answer
other methods with `405` in the handler.

**No `/sign-in` in `publicPaths` shows `{"message":"Unauthorized"}`.** The
first cloud install of an app without it (AI-626) answered the raw body
`{"message":"Unauthorized"}`, not an app page. CloudFront redirects the
signed-out visitor to `/sign-in` (§8), and with that path not public the API
Gateway authorizer refuses it before your Lambda runs. No doc states this body
text; it is API Gateway's default authorizer refusal. The authorizers are
defined in
[`cloud-data-server-program.ts`](https://github.com/myleshenderson/starkeep-core/blob/main/packages/admin-installer/src/builtin-programs/cloud-data-server-program.ts):
the `cognito-jwt` authorizer (`jwtConfiguration`, around line 676) for `jwt`
routes, and the `session-cookie` authorizer just below it for `session`
handlers. If you see this body, check `publicPaths` for `/sign-in` and
`/api/session/*` first. The validator does not require `/sign-in`
specifically; any non-empty list passes it.

**A `401` from a page that was working an hour ago** is an expired `sk_token`.
Call `POST /api/session/refresh` once and retry; on failure go to `/sign-in`
(§8, "A session can expire while the page is open").

**A non-navigation request is never redirected.** A `fetch` from the page to a
gated path gets the gateway's `401`, not the sign-in HTML (§8). Handle the
`401` in your data client.

## MCP from your app

An MCP client sends no cookie and cannot sign in, so it reaches neither the
session gate nor the proxy's token minting. Serve `POST /mcp`, list `/mcp` in
`publicPaths` (it becomes `ANY /mcp`, so answer other methods with `405`),
verify an app-issued bearer on every call before loading credentials, and sign
the call yourself with an ID token from the person's stored refresh token.
Use stateless Streamable HTTP. The bearer lasts at most 30 days. Read
[11. Exposing an MCP server from your app](../../ref/docs/authoring-an-app.md#11-exposing-an-mcp-server-from-your-app)
in full before writing any of it; it also has the local and cloud
`claude mcp add` / connector recipes.

## Recipes

**Add the cloud target to a local app.**

1. Add `"cloud"` to `targets` and a `compute` block modelled on the example's
   `static` handler (§7).
2. Write the `bundle` script against the env contract (§7); wrap the entry in
   `createWebAppHandler` or `createLambdaEntry`.
3. Mount the sign-in page, session routes and origin gate (§8).
4. Set `endUserAuth: sessionAuth()` on the proxy (§4).
5. Run the checklist below, then install to the cloud.

**Before a cloud install.** Work through the three-item checklist in
[10. Who authenticates the end user](../../ref/docs/authoring-an-app.md#10-who-authenticates-the-end-user-in-your-app)
and report each item: `auth` and `publicPaths` match intent and the
installer's anonymous-route report; `endUserAuth`; an unauthenticated `curl`
of your data path returns `401` or `403`. In addition:

- `publicPaths` contains `/sign-in` and `/api/session/*` (gotcha above).
- `validateManifest()` passes in a unit test
  ([§2](../../ref/docs/authoring-an-app.md#2-write-starkeepmanifestjson)).
- After install, a signed-out browser visit to `/apps/<appId>/` lands on your
  sign-in page, not on `{"message":"Unauthorized"}`.

## Related skills

- `starkeep-app-anatomy`: manifest shape and the full `publicPaths` rules.
- `starkeep-data-model`: which data calls to make once signed in.
- `starkeep-run-local`: run and test against the local platform first.
