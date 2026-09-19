# Does a local uninstall propagate app-specific deletion to other nodes?

Date: 2026-08-24. Prompted by the copy in the new uninstall dialog on
`uninstall-data-destruction-warnings`.

## The claim under test

`apps/admin-web/src/components/LocalAppsSection.tsx`, `DialogDescription`:

> This permanently deletes the data {appName} keeps for itself, and the deletion
> syncs to every other node, so there is no copy left to restore from.

The second half is false. So is the conclusion drawn from it.

## What actually happens

Four independent mechanisms each block propagation, and they compound.

**1. `DROP TABLE` writes no tombstone.** `uninstallLocal` calls
`dropAppSyncableTables` (`packages/admin-installer/src/local/installer.ts:165`),
which issues `DROP TABLE IF EXISTS` per table
(`packages/admin-installer/src/local/registry.ts:432-441`). App-syncable tables
are soft-deleted in normal operation — a retracted row stays behind with
`deleted_at` set so the tombstone can ship to peers, which is precisely what the
new preview code filters on and what its "stops counting rows the app already
retracted" test exercises. A `DROP` bypasses that mechanism entirely. The rows do
not become deletions; they stop existing locally, silently.

**2. The namespace is deregistered, so the tables stop being a sync scope.**
`delete_syncable_namespace` runs in the same uninstall
(`installer.ts:185-187`). The outbound side enumerates
`appSyncableSource.namespaces.list()` to build digest buckets
(`packages/sync-engine/src/sync-engine.ts:269`) and to scan for backlog
(`sync-engine.ts:352`). After uninstall that enumeration is empty. There is no
scope under which a deletion could be advertised even if one existed.

**3. The channel itself is torn down.** The supervisor builds one engine per
installed app from `listInstalledApps()`
(`apps/local-data-server/server.ts:782-786`), and `delete_app_registry_row`
removes that row. `rescan()` then calls `stopEngineFor`, which sets
`entry.stopped`, clears the timers, and deletes the engine
(`apps/local-data-server/sync-supervisor.ts:406-420`) — with a comment noting
this exists specifically to stop a draining `sync()` from "issuing requests
against a channel that no longer exists and writing `sync_state` for an app that
has been uninstalled." There is no transport left to carry anything.

**4. Local and cloud uninstall are separate operations by design.** The
admin-web button stops the daemon, calls `DELETE /admin/apps/:appId` on the
local-data-server, and deletes the local HMAC credential. It never reaches the
cloud orchestrator; cloud teardown is the separate
`packages/admin-installer/scripts/cli-uninstall-app.ts`.

## The correct statement is close to the opposite

A local uninstall destroys the app's data **at this location only**. Peers and
the cloud keep their copies untouched. That is exactly what
`data-roles-and-permissions.md:24` records — "Survives uninstall: no (at that
location)" — and the "at that location" is load-bearing. The original design note
(`uninstall-data-destruction-2026-08-22.md`) had this right and said so:
"uninstalling one node cannot delete the cloud copy. Your instinct that it should
not was already satisfied." The dialog copy contradicts the note it was written
from.

This matters beyond pedantry, because the sentence is the emotional core of the
warning. It tells the operator the loss is total and irreversible when in fact,
for a cloud-installed app, the authoritative copy is very likely still in DSQL
and S3. An operator who reads that sentence and cancels a perfectly safe
uninstall has been misled just as surely as one who proceeds under the old
"records will remain in shared storage."

## The thing that is actually irreversible, and is not mentioned

Uninstall never clears the app's `sync_state`. Per-app watermarks are written
through `createPerAppSyncStateStore(localDb, underlyingSyncStateStore, appId)`
(`sync-supervisor.ts:376-380`), and `uninstallLocal` touches only grants, label
keys, syncable tables, the namespace, the registry row, and the step ledger — it
never goes near `sync_state`.

So after uninstall the watermark rows survive with the values they had when the
tables were full. On reinstall the tables are recreated empty while the node
still advertises coverage it no longer has. The peer concludes this node already
holds those rows and does not re-ship them. The surviving cloud copy exists but
does not flow back.

The one mechanism that could catch this is `verify()`, which compares per-scope
bucket digests and expresses an inbound repair by advertising less than it holds.
It is deliberately not scheduled. `sync-supervisor.ts:681-697` says so
explicitly: "There is deliberately no timer behind this... 'on request only'
means a loss sits undetected until a person presses the button."

I have traced the watermark lifecycle and the repair path but have **not** run a
live uninstall/reinstall against a cloud-installed app to confirm the backfill
fails in practice. That test is the one thing that would settle it, and it is
worth running before this ships, because it decides which sentence the dialog
should carry.

## What the dialog should say instead

Subject to the reinstall test above, the honest version is roughly:

> This permanently deletes the data {appName} keeps on this machine. Other nodes
> and the cloud keep their own copies, but reinstalling does not automatically
> pull them back.

That is both accurate and still a real warning — arguably a better one, because
"you will have to do something deliberate to get this back" is actionable in a
way that "there is no copy left" is not.

## Consequence for the branch

This moves `uninstall-data-destruction-warnings` from "ship after deciding the
loopback disclosure question" to "do not ship as written." The branch exists to
fix a confirmation dialog that stated something true in a way that left a false
impression. The replacement states something false outright. That is a
regression in the specific dimension the branch is about, even though everything
underneath it — the preview endpoint, the counts, the samples — is sound and
worth keeping.

See `uninstall-branch-ship-assessment-2026-08-24.md` for the rest of the review,
including the loopback content-disclosure finding.
