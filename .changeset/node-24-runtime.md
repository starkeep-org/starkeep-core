---
"@starkeep/admin-manifest": minor
---

A manifest handler's `runtime` accepts only `"nodejs24.x"`, which stays the default, because Starkeep's cloud Lambdas run on Node 24. A manifest that names `"nodejs22.x"` now fails validation.
