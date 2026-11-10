---
"@starkeep/app-client": minor
---

`createSignInPage` in `@starkeep/app-client/auth` builds a default `/sign-in` page: one button that starts the platform's managed sign-in, and in the cloud a script that first restores a live session. The page is opt-in. An app mounts it at `/sign-in`, or keeps its own page there.
