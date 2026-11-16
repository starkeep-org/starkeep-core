# Proposed fixes

This note proposes fixes for the four findings in `README.md`. Each fix has been checked against the model; none has been implemented. They are offered for discussion, because two of them change the DSQL write path.

## The findings, briefly

1. **Records before labels.** The responder applies every record in a shipment before any label. A label whose HLC is below one of those records is claimed by the cloud's coverage before it lands.
2. **One HLC split across statements.** The responder writes one row per transaction, and the first row of a batch sharing one HLC lifts coverage to that HLC. This happens today: a labels-only shipment is enough.
3. **Lost update.** The responder's LWW check (`get`) and its write (`put` or `putLabel`) are separate transactions, and the write is an unconditional upsert. A round that read the row before another round wrote a newer version then overwrites that version. The newer write has already raised coverage, so its author never re-ships it, and the replicas disagree from then on.
4. **Nothing heals any of this automatically.** `verify()` compares digests that include labels, and on the right device it does repair findings 1 and 2. However, it runs only when someone presses the button in the admin UI (`sync-supervisor.ts` says "on request only", with no timer), and no app calls it.

In findings 1 and 2, `sync()` returns `complete: true` and logs nothing. Each finding has a TLA+ counterexample and a reproduction against the real engine and responder in `packages/sync-engine/__tests__/exchange-round-findings.test.ts`.

## Fix A: compare and write in one statement (finding 3)

The sync apply path should write a snapshot only if it is newer than what the row holds, as part of the upsert itself:

```sql
INSERT INTO shared.records (...) VALUES (...)
ON CONFLICT (id) DO UPDATE SET ...
WHERE excluded.updated_at > shared.records.updated_at
```

`putLabel` needs the same guard on its own primary key. Serialized HLCs compare as strings in HLC order (fixed-width hex wall time, then counter, then node id, which is also how `compareHLC` breaks ties). The delta scans already rely on this.

Nothing else on DSQL changes. `buildWatermarkRaises` takes its value from the rows the transaction wrote, so a write that the guard skips raises nothing, which is already the rule for a write that loses LWW.

We suggest new adapter methods (`putSnapshot`, `putLabelSnapshot`, or a flag) used by both apply loops, rather than changing `put`, so that local and API writes keep their current behaviour. The JavaScript `get` stays, because the metadata cascades and the stand-in admission need to know what the row held. Those decisions can still race with a concurrent round, and they should be reviewed separately; the guard removes only the overwrite.

The device side has the same shape. The requester's inbound loop also does `get` and then `put`, and on a device a local edit can land between the two. The same guard on SQLite covers it.

Model: `GuardedWrite = TRUE`. `finding-lww-race` fails without it, and every `fixed-*` and `deferred-*` model passes with it.

## Fix B: apply in merged per-author HLC order (finding 1)

The responder should apply its inbound items as the requester already does. That is, group them by author with `groupInboundByNodeId`, sort each group by HLC across records, labels and app rows, and apply in that order. We suggest moving `groupInboundByNodeId` out of `sync-engine.ts` into a module both sides import, as was done with `round-cut.ts`. The halted-node rule carries over unchanged, and becomes simpler, because a halt stops one author's run at one point.

This is what `docs/system-design.md` already describes. It fixes finding 1 for items with distinct HLCs. On its own it does not fix finding 2, which is why it comes with fix C.

Model: `MergedApply = TRUE`.

## Fix C: never let coverage, or a reader, see part of an HLC (finding 2)

There are two ways to achieve this. The model passes both.

**C1. One transaction per HLC** (`ApplyUnit = "timestamp"`). Every row sharing an author's HLC commits together, along with its coverage raise. This is the simplest fix, but it does not fit DSQL as things stand: `sdk.setLabels` takes one `clock.now()` for the whole call and then writes in chunks of 3,000 rows, so one HLC can cover more rows than a DSQL transaction may modify. C1 would therefore also need the SDK to take a fresh HLC per chunk, sized so that the chunk and its watermark rows stay within the cap. On SQLite, which has no such cap, C1 is straightforward.

**C2. Deferred coverage** (`ApplyUnit = "deferred"`, which we recommend for DSQL). Rows keep committing one at a time, with three changes:

1. A write on the sync apply path no longer raises coverage in its own transaction.
2. After the last row of each (author, HLC) run, one statement raises that author's coverage entry to that HLC. It does so whether or not the rows were newly written, because a re-shipped run that is already present must still complete it. Otherwise a crash between the rows and the raise would leave the run hidden forever.
3. The responder's scans treat its own coverage as one more `StreamTruncation`: no row above the cloud's coverage for its author is shipped. A run that is still being applied is therefore invisible to every other device, and a crash leaves coverage low, so the requester re-ships the run.

The third change is needed as well as the deferred raise: `mutant-nocap` drops it, and TLC finds the concurrent reader again. C2 needs no large transactions. It does change `guardNodeWatermarks`, which today refuses a commit that skipped a raise; the sync apply path would be exempt, with the raise as its own guarded statement.

Note that C2 relies on fix B. A deferred raise in records-then-labels order would still lift coverage over a label applied later.

## Fix D: run verify on a schedule (finding 4, defence in depth)

`verify()` repairs findings 1 and 2 when it runs on the right device: the writer for a loss on the cloud, and the reader for a loss on a second device. Running it on a slow timer (daily, say) in the supervisor would bound how long any such loss lasts, whatever its cause. This does not replace A to C, because a loss on the cloud is visible only from the device that wrote the row, and that device may be wiped first. However, it is cheap, and it is the only backstop for causes the model does not cover.

## Suggested order

1. **Fix A.** It is small, independent of the others, and removes a permanent divergence.
2. **Fixes B and C2 together.** The four `it.fails` tests should then pass, and vitest will flag them so that `.fails` can be removed.
3. **Fix D.**

For each step, the spec's constants should be set to match the code and `./check-all.sh` rerun, so that the model keeps describing what is deployed.
