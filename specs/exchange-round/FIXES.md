# Proposed fixes

This note proposes fixes for the four findings in `README.md`, and for the absence of anything that heals them. Each fix has been checked against the model. Fixes A and B are implemented; the others are not yet. They are offered for discussion, because two of them change the DSQL write path.

## The findings, briefly

1. **Records before labels.** The responder applies every record in a shipment before any label. A label whose HLC is below one of those records is claimed by the cloud's coverage before it lands.
2. **One HLC split across statements.** The responder writes one row per transaction, and the first row of a batch sharing one HLC lifts coverage to that HLC. This happens today: a labels-only shipment is enough.
3. **Lost update.** The responder's LWW check (`get`) and its write (`put` or `putLabel`) are separate transactions, and the write is an unconditional upsert. A round that read the row before another round wrote a newer version then overwrites that version. The newer write has already raised coverage, so its author never re-ships it, and the replicas disagree from then on.
4. **The requester can claim a row it failed to apply.** The device carries on past a row that will not apply and advances that author's watermark to the HLC of the row before it. When that row shares the failed row's HLC, the watermark claims the failed row. No path in the code reaches this today, because the only row that can fail on a device is a record, and a record sorts first among the rows sharing its HLC.

Moreover, **nothing heals any of this automatically.** `verify()` compares digests that include labels, and on the right device it does repair findings 1 and 2. However, it runs only when someone presses the button in the admin UI (`sync-supervisor.ts` says "on request only", with no timer), and no app calls it.

In findings 1 and 2, `sync()` returns `complete: true` and logs nothing. Each finding has a TLA+ counterexample and a reproduction against the real engine and responder in `packages/sync-engine/__tests__/exchange-round-findings.test.ts`.

## Fix A: compare and write in one statement (finding 3)

**Status: implemented** (#196). `DatabaseAdapter.putSnapshot` and a guarded `putLabel` are used by both apply loops, on DSQL, SQLite and the mock; the model's finding configs now describe the code with this fix in place.

The sync apply path should write a snapshot only if it is newer than what the row holds, as part of the upsert itself:

```sql
INSERT INTO shared.records (...) VALUES (...)
ON CONFLICT (id) DO UPDATE SET ...
WHERE excluded.updated_at > shared.records.updated_at
```

`putLabel` needs the same guard on its own primary key. Serialized HLCs compare as strings in HLC order (fixed-width hex wall time, then counter, then node id, which is also how `compareHLC` breaks ties). The delta scans already rely on this.

Nothing else on DSQL changes. `put` and `putLabel` record the stamp of the version they write, and the raise is issued whatever the upsert did. However, `buildWatermarkRaise` takes its value from the rows that carry that stamp (`node_id = author AND updated_at IN stamps`), not from the stamp itself. After a skipped write the row holds the newer version, so no row carries the skipped stamp and the raise records nothing, which is already the rule for a write that loses LWW. Issuing the raise either way also keeps `guardNodeWatermarks` satisfied, since it judges a commit by the statements it issued.

We suggest new adapter methods (`putSnapshot`, `putLabelSnapshot`, or a flag) used by both apply loops, rather than changing `put`, so that local and API writes keep their current behaviour. The JavaScript `get` stays, because the metadata cascades and the stand-in admission need to know what the row held. Those decisions can still race with a concurrent round, and they should be reviewed separately; the guard removes only the overwrite.

The device side has the same shape. The requester's inbound loop also does `get` and then `put`, and on a device a local edit can land between the two. The same guard on SQLite covers it.

Model: `GuardedWrite = TRUE`. `finding-lww-race` fails without it, and every `fixed-*` and `deferred-*` model passes with it.

## Fix B: apply in merged per-author HLC order (finding 1)

**Status: implemented** (#202). Both sides group and sort through `sync-engine/src/inbound-order.ts`, and the responder's apply is one loop per author (`in-process-transport.ts`, step 1). The tests for finding 1 are ordinary ones, and `merged-crash` and `merged-concurrent` model the code as it now stands.

The responder should apply its inbound items as the requester already does. That is, group them by author with `groupInboundByNodeId`, sort each group by HLC across records, labels and app rows, and apply in that order. We suggest moving `groupInboundByNodeId` out of `sync-engine.ts` into a module both sides import, as was done with `round-cut.ts`. The halted-node rule becomes simpler, because a halt stops one author's run at one point: what lies below the failed row stays applied, and the rest re-ships.

This is what `docs/system-design.md` already describes. It fixes finding 1 for items with distinct HLCs. On its own it does not fix finding 2, which is why it comes with fix C.

Model: `MergedApply = TRUE`.

## Fix C: never let coverage, or a reader, see part of an HLC (finding 2)

There are two ways to achieve this. The model passes both.

**C1. One transaction per HLC** (`ApplyUnit = "timestamp"`). Every row sharing an author's HLC commits together, along with its coverage raise. This is the simplest fix, but it does not fit DSQL as things stand: `sdk.setLabels` takes one `clock.now()` for the whole call and then writes in chunks of 3,000 rows, so one HLC can cover more rows than a DSQL transaction may modify. C1 would therefore also need the SDK to take a fresh HLC per chunk, sized so that the chunk and its watermark rows stay within the cap. On SQLite, which has no such cap, C1 is straightforward.

**C2. Deferred coverage** (`ApplyUnit = "deferred"`, which we recommend for DSQL). Rows keep committing one at a time, with three changes:

1. A write on the sync apply path no longer raises coverage in its own transaction.
2. After the last row of each (author, HLC) run, one statement raises that author's coverage entry to that HLC. It does so whether or not the rows were newly written, because a re-shipped run that is already present must still complete it. Otherwise a crash between the rows and the raise would leave the run hidden forever.
3. The responder's scans treat its own coverage as one more `StreamTruncation`: no row above the cloud's coverage for its author is shipped. A run that is still being applied is therefore invisible to every other device, and a crash leaves coverage low, so the requester re-ships the run.

The third change is needed as well as the deferred raise: `mutant-nocap` drops it, and TLC finds the concurrent reader again.

Not every write on the apply path belongs to a shipped run. The responder also writes rows under the cloud's own clock: the refusal that `keepLiveOnTombstone` writes, and the tombstone of a losing stand-in (`tombstoneOf`). Those rows are authored by the cloud's node id, so no shipped run will ever raise that author's coverage, and under the third change they would stay above it and be hidden from every reader, including the requester that needs the verdict. These writes must therefore keep their inline raise. They take a fresh HLC each, so a single write is a whole run and the inline raise cannot expose part of one. The model leaves cloud-authored rows out (README, "What is not modelled"), so it would not catch a C2 that forgot this; the implementation needs a test for it. C2 needs no large transactions. It does change `guardNodeWatermarks`, which today refuses a commit that skipped a raise; the sync apply path would be exempt, with the raise as its own guarded statement.

Note that C2 relies on fix B. A deferred raise in records-then-labels order would still lift coverage over a label applied later.

## Fix D: run verify on a schedule (defence in depth)

`verify()` repairs findings 1 and 2 when it runs on the right device: the writer for a loss on the cloud, and the reader for a loss on a second device. Running it on a slow timer (daily, say) in the supervisor would bound how long any such loss lasts, whatever its cause. This does not replace A to C, because a loss on the cloud is visible only from the device that wrote the row, and that device may be wiped first. However, it is cheap, and it is the only backstop for causes the model does not cover.

## Fix E: advance a broken author only below the failed row's HLC (finding 4)

**Status: proposed.** The requester's `ownSafeAdvance` takes `items[stop - 1]`, the row tried just before the first one that failed. We suggest stepping `stop` back past every row that shares the failed row's HLC first, so that the watermark lands on the last HLC strictly below it:

```ts
const failed = inboundItemHlc(items[stop]!);
while (stop > 0 && compareHLC(inboundItemHlc(items[stop - 1]!), failed) === 0) stop -= 1;
```

The rows that applied at that HLC are re-shipped and absorbed by LWW, as every other re-ship is. This is the requester's side of the rule `cutRound` and `collectSince` already follow: one HLC is never split. Today it is a guard against a future change (a second record stamped with an existing HLC, or a label write that can fail) rather than a repair, which is why it is listed after the others.

Model: `BelowBroken = TRUE`. `finding-device-batch` fails without it, and `fixed-device-batch` and `fixed-device-wide` pass with it. The replay in `exchange-round-findings.test.ts`, which stamps two records with one HLC, passes with the change above.

## Suggested order

1. **Fix A.** It is small, independent of the others, and removes a permanent divergence.
2. **Fixes B and C2 together.** The four `it.fails` tests should then pass, and vitest will flag them so that `.fails` can be removed.
3. **Fix D.**
4. **Fix E**, whenever convenient; it is independent of the others.

For each step, the spec's constants should be set to match the code and `./check-all.sh` rerun, so that the model keeps describing what is deployed.
