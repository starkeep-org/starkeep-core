# The post-reinstall refill pulls nothing from the cloud

**Date:** 2026-09-19
**Found by:** the sixth Tier-3 run, the first to reach step 27, while completing work item 5 of
`~/projects/starkeep/plan-e2e-app-blob-plane-2026-09-18.md`.
**Stack:** `sktest`, account 026090522855, region us-east-2, left up for inspection.
**Resolved by:** `findings-step27-stale-broker-session-2026-09-19.md`, which
names the cause and records the fix. Neither hypothesis in section 4 below is correct: the broker
answered 500 to every exchange because one warm Lambda container held an AWS session assumed from the
app IAM role that step 24 deleted. The observations below stand; the guesses at the end do not.

**Scope:** this is in the sync pull path. It is unrelated to the app-private blob plane (step 21,
passing) and unrelated to the DSQL mapping work (steps 24 and 25, passing).

## 1. The problems found

1. **A node that reinstalls an app after dropping its copy never refills from the cloud.** Step 27
   polls `POST /sync/now` every two seconds for 120 seconds and the app's local table stays empty.
2. **The rows are in the cloud and readable.** Step 26, immediately before, reads the same row through
   the broker and passes.
3. **Nothing arrives, not merely the node's own writes.** The cloud table holds rows written by cloud
   node ids as well as by this node, and neither kind lands locally, so a "don't pull back your own
   writes" rule does not explain it on its own.
4. **`POST /sync/now` answers 200 throughout.** The pull reports success while moving nothing, so the
   only signal is the absent rows.

## 2. What was observed

Step 27 of `starkeep-core/e2e-aws/README.md` installs the app on the node again and expects the rows
step 26 removed to come back:

```
AssertionError: expected '{"rows":[],"truncated":false,"page_to…' to contain 'node-copy-1789845516483'
 ❯ timeoutMs src/journey.ts:1748:39   { timeoutMs: 120_000, intervalMs: 2_000 }
```

The cloud holds both the row this run wrote and the one an earlier run wrote, and both carry this
node's own id:

```
record_id: 'node-copy-1789845516483'   note: 'tier-3 note'   node_id: 'test-53212-1789830745442'
record_id: 'node-copy-1789843919768'   note: 'tier-3 note'   node_id: 'test-53212-1789830745442'
```

`test-53212-1789830745442` is the `nodeId` in `e2e-aws/.run/sktest/config.json`, so the node is being
asked to pull back rows it authored. The same cloud table also holds rows authored by Lambda-side node
ids (`cloud-2026/09/19/[$LATEST]…`), and those do not arrive either.

Local state after the failed step, from `e2e-aws/.run/sktest/data.db`:

- `probe_syncable_probe_notes` — empty.
- `app_syncable_namespaces` — the `probe` row is present and correctly shaped, `created_at`
  19:24:27, which is the local reinstall.
- `sync_state` — holds `starkeep-drive:watermarks` and `starkeep-drive:peer_watermarks` and **no
  `probe:*` key at all**.

The absent watermark is what makes the result strange. With no watermark the pull has no lower bound,
so it should return the whole table rather than nothing.

## 3. What this rules out

- **Not the cloud's contents.** The rows are there, and step 26 reads one of them through the broker.
- **Not the DSQL mapping.** Connecting as `sktest_app_probe` with the app's own identity succeeds, and
  steps 24 and 25 exercise the uninstall-and-reinstall mapping path and pass.
- **Not a stale watermark.** There is no `probe` watermark to be stale.
- **Not the namespace registration.** The `probe` row in `app_syncable_namespaces` is present and
  carries both tables with their full column shapes.
- **Not solely own-node exclusion.** Cloud-authored rows in the same table also fail to arrive, so a
  filter on `node_id` cannot be the whole story even if one exists.

## 4. What to look at next

The pull runs and reports 200 while moving nothing, so the question is whether the supervisor
considers `probe` a pull target at all at that moment. Two things are worth reading first: whether the
app's HMAC secret is the one the broker holds at the time of the pull, since step 26's node-copy
removal re-mints the local secret and the journey re-runs `cli-install-app` to re-mirror it, and
whether the supervisor's pull targets are computed once at boot rather than re-read after an app is
installed into a running daemon.

A cheap experiment discriminates a state-accumulation cause from a logic cause: run the journey with a
fresh `runStateDir` so the node id, the registry database and the cloud's accumulated rows do not
carry over. This stack's run-state directory has been reused across many runs and its node id encodes
a process that exited long ago.

## 5. Status of the run this blocked

The run reaches 26 of 28 steps. Everything the blob-plane plan set out to prove passes, including step
21. Everything the DSQL mapping fix set out to deliver passes, including step 24 and step 25. The two
remaining failures are step 26, a concurrency-correlated `28000` on the broker's DSQL connect that
passed on the next run and is recorded in section 7 of
`~/projects/starkeep/decision-reinstall-keep-data-rebind-vs-keep-role-2026-09-19.md`, and step 27,
this finding.
