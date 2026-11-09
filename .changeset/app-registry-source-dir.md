---
"@starkeep/storage-sqlite": minor
---

`shared_app_registry` gains a nullable `source_dir` column, the folder an app was installed from. `initializeLocalSchema` adds the column to a registry created before it, so an existing local data server picks it up at its next start.
