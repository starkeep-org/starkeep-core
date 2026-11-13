---
"@starkeep/protocol-primitives": minor
"@starkeep/storage-adapter": minor
"@starkeep/storage-sqlite": minor
"@starkeep/storage-aurora-dsql": minor
---

A record keeps its source file's own dates. `DataRecord` gains `originalCreatedAt` and `originalUpdatedAt`, ISO 8601 strings or null, and `createDataRecord` takes both as optional input. Both stores add the `original_created_at` and `original_updated_at` columns, and an existing SQLite database or DSQL cluster gains them when the data server starts. The records grammar can filter and order on both columns. Only the local folder watcher fills them, from the file's birth time and modification time.
