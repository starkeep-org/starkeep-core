# Share the DSQL client between request adapter and app-syncable source

Each non-Drive `POST /apps/{appId}/sync/exchange` in `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts` builds a fresh `DatabaseClient` for `appSyncableSource` (`DsqlAppSyncableNamespaceStore` + `DsqlAppSyncableApplier`) on top of the same per-app credentials, in addition to the per-request adapter's own client. Both are closed in `finally`, but every exchange pays for two DSQL connect round-trips instead of one.

Functionally correct, just a latency tax on the most frequently called endpoint. Fix shape (likely): thread the existing per-request `DatabaseClient` into `buildAppSyncableSource` so the namespace store + applier share the connection that the adapter already opened.

Before committing to a fix, decide whether the two clients have meaningfully different lifetimes / transaction scopes — the responder may want them isolated for some sync-engine invariant we haven't surfaced. Worth a quick design read on `sync-engine`'s assumptions about the responder-side transport before refactoring.

From doc id 14 (`functional-doc-cloud-data-server-2026-06-05.md`), Part 2 — Behavioral bugs.

Revisit when: pre-production hardening of `/sync/exchange` latency, or sooner if profiling flags it.
