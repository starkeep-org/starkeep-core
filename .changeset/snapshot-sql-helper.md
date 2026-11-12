---
"@starkeep/app-client": minor
---

Add `@starkeep/app-client/snapshot`. `createSnapshotSql({ appId, tables })` loads an app's own rows through the row API into an in-memory SQLite in the app's server, caches the copy per user, and runs any read-only SQL the app writes against it. Each query takes `maxAge`, the copy's time-to-live, and `freshAfter`, a floor a Refresh action sets to reload an older copy on whichever instance answers. Each result returns `loadedAt` for an "as of" label. The built output now keeps the `node:` prefix on builtin imports, because `node:sqlite` resolves only with the prefix.
