# @starkeep/app-client

The platform-provided client library every local Starkeep app uses to talk to the
local-data-server. Owns three things so apps don't have to reimplement them:

1. Loading the app's installed credentials.
2. HMAC-signing requests to the local-data-server.
3. Same-origin proxying for browser-driven apps so the HMAC secret stays
   server-side.

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

Credentials live at `$STARKEEP_DATA_DIR/app-creds/<appId>.json` (default
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
- **`createNextProxyHandler({ appId })`** — returns a Next.js route handler.
  Mount at `app/api/local-data/[...path]/route.ts` and re-export it for every
  verb to give the browser a same-origin URL with HMAC added server-side.
- **`createRuntimeConfigHandler()`** — returns a Next.js GET handler that
  serves the cloud-config env vars (`STARKEEP_API_GATEWAY_URL`,
  `STARKEEP_USER_POOL_ID`, etc.) as JSON. Mount at any route and add
  `export const dynamic = "force-dynamic"` so env is read at request time.

## Cross-target apps

Apps with `targets: ["local", "cloud"]` in their manifest use this package
only on the local side. The cloud side has a different auth model (Cognito
+ API Gateway) and a different request path shape. Keep the choice behind a
single data-source resolver in your client (see Photos's `data-client.ts`).
