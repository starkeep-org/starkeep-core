---
"@starkeep/protocol-primitives": minor
"@starkeep/admin-manifest": minor
"@starkeep/app-client": minor
---

Scheduled jobs. A manifest may declare `infraRequirements.jobs`, up to eight jobs of `{ name, handler, mode, defaultTime, description }`, which the platform runs in the cloud once per user who turns each one on. An app with jobs needs `protocolMinVersion` `1.1.0`, compute and the `cloud` target, and `PROTOCOL_VERSION` is now `1.1.0`. `@starkeep/app-client` adds `verifyJob` and `jobRefusal` for the job route at `/_starkeep/jobs/<name>`, and `listJobs`, `runJobNow` and `jobConsentUrl` for the app's server. `verifyDelegation` now refuses any token that is not on the `app` channel, so a job's token never opens a route meant for outside clients. `verifyDelegationToken` returns the token's `channel` and, for a job token, its `job`. `@starkeep/protocol-primitives` adds the `job` delegation channel, the `sk_job` and `sk_run` claims, and the job routes and constants.
