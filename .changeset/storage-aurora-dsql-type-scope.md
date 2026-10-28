---
"@starkeep/storage-aurora-dsql": minor
---

`RecordTypeScopePlugin` narrows every records and labels read on a Kysely instance to a set of record types, so a mobile app's exchange sees only the types its manifest grants. Scans, watermarks and digests all compile through it and agree. `typeScopedCompiler` exposes the same narrowing to the adapter's raw queries.
