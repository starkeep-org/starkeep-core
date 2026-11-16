---
"@starkeep/app-client": minor
"@starkeep/protocol-primitives": minor
---

MCP clients such as claude.ai, ChatGPT and Claude Code can now connect to an app's delegated route with OAuth instead of a pasted token. Pass the request to `delegationRefusal(req)` in `@starkeep/app-client`. In the cloud, the 401 then names the route's protected resource metadata, which tells the client where to sign in, and says `error="invalid_token"` when the request carried a bearer token, which tells the client to refresh. `delegationRefusal()` with no request still answers a bare challenge.

`@starkeep/protocol-primitives` adds the OAuth route paths, the `skr_` refresh token prefix, the scope names and the access token lifetime.
