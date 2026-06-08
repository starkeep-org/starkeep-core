# TODO: app-level concurrency guard for cloud-app install/uninstall

Two `cli-install-app <same-id>` invocations can run side by side against the same DSQL cluster and Pulumi state bucket. The admin-web SSE endpoint serializes via `runningChild`, so the UI path is single-flight, but a terminal invocation alongside a UI invocation (or two terminal invocations) is not guarded. DSQL DDL probes are not transactional across statements; Pulumi's state lock covers the compute stack but not the temp-policy attach/detach dance; the registry has no row to lock against.

A natural fix is a PG advisory lock keyed on app id taken at the orchestrator entry, or an explicit lock row in `shared.app_install_steps`.

From doc id 18 (`functional-doc-cloud-apps-2026-06-05.md`), Part 2 — Behavioral bugs.

Revisit when: a second admin/CI surface starts driving installs, or a real conflict is observed.
