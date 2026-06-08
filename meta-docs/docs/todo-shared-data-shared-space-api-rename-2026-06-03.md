# Todo — revisit `shared-space-api` package naming

The package `shared-space-api` is named for the shared-data lens but also hosts the app-private syncable runtime (`app-syncable/factory.ts`, the `_starkeep_sync_records` reserved table, the `appSpecific` operations on `ApiContext`). A reader looking only at the package name wouldn't predict that. Worth renaming or splitting, but a costly touch — deferred for now.

**Revisit when:** the next change that touches this package's public surface anyway (a new endpoint, a router refactor, or a split of the app-syncable runtime into its own package).

**Source:** functional-doc-shared-data (doc id 5), Part 2 — Questionable purposes, 2026-06-03.
