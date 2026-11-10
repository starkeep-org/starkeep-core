---
"@starkeep/app-client": minor
---

The local surface and the cloud adapter now serve static files through one responder.

- `serveStatic` in `@starkeep/app-client/hono` mounts the responder as Hono middleware, so an app's local server no longer needs a hand-written file server. It takes the static options `createWebAppHandler` takes and answers with the same content types, cache headers and client-route shell.
- Every static response carries an `ETag`, and a matching `If-None-Match` gets a 304, so revalidating an un-hashed file no longer re-downloads it.
- `.wasm` files are served as `application/wasm`, which `WebAssembly.instantiateStreaming()` requires.
- `toResult()` base64-encodes any response that carries a `Content-Encoding`, so a pre-compressed `text/javascript` body is no longer corrupted.
