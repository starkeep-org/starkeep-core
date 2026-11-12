---
"@starkeep/admin-manifest": minor
---

Refuse a manifest with a `session` handler when no handler lists `/sign-in` in `publicPaths`. The platform sends every signed-out visitor to `/sign-in`, so such an app strands them on a page the gateway refuses. `SIGN_IN_PATH` is exported for the installer's post-install probe, which now also warns when the deployed page answers with an error status.
