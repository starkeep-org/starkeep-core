# What uninstall destroys, and where the warnings are missing

Date: 2026-08-22. Branch: `media-storage-and-video` (80 ahead of `origin/main`,
0 behind, and slated to merge). Raised while preparing to uninstall/reinstall
the `memo` app to pick up a schema change.

## The immediate question: does memo have cloud state?

No, and the reason matters more than the answer.

My first pass reasoned only from `sync_state`, where the sole watermarks belong
to `starkeep-drive`. That check alone would not have settled it, because Drive
is the identity that ships shared records to the cloud on behalf of every app,
so "no memo watermark" does not by itself mean "nothing of memo's is in the
cloud." The correct argument runs through the two data classes separately.

- Memo has no shared-data surface at all. Its manifest declares
  `fileAccess: null` and no `labelKeys`, so it holds no grants and can write no
  shared records. Drive's channel carries shared records, and memo produces
  none. Locally, `shared_records` confirms this: 7 rows from `local-watcher`
  and 116 from `photos`, and nothing from memo.
- Memo's data is entirely app-specific, living in `memo_syncable_*` tables and
  the app-private `apps/memo/syncable/` filespace. App-specific rows travel
  only on the app's own per-app channel, which exists only when the app is
  cloud-installed. There is no `memo:watermarks` key in `sync_state`, so that
  channel has never run.
- There is no memo cloud-install trace in `~/.starkeep` (only `cds-install` and
  `photos-install`), and the only mention of memo in `config.json` is
  `appParentDirs`, which is source-discovery for the installer rather than an
  install record.

The residual uncertainty is worth stating plainly. The authoritative check is
`shared.app_registry` in DSQL, reachable through admin-web's
`/api/apps/cloud/list`, and that endpoint requires an interactive Cognito login
with your STS credentials, so I could not run it. Everything above is local
evidence. It is consistent and points one direction, but if you want certainty
before any destructive step, that endpoint is the one to hit.

## The general finding: this is the design, not a code defect

The behavior is deliberate and documented.
`~/projects/starkeep/starkeep-core/data-roles-and-permissions.md:13` says
app-specific data is "per-app and app-owned — invisible to every other app, and
torn down when the app is uninstalled at a location," and the comparison table
at line 24 records "Survives uninstall: yes" for shared data against "no (at
that location)" for app-specific data. The code matches that description
exactly. So the thing to fix is not the data model, and certainly not on a
branch that is about to merge.

The phrase "at that location" is load-bearing and turns out to be honored well.
Local and cloud uninstall are genuinely separate operations.

- Admin-web's uninstall button is local only. `apps/admin-web/app/api/apps/uninstall/route.ts`
  stops the app's dev server, calls `DELETE /admin/apps/<appId>` on the
  local-data-server, and deletes the local HMAC credential file. It never
  reaches the cloud orchestrator.
- Cloud uninstall is a separate CLI, `packages/admin-installer/scripts/cli-uninstall-app.ts`,
  invoked as `pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId>`.

That separation is correct, and it means uninstalling one node cannot delete the
cloud copy. Your instinct that it should not was already satisfied.

## Where it actually goes wrong: the warnings

The defect is that both confirmation surfaces describe the half of the design
that preserves data and omit the half that destroys it.

### 1. The local confirmation is actively misleading

`apps/admin-web/src/components/LocalAppsSection.tsx:161` reads:

```
if (!confirm(`Uninstall ${entry.appId}? Records it produced will remain in shared storage.`)) return;
```

Every word of that is true and the overall impression is wrong. It volunteers
the reassuring guarantee and stays silent about the destruction, so an operator
reading it concludes their data is safe. For an app with no shared surface the
sentence is worse than uninformative, because the thing it promises to preserve
is the empty set while the thing it does not mention is everything the user has.

Uninstalling memo right now would drop 1 deck, 599 cards, 1128 card_state rows,
and 19 review_log rows, and delete 2324 objects totalling 15MB of synthesized
audio, under a dialog whose only substantive claim is that records will remain.

### 2. The cloud CLI has no destruction confirmation at all

`cli-uninstall-app.ts` prompts only for Cognito email and password, and those
prompts exist to authenticate, not to confirm. Passing `--non-interactive`
skips even those. The operation it then runs without asking anything is the
most destructive in the system:

- `packages/admin-installer/src/dsql-ddl.ts:474` runs
  `DROP SCHEMA IF EXISTS app_<appId> CASCADE`, destroying every app-specific
  table and row in the cloud.
- `orchestrator.ts:444` calls `deleteAppFilesObjects`, clearing the app's entire
  prefix in the files bucket.

This is the path that can destroy the last surviving copy, and it is the one
with the least ceremony. The relationship is inverted: the reversible, local,
single-location operation sits behind a button with a sentence, and the
irreversible cloud-wide one runs off a flag.

### 3. The docstrings repeat the same omission

Both `packages/admin-installer/src/local/installer.ts:116` ("Uninstall an app
locally: drops its access grants and registry row. Shared records produced by
the app stay behind") and the header of `cli-uninstall-app.ts` ("Shared records
the app created are deliberately left in place") describe uninstall by what it
spares. A reader of either would not learn that the app's own tables and files
are dropped. Meanwhile `dsql-ddl.ts:463-471` carries a careful nine-line comment
explaining why label rows must survive, and asserts that "permanently purging a
removed app's claims is an explicit admin action, not a side effect of
uninstall" — eleven lines above the `DROP SCHEMA ... CASCADE` that purges the
app's own data as exactly such a side effect.

The principle is stated well. It is just applied to only one of the two data
classes, and nothing in the code or the prompts tells the operator that.

## Proposed change, scoped to fit a merging branch

The recommendation is to fix the honesty of the surfaces and leave the data
model alone.

1. **Rewrite the local confirmation to state both halves.** It should name what
   is about to be destroyed in concrete terms (table count, row count, file
   count and bytes) and keep the shared-storage reassurance as a secondary
   clause rather than the headline. This needs a small preflight endpoint on the
   local-data-server that counts rows and objects for an app, since the numbers
   are what make the warning real.
2. **Require typed confirmation for a non-empty app.** If the preflight finds
   any app-specific rows or files, require the operator to type the app id
   rather than accepting a single OK. An app with nothing to lose should stay a
   one-click uninstall so the common case does not get noisier.
3. **Add an explicit destructive gate to the cloud CLI.** Interactively, require
   the typed app id after showing what will be dropped. Non-interactively,
   require a separate opt-in flag such as `--delete-cloud-data`, so that
   `--non-interactive` alone can no longer destroy a cloud schema.
4. **Correct the three docstrings** so they describe both what is destroyed and
   what survives.

Items 1, 2, and 4 are contained and low-risk. Item 3 touches the cloud uninstall
entry point but not the DDL itself, so it does not disturb the role or
permission model described in `data-roles-and-permissions.md`.

## What I need from you

- Confirm the scope above is what you want on `media-storage-and-video`, or trim
  it. My inclination is that all four are worth doing and that item 3 is the
  most valuable of them, since that is the irreversible path.
- Decide whether the design question is worth a separate issue: should uninstall
  destroy app-specific data by default at all, or should retention be the
  default with purging as a distinct action? The current answer is documented
  and defensible, and changing it is not a merging-branch decision, but the
  asymmetry with how carefully shared data is preserved is worth revisiting.
- Item 3 changes the contract of an existing flag combination, so if anything in
  CI or e2e calls `cli:uninstall-app --non-interactive`, it will need the new
  flag. I have not yet checked for those call sites.
