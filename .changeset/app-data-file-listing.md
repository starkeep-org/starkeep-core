---
"@starkeep/shared-space-api": minor
---

Add `listFiles` to the app-specific view, and `appFileListingJson` for its wire shape. Both data servers answer `GET /app-data/files` with it, so an app can list its own files by sub-key prefix, with paging.
