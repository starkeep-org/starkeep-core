---
"@starkeep/app-client": minor
---

Add `@starkeep/app-client/local`. `serveLocal({ app, static })` runs an app's local server: it reads the port admin-web passes on `--port`, binds 127.0.0.1, serves static files ahead of the app, and refuses a request with a non-loopback `Host` or from a page on another site before any route runs. An app that builds its own server mounts `localSurfaceGuard()` from `@starkeep/app-client/hono` first instead. Both replace the checks each app's local server used to write by hand.
