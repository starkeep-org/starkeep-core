# @starkeep/app-client

## 0.12.0

### Minor Changes

- 1460d5c: `contentDisposition(name, { inline })` builds a `Content-Disposition` header that names a file, with an ASCII `filename` fallback and an RFC 8187 `filename*`. Import it from `@starkeep/app-client` or from the dependency-free `@starkeep/app-client/content-disposition` subpath.
- 380bb3f: Outside clients, such as MCP clients and scripts, can reach one app's data with a delegation token the user creates on the platform's consent page. A manifest route declares `"auth": "delegated"` for such a client, and `verifyDelegation(req)` in `@starkeep/app-client` tells the route whose request it is. Pass the returned token to `signedFetch` (`delegation`) or `proxyToDataServer` (`delegationToken`) so the platform applies the token's mode and revocation to each data call. On the local surface a loopback caller passes with no token.

  The manifest validator refuses `auth: "public"` on a handler or a route, and accepts a `publicPaths` entry only when it is a platform page or one of the handler's `staticAssetPaths`. A manifest that used either must move the route to `"delegated"` or drop it.

- b1dc276: Add `@starkeep/app-client/local`. `serveLocal({ app, static })` runs an app's local server: it reads the port admin-web passes on `--port`, binds 127.0.0.1, serves static files ahead of the app, and refuses a request with a non-loopback `Host` or from a page on another site before any route runs. An app that builds its own server mounts `localSurfaceGuard()` from `@starkeep/app-client/hono` first instead. Both replace the checks each app's local server used to write by hand.
- 82c483f: Add `@starkeep/app-client/snapshot`. `createSnapshotSql({ appId, tables })` loads an app's own rows through the row API into an in-memory SQLite in the app's server, caches the copy per user, and runs any read-only SQL the app writes against it. Each query takes `maxAge`, the copy's time-to-live, and `freshAfter`, a floor a Refresh action sets to reload an older copy on whichever instance answers. Each result returns `loadedAt` for an "as of" label. The built output now keeps the `node:` prefix on builtin imports, because `node:sqlite` resolves only with the prefix.

## 0.11.0

### Minor Changes

- 26ed6d3: In the cloud, CloudFront now serves each web app's `/_immutable/*` and `/_static/*` files from S3, so no request for them reaches the app's Lambda. The change is breaking for cloud deployments and for web apps.
  - A compute handler takes a new `bundleAssetsDir` field: the directory inside `dist.zip` that holds the build output. The installer copies the files under `<bundleAssetsDir>/_immutable/` and `<bundleAssetsDir>/_static/` that `staticAssetPaths` declares into the bootstrap stack's new app assets bucket.
  - `validateManifest` refuses a handler that declares `staticAssetPaths` without a `bundleAssetsDir`, so the installer can copy the S3-served files and check the size of every file the Lambda serves. Add the field and reinstall the app.
  - The installer refuses a bundle whose Lambda would serve a static file over 4 MB, which a Lambda response cannot carry, and names the file.
  - `@starkeep/app-client/web` exports `IMMUTABLE_CACHE_CONTROL` and `REVALIDATE_CACHE_CONTROL`, the headers both surfaces send for the two prefixes.

- fbb478b: `createSignInPage` in `@starkeep/app-client/auth` builds a default `/sign-in` page: one button that starts the platform's managed sign-in, and in the cloud a script that first restores a live session. The page is opt-in. An app mounts it at `/sign-in`, or keeps its own page there.
- 2b57447: The local surface and the cloud adapter now serve static files through one responder.
  - `serveStatic` in `@starkeep/app-client/hono` mounts the responder as Hono middleware, so an app's local server no longer needs a hand-written file server. It takes the static options `createWebAppHandler` takes and answers with the same content types, cache headers and client-route shell.
  - Every static response carries an `ETag`, and a matching `If-None-Match` gets a 304, so revalidating an un-hashed file no longer re-downloads it.
  - `.wasm` files are served as `application/wasm`, which `WebAssembly.instantiateStreaming()` requires.
  - `toResult()` base64-encodes any response that carries a `Content-Encoding`, so a pre-compressed `text/javascript` body is no longer corrupted.

## 0.10.2

### Patch Changes

- 45d64d3: `createDataProxyHandler` refuses a request whose `Sec-Fetch-Site` is `cross-site` or `same-site` with 403, before any session check or credential load. A `GET` or `HEAD` navigation from another site still passes, because following a link writes nothing. On the local surface a page on another site could otherwise send the proxy a blind `no-cors` POST and have it signed. A request without the header, from a server, a script or a phone, passes as before.

## 0.10.1

### Patch Changes

- d13e7ee: The session routes' cross-origin check also accepts the host the browser is on, as the distribution's `x-starkeep-viewer-host` header names it. Session refresh and sign-out now work on a custom domain as well as on the `cloudfront.net` name.

## 0.10.0

### Minor Changes

- 18b7a5f: Cloud app sign-in moves to Cognito's managed login page, so app code never sees a password. The platform's `/auth/start`, `/auth/callback` and `/auth/sign-out` routes set each app's `sk_session` and `sk_token` cookies at that app's path. The `@starkeep/app-client/session-cookies` subpath exports `signInAddress`, `signOutAddress` and the cookie names, with no dependencies.

  Breaking: `initiateAuth`, `respondNewPassword` and `InitiateResult` are gone from `@starkeep/app-client/auth`, and the session routes no longer accept a password. A cloud app's server mints its user token from the session cookie with `mintIdToken`, which now uses the cloud-apps client.

## 0.9.1

### Patch Changes

- Comment-only changes since 0.9.0.
