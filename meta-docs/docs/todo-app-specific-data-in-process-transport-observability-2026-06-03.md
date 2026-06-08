# Todo — in-process transport: observability when dropping rows for unknown apps

The in-process sync transport at `packages/sync-engine/src/transports/in-process-transport.ts:82-83` does `if (!ns) continue;` when an incoming app-syncable row's `appId` resolves to no local namespace. The rejection is correct (matches the design intent of "reject, not silently write"), but unlike the cloud responder (HTTP 403) and the sync-engine apply path (throws, logged as `[sync] appSyncableRow apply failed`), the in-process transport leaves no trace. An over-shipping peer driving the in-process transport is invisible.

Follow-up: add a log/warn (or surface via the engine's existing error-logging path) so this rejection is observable, matching the other two transports.

Source: doc id 7 (`functional-doc-app-specific-data-2026-06-03`), Part 2 — Behavior inconsistent with purpose. Deferred 2026-06-03; no fixed revisit date.
