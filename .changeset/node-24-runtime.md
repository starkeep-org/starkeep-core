---
"@starkeep/admin-installer": minor
"@starkeep/admin-manifest": minor
---

Cloud Lambdas run on Node 24. The installer deploys the cloud data server and every app handler on `nodejs24.x`, and the next cloud update moves an existing deployment's functions in place. A manifest handler's `runtime` accepts only `"nodejs24.x"`, which stays the default, so a manifest that names `"nodejs22.x"` now fails validation. Starkeep requires Node 24 or later on the operator's machine.
