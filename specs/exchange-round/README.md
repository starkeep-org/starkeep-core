# Exchange round: TLA+ model

A model of the Drive channel's `/sync/exchange` round, checked exhaustively with TLC over small configurations. It checks the rule `round-cut.ts` states:

> What you ship must be a contiguous prefix, in HLC order, per author, across everything the coverage watermark covers.

The model checks that rule end to end. It covers the requester's scan and cut, the cloud's statement-by-statement apply on DSQL, the cloud's own scan and cut, the coverage report, and the requester's watermark updates. Rounds from several devices interleave on the cloud, and the cloud can die or lose its response at any point.

## Findings

All three findings are in the responder's apply (`in-process-transport.ts`, steps 2 and 2b), which is also the cloud's code path (`cloud-data-server/src/api-handler.ts` builds the same transport). Each has been reproduced against the real engine and responder in `packages/sync-engine/__tests__/exchange-round-findings.test.ts`, and an independent review of the code found no mechanism that prevents or automatically repairs them.

### 1. Records are applied before labels, so the cloud's coverage can claim a label it lacks

The responder applies every record in a shipment, then every label. Each write is its own DSQL transaction and raises its author's coverage entry (`node-watermarks.ts`). When a label's HLC sits below one of the shipment's records, there is a window in which the cloud's coverage claims that label without holding it. Any ordinary sequence opens this window: photo, label on it, next photo.

`docs/system-design.md` says the opposite ("applied in merged per-node HLC order with records"). The requester's inbound loop does merge the two streams; the responder's does not. A comment at step 2 notes the difference and judges it harmless ("only costs their re-ship"). That holds for a halted node, but not for a crash or a concurrent reader.

**1a. Crash (`models/finding-crash.cfg`, `CloudNoLoss`, depth 14).** The label never reaches the cloud.

| Step | What happens                                                                                 | State afterwards                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1    | Device L writes `label@1`, then `record@2`.                                                  | L holds both.                                                                                                          |
| 2    | L pushes. The cloud applies `record@2`.                                                      | Cloud coverage for L is 2.                                                                                             |
| 3    | The Lambda dies before the label write.                                                      | L's response is lost; L's cache of the cloud's coverage is still 0.                                                    |
| 4    | L's next `sync()` owes the cloud something, so it pulls first (`exchange({ push: false })`). | The response reports coverage L = 2. L replaces its cache with it.                                                     |
| 5    | L pushes, scanning above 2.                                                                  | `label@1` is below the scan, so it is never offered again. The cloud never gets it, and neither does any other device. |

**1b. Concurrent reader (`models/finding-concurrent.cfg`, `DeviceNoGap`, depth 10).** A second device never gets the label.

| Step | What happens                                                                   | State afterwards                                  |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| 1    | L writes `label@1`, then `record@2`, and pushes. The cloud applies `record@2`. | The cloud holds `record@2` but not `label@1` yet. |
| 2    | Device M's round is served in that window. The cloud ships `record@2`.         | M's rows watermark for L is 2.                    |
| 3    | L's label lands.                                                               | The cloud is now complete.                        |
| 4    | M keeps syncing. The cloud ships L's rows above 2.                             | `label@1` is never offered to M.                  |

### 2. One HLC can be split across statements

A batch shares one HLC: `sdk.setLabels` takes a single `clock.now()` for the whole call, however many rows it writes. The responder writes the batch one row per transaction, and after the first row lands, coverage claims the whole timestamp. A crash or a concurrent reader in that window loses the rest of the batch, by the same two routes as above (`models/finding-batch-crash.cfg`, `CloudNoLoss`; `models/finding-batch-concurrent.cfg`, `DeviceNoGap`). This happens in today's code without any record in the shipment, and it survives the merged order the design describes.

`cutRound` and `collectSince` already treat one HLC as indivisible on the sending side, for this very reason. The apply on the receiving side has to do the same.

### 3. The LWW check and the write are separate transactions: a lost update

The responder decides LWW in JavaScript, with a `get` and then a `put` (or `getLabel` and `putLabel`), and on both DSQL and SQLite the write is an unconditional upsert. Two rounds writing the same key can interleave: round A reads the row, round B writes a newer version and raises its author's coverage, and round A then overwrites it with the older version. B's author never re-ships its version, because the cloud's coverage already claims it, so B and the cloud disagree about that record from then on (`models/finding-lww-race.cfg`, `CloudNoLoss`, depth 12). Two devices editing the same record offline and syncing together is enough. The requester's inbound loop has the same shape, with a local edit in place of the second round.

### Does anything heal these?

Not automatically. `verify()` compares per-bucket row counts across records and labels, and on the right device it repairs findings 1 and 2: on the writer for a label the cloud lacks, and on the reader for a label a second device lacks. However, it runs only when someone presses the button in the admin UI (`sync-supervisor.ts` says "on request only", with no timer), and no app calls it. Finding 3 is invisible to it, because both sides hold the same number of rows. In findings 1 and 2, `sync()` returns `complete: true` and logs nothing.

### What passes

`FIXES.md` proposes fixes and the order to make them in. In brief, these are guarded writes (`GuardedWrite = TRUE`), merged per-author apply order (`MergedApply = TRUE`), and one of two ways of keeping an HLC whole. The simpler, one transaction per HLC (`ApplyUnit = "timestamp"`), does not fit DSQL's 3,000-row transaction cap as `setLabels` stands. The other is deferred coverage: rows commit one at a time, coverage is raised once a whole HLC has been applied, and the cloud's scans never ship a row above its own coverage (`ApplyUnit = "deferred"`). Every `fixed-*` and `deferred-*` model passes; `mutant-nocap` shows that the scan cap is needed as well as the deferred raise.

These are proposals checked against the model, not changes that have been made. All four reproduction tests are `it.fails`, and they will start failing, as a prompt to remove `.fails`, once the code is fixed.

## Results

`./check-all.sh` compares each model's verdict with `expected.txt`. Every `pass` row is exhaustive: TLC explored every reachable state.

| Model                     | Shape                                                | Expected and got | Distinct states | Depth |
| ------------------------- | ---------------------------------------------------- | ---------------- | --------------- | ----- |
| finding-crash             | records then labels, guarded writes, 1 crash         | CloudNoLoss      | 349             | 13    |
| finding-concurrent        | records then labels, guarded writes, 2 devices       | DeviceNoGap      | 464             | 10    |
| finding-batch-crash       | batch of 2 sharing an HLC, guarded writes, 1 crash   | CloudNoLoss      | 96              | 11    |
| finding-batch-concurrent  | batch of 2 sharing an HLC, guarded writes, 2 devices | DeviceNoGap      | 153             | 12    |
| finding-lww-race          | read-then-write LWW before fix A, 2 writers, one key | CloudNoLoss      | 721             | 13    |
| fixed-crash               | guarded, merged, one transaction per HLC; 1 crash    | pass             | 404             | 14    |
| fixed-concurrent          | as above, 2 devices                                  | pass             | 1,435           | 22    |
| fixed-batches             | 3 records, batches of 2, 1 crash                     | pass             | 174,688         | 20    |
| fixed-labelbatch          | 2 devices, label batch, Limit 1, 1 crash             | pass             | 36,102          | 25    |
| fixed-two-writers         | 2 writers, 2 records + 1 label, Limit 1, 1 crash     | pass             | 1,294,812       | 33    |
| fixed-hlc-skew            | 2 writers, HLCs not in real-time order               | pass             | 381,993         | 33    |
| fixed-relay               | 2 writers, batches, Limit 2, 1 crash                 | pass             | 11,432,190      | 33    |
| deferred-crash            | guarded, merged, deferred coverage; 1 crash          | pass             | 582             | 17    |
| deferred-concurrent       | as above, 2 devices                                  | pass             | 1,657           | 24    |
| deferred-batch-crash      | batch of 2, 1 crash                                  | pass             | 120             | 14    |
| deferred-batch-concurrent | batch of 2, 2 devices                                | pass             | 246             | 19    |
| deferred-batches          | 3 records, batches of 2, 1 crash                     | pass             | 315,125         | 27    |
| deferred-labelbatch       | 2 devices, label batch, Limit 1, 1 crash             | pass             | 56,814          | 29    |
| deferred-two-writers      | 2 writers, Limit 1, 1 crash                          | pass             | 2,109,054       | 36    |
| deferred-relay            | 2 writers, batches, Limit 2                          | pass             | 4,411,065       | 38    |
| mutant-nocap              | deferred coverage without the scan cap               | DeviceNoGap      | 170             | 11    |
| mutant-notrim             | `collectSince` without the HLC-boundary trim         | CloudNoLoss      | 188             | 10    |
| mutant-split              | `cutRound` cutting items, not whole timestamps       | CloudNoLoss      | 170             | 9     |
| mutant-perstream          | ceiling per stream instead of the minimum            | CloudNoLoss      | 15,912          | 9     |
| witness-relayed-label     | a device holds another device's label                | reached          | 14,038          | 9     |
| witness-truncated         | a round ships less than it owes                      | reached          | 399             | 5     |
| witness-batch             | a batch arrives whole on another device              | reached          | 2,086           | 8     |
| witness-crash             | a crash happens                                      | reached          | 486             | 5     |
| witness-converged         | every write done, everyone holds the same rows       | reached          | 20,334          | 10    |

The mutants show the model catches the rules the code's comments call load-bearing. The witnesses show the interesting states are reachable, so a clean run is not a vacuous one.

## Invariants

- **DeviceNoGap.** A device's rows watermark never claims a version it lacks. The cloud ships author `a`'s rows only above that watermark, so a claimed-but-missing version is never offered again. A version that a newer, unclaimed version of the same key supersedes is exempt.
- **CloudNoLoss.** The cloud lacks a version only while something will still bring it: a shipment in flight, or a device that holds an equal or newer version and does not believe the cloud has it.
- **CloudCoverageHonestAtRest.** With nothing in flight, the cloud's coverage claims no version it lacks, apart from superseded ones. This is not a loss in itself. It is the window both findings come through, and it fails first whenever either loss is possible, so the finding and mutant models leave it out to show the loss itself.

Liveness is not checked. `witness-converged` shows that convergence is reachable, not that it is guaranteed.

## Action-to-code map

| Action                          | Code                                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Write(n, S, t)`                | An app write, e.g. `sdk.setLabels`: one `clock.now()` for the whole batch. The HLC is above everything the device holds, because every applied row went through `clock.receive`.                                                                                      |
| `Scan`, `Collect`               | `collectSince`, `planNodeScans`, `trimToHlcBoundary` in `storage-adapter/src/database/since-queries.ts`                                                                                                                                                               |
| `Ceiling`, `Eligible`           | `computeCeilings` in `sync-engine/src/round-cut.ts`                                                                                                                                                                                                                   |
| `Cut`                           | `cutRound` in `round-cut.ts`                                                                                                                                                                                                                                          |
| `Start(n, push)`                | `exchange()` in `sync-engine/src/sync-engine.ts`, outbound half; the pull-first round is `exchange({ push: false })` in `sync()`                                                                                                                                      |
| `CloudRead(n)`, `CloudWrite(n)` | `in-process-transport.ts`, steps 2 (records) and 2b (labels) as written: `get` / `getLabel`, the LWW comparison, then `put` / `putLabel`, each its own DSQL transaction; the coverage raise is `buildWatermarkRaises` in `storage-aurora-dsql/src/node-watermarks.ts` |
| `CloudApply(n)`                 | The same apply with the comparison inside the write (fix A), optionally one transaction per HLC (`ApplyUnit = "timestamp"`)                                                                                                                                           |
| `CloudRaise(n)`                 | Proposed fix C2: the deferred coverage raise after an HLC's last row                                                                                                                                                                                                  |
| `CloudRespond(n)`               | `in-process-transport.ts`, steps 3 to 5                                                                                                                                                                                                                               |
| `Crash(n)`                      | A Lambda timeout, or a response lost on the way back                                                                                                                                                                                                                  |
| `Receive(n)`                    | `exchange()`, inbound half: LWW apply, `ownSafeAdvance` into `setWatermarks`, and the authoritative replace into `setPeerWatermarks`                                                                                                                                  |

## What is not modelled

- App-syncable tables. A third stream would behave like the label stream; note that the responder's step 1 applies app rows before records.
- Byte budgets. Rows cost 0 bytes in both cuts.
- Repair floors, digests, the uploader and the bytes watermark.
- Apply failures and `haltedAuthors`; `coverageComplete = false`; `refusedAuthors`.
- The cloud authoring rows itself (`keepLiveOnTombstone`, stand-in slots).
- Deletion. A tombstone is just another LWW version here.
- Hard deletes of cloud rows.

The cloud's scan and coverage read are one atomic step. In the code they are separate statements, so the real system has more interleavings than the model, not fewer.

## Running

You need Java 11 or later and `tla2tools.jar`. Set `TLA2TOOLS` to the jar's path, or put the jar beside these files; it is gitignored.

```sh
./gen-models.sh                       # regenerate models/*.cfg from the table in the script
./check-all.sh                        # every model, compared with expected.txt (about 25 minutes)
QUICK=1 ./check-all.sh                # only the models tiered "quick" (under a minute)
./check-all.sh fixed                  # only the models whose name contains "fixed"
./run.sh models/finding-crash.cfg     # one model, with TLC's full trace
```

Full TLC output for each model is written to `traces/<name>.out`, which is gitignored.

CI runs the quick tier on every pull request (the `exchange-round-model` job in `.github/workflows/ci.yml`), with a `tla2tools.jar` pinned by version and checksum. The four slow models (`fixed-relay`, `fixed-two-writers`, `deferred-relay` and `deferred-two-writers`) cover the same mechanisms on larger configurations, and are left to a manual run.

To change the protocol, change the code and this spec together. Then rerun `./check-all.sh`, and turn any new counterexample into a test beside `exchange-round-findings.test.ts`.
