---
"@starkeep/app-client": minor
---

An app can now link to the platform's consent pages for outside clients. In the cloud, `getRuntimeConfig()` and `createRuntimeConfigHandler()` add `connectUrl`, the page where a user creates a token for the app, and `connectionsUrl`, the page where a user lists and revokes outside clients. Both name the gateway's execute-api address, where the pages answer. `apiGatewayUrl` names the browser-facing CloudFront base, where the pages answer 404, so an app should not build these links from it. Locally both fields are undefined.
