# TODO: Drive UI does not subscribe to /events (no live updates)

The platform test plan (doc 43, §6) expects the Drive UI to "live-update on
`/events` kick when a record is added underneath it". The Drive page
(`apps/drive/app/page.tsx`) does not subscribe to `/events` at all — it
fetches `/api/types` and `/api/records` once on mount and never refreshes.
A record created by another app (or the watcher) while Drive is open is
invisible until a manual reload.

The server side is ready: the LDS `/events` SSE endpoint kicks on both local
writes and sync-applied remote changes (the latter hookup was fixed
2026-06-12 in `sync-supervisor.ts`), and the Tier-1 suite pins the contract
(empty payload, kick semantics). Only the Drive consumer is missing:
an `EventSource` on the LDS `/events` (would need a same-origin proxy route
like photos' `/api/local-data`, since the browser can't sign HMAC) — or
simpler, an SSE proxy route in Drive's own Next server — re-fetching
records/types on kick.

Surfaced while implementing the Tier-2 e2e suite (2026-06-12): the planned
"live-updates" smoke case had no behavior to assert against, so the
`e2e/tests/drive-smoke.spec.ts` suite covers only the render path and notes
this gap. Add the live-update spec when the subscription lands.

Revisit when: anyone touches the Drive UI, or when the missing e2e case
starts to matter (demo polish, watcher workflows).
