---
"@starkeep/app-client": patch
---

The session routes' cross-origin check also accepts the host the browser is on, as the distribution's `x-starkeep-viewer-host` header names it. Session refresh and sign-out now work on a custom domain as well as on the `cloudfront.net` name.
