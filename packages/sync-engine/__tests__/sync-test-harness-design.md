# Sync Test Harness — Design

Goal: a spec-driven harness so each of the ~100 ranked candidates compiles to a
~5–15 line test instead of ~50 lines of boilerplate. Setup is declarative;
assertions stay imperative inline so failures point at a concrete predicate.

Non-goals:
- A canned "expected world" comparator. Each candidate's expected outcome is
  too varied to express declaratively, and a generic diff would hide *why* a
  test failed. Keep assertions in the test body.
- Hiding the sync engine. Tests should still call `world.engine.exchange()`
  directly; the harness only assembles the inputs.

---

## Three-phase shape

```ts
const w = await setupCase({ dt, presence, tomb, blob, wm, batch });
await w.driveOperation({ side, verb, withBlob });   // optional
await w.exchange({ rounds, inject });                // 1 | 2 | "until-converged"

expect(await w.cloud.recordExists(w.subjectId)).toBe(true);
expect(await w.peerWatermarks().local).toEqual(w.hlcOf(w.subjectId));
```

Three phases reflect the test dimensions cleanly:
1. **`setupCase(spec)`** materializes the *initial state* dimensions (1–6).
2. **`driveOperation`** applies dimension 7 (the trigger).
3. **`exchange`** runs dimensions 8–10 (rounds, failure, recovery).

A candidate with a tombstone seed (`tomb=cd`) skips phase 2 — the tombstone is
part of initial state. A candidate testing a fresh insert skips initial-state
seeding and only uses phase 2. Both shapes work.

---

## CaseSpec

```ts
interface CaseSpec {
  dt: "SR" | "AR" | "AW";

  presence: "neither" | "local-only" | "cloud-only" | "both-same" | "both-diverged";

  // Defaults: tomb="nd", blob inferred from dt+presence, wm="p", batch="single".
  tomb?:  "nd" | "cd" | "ld" | "bd" | "bd-diff-ts" | "cdu";
  blob?:  "nb" | "cb" | "lb" | "bb" | "nh";   // ignored for AW
  wm?:    "0" | "p" | "cur" | "cR" | "lR";
  batch?: "single" | "multi-homogeneous" | "multi-mixed-nodes" | "exceeds-page-limit";
  batchCount?: number;  // default 3 for multi-*, 2001 for exceeds-page-limit

  appId?: string;       // for AR/AW; default "test-app"
  nodeIds?: { local: string; cloud: string };  // default { local:"local", cloud:"cloud" }
}
```

Defaults chosen so single-record SR happy-path tests are just `{ dt:"SR", presence:"neither" }`.

### Seeding semantics

| presence | what gets seeded |
|---|---|
| `neither` | nothing — both sides empty |
| `local-only` | record/row exists on local at HLC T₁, with blob per `blob` |
| `cloud-only` | mirror |
| `both-same` | identical id + content + same HLC on both sides |
| `both-diverged` | local at HLC T₁ content A, cloud at HLC T₂ content B (T₂>T₁) |

For `both-diverged`, the harness exposes both HLCs as `w.localHlc` / `w.cloudHlc` and the "winning" HLC (the larger one) as `w.expectedWinnerHlc`.

### Tombstone × presence

The tombstone is applied *after* seeding. Tombstones require the record to
exist on the side(s) being marked deleted — the harness throws if a `tomb`
value is incompatible with `presence` (matches constraint C2).

### Blob × presence

Blob defaults by data type when omitted:
- SR: `bb` if `both-*`, else mirrors presence (`lb` for local-only, `cb` for cloud-only); `nh` is illegal for `neither`.
- AR: same as SR.
- AW: forced to `nb` (constraint C4); throws otherwise.

### Page limit

`SyncEngineOptions.pageLimit` (default 1000 in production) caps both the
outbound local scan and the per-exchange request limit. The harness sets it to
a small value (default 5) for tests, and exposes it on the spec:

```ts
interface CaseSpec {
  // ...
  pageLimit?: number;  // harness default: 5; overrideable per case
}
```

S6 tests pass `batch: "exceeds-page-limit"` with the default 6 records and
implicit `pageLimit: 5`, so a single `until-converged` exchange paginates
across two rounds and the invariants (`hasMore`, no dupes, watermark fan-out)
are exercised at full fidelity. The literal 2000-record case is not needed
for correctness — that threshold is a tuning parameter, not a code path.

### Watermark state

In the in-process model the "cloud" is stateless across exchanges — only the
local side has persisted watermarks (`syncState`). So:

| `wm` value | what it means in this harness |
|---|---|
| `0` | both `ownWatermarks` and `peerWatermarks` empty |
| `p` | partial: set behind the most-recently-seeded HLC by one tick |
| `cur` | current: set AT the most-recently-seeded HLC (next exchange is a no-op) |
| `lR` | `ownWatermarks` wiped; `peerWatermarks` preserved (models "local SQLite wipe with data intact") |
| `cR` | `peerWatermarks` wiped; `ownWatermarks` preserved (models "cloud forgot what local sent") |

`cR` reflects what an in-process test can simulate of a real cloud reset — the
local side now believes it's shipped nothing to the cloud, so it re-ships.
Real-world cloud-side watermark loss can't be modeled more faithfully without
a stateful transport, which is out of scope here.

### Batch shapes

- `multi-homogeneous`: `batchCount` records, all same `nodeId` (local by default), HLCs in sequence.
- `multi-mixed-nodes`: half the batch from local's nodeId, half from cloud's, interleaved by HLC.
- `exceeds-page-limit`: `batchCount` defaulted to **6**; the harness configures the engine with **`pageLimit: 5`** so 6 records straddle a page boundary. The invariants under test (`hasMore` signaling, multi-round resume, no record loss/dup, watermark fan-out across pages) are independent of the absolute threshold, so we exercise them cheaply rather than seeding 2001 rows per test. See "Page limit" below.

`w.subjectIds[]` is populated for multi-record cases (and `w.subjectId === subjectIds[0]` for ergonomic single-record assertions).

---

## driveOperation

```ts
interface Operation {
  side: "local" | "cloud";
  verb: "insert" | "update" | "soft-delete";
  withBlob?: boolean;         // for insert/update on blob-bearing DTs
  target?: StarkeepId;        // defaults to w.subjectId
  newContent?: Uint8Array;    // override content for an update
}

await w.driveOperation(op);
```

Bridges to whichever code path the operation belongs to:
- SR `insert`/`update` → `databaseAdapter.put` + storage `put`.
- SR `soft-delete` → `databaseAdapter.delete(id, clock.now())`.
- AR `insert`/`update` → applier.apply on the `_starkeep_sync_records` table + storage `put` (in app-namespaced key).
- AR `soft-delete` → applier.apply with `op="delete"`.
- AW → applier.apply.

The `side` parameter selects which side's adapter is called and which clock issues the HLC — so a `side: "cloud"` operation produces an HLC tagged with the cloud's nodeId, matching how cloud-originated writes work in production.

### driveConcurrent

```ts
type ConcurrentVariant =
  | "both-update"
  | "both-update-local-newer"
  | "both-update-cloud-newer"
  | "both-update-identical-clock"    // same (wallTime, counter), distinct nodeIds
  | "local-update-cloud-delete"
  | "local-delete-cloud-update"
  | "both-update-with-blob-change";

await w.driveConcurrent({ variant, target? });
```

For `*-identical-clock`, the harness wires both clocks to the same wallClock function so they emit (wallTime, counter) pairs that collide — the only way to legitimately trigger an HLC tie in tests.

---

## exchange + failure injection

```ts
interface ExchangeOpts {
  rounds: number | "until-converged";
  inject?: FailureSpec;
}

type FailureSpec =
  | { kind: "blob-upload-fails",     target?: BlobTarget, recov: "transient" | "persistent" }
  | { kind: "blob-download-fails",   target?: BlobTarget, recov: "transient" | "persistent" }
  | { kind: "fail-before-request",   recov: "transient" | "persistent" }
  | { kind: "fail-after-send-before-response", recov: "transient" | "persistent" }
  | { kind: "partial-response-truncated", at?: number /* record index */ };

type BlobTarget =
  | "all"                              // every blob attempt fails
  | { index: number }                  // Nth blob in HLC order
  | { id: StarkeepId }                 // specific record/row
  | "first" | "middle" | "last";       // ergonomic shortcuts for multi-record batches

await w.exchange({ rounds: "until-converged", inject: { kind: "blob-upload-fails", target: "middle", recov: "transient" } });
```

### Implementation sketch

- **Blob failures** wrap `MockObjectStorageAdapter` in a `FailingObjectStorageAdapter` decorator. The wrapper consults the active `FailureSpec` on each `put`/`get` and either passes through or throws. `transient` clears the failure flag after the first attempt on each target key; `persistent` never clears.
- **Transport failures** wrap `createInProcessSyncTransport` in a `FailingSyncTransport` that intercepts `exchange()` calls.
- **`partial-response-truncated`** wraps the transport response to set `hasMore=true` and truncate the records array at index `at`.

The wrappers are part of the harness, not production code.

### Rounds

- `1` or `2`: literal `await engine.exchange()` N times.
- `"until-converged"`: loop while last result's `hasMore === true` or anything was applied/shipped, with a hard cap of (say) 100 iterations to catch divergence bugs as test failures, not hangs.

---

## World surface

```ts
interface World {
  spec: CaseSpec;            // the resolved spec (defaults filled in)

  local: Side;
  cloud: Side;
  engine: SyncEngine;        // the local-side engine that drives exchange
  syncState: SyncStateStore; // for direct watermark introspection / mutation

  // Subject helpers — populated by setupCase / driveOperation
  subjectId: StarkeepId;     // for single-record tests
  subjectIds: StarkeepId[];  // for multi-record tests; subjectIds[0] === subjectId
  objectKey(id?: StarkeepId): string;
  hlcOf(id: StarkeepId): HLCTimestamp;   // the HLC the record was seeded with
  localHlc?: HLCTimestamp;               // for `both-diverged` cases
  cloudHlc?: HLCTimestamp;
  expectedWinnerHlc?: HLCTimestamp;      // for `both-diverged`, max of the two

  // Drivers
  driveOperation(op: Operation): Promise<void>;
  driveConcurrent(c: { variant: ConcurrentVariant; target?: StarkeepId }): Promise<void>;
  exchange(opts: ExchangeOpts): Promise<ExchangeResult[]>;  // one per round

  // Assertion helpers (thin wrappers; tests can also reach into adapters directly)
  recordExists(side: "local" | "cloud", id?: StarkeepId): Promise<boolean>;
  blobExists(side: "local" | "cloud", key?: string): Promise<boolean>;
  residency(side: "local" | "cloud", id?: StarkeepId): Promise<RecordResidency>;
  watermarks(): Promise<{ own: Watermarks; peer: Watermarks }>;
}

interface Side {
  db: DatabaseAdapter;
  storage: ObjectStorageAdapter;       // FailingObjectStorageAdapter when fail injection is active
  applier?: AppSyncableApplier & ScanCapableApplier;
  namespaces?: AppSyncableNamespaceStore;
  clock: HLCClock;
}
```

---

## Example: S1-007 written against the harness

```ts
it("S1-007: SR / both-diverged + local-update → LWW on updatedAt", async () => {
  const w = await setupCase({
    dt: "SR",
    presence: "both-diverged",
    blob: "bb",
    wm: "p",
  });

  await w.driveOperation({ side: "local", verb: "update", withBlob: true });
  await w.exchange({ rounds: 1 });

  const winner = w.expectedWinnerHlc!;
  const cloudCopy = await w.cloud.db.get(w.subjectId);
  expect(cloudCopy?.updatedAt).toEqual(winner);

  const localCopy = await w.local.db.get(w.subjectId);
  expect(localCopy?.updatedAt).toEqual(winner);

  const { peer } = await w.watermarks();
  expect(peer["local"]).toEqual(winner);
});
```

Compare with the equivalent hand-rolled test in current `exchange.test.ts` style: ~70 lines, four adapter constructions, an `appSyncableSource` plumbing block, two clock setups, watermark seeding, and the actual assertions. The harness compresses the boilerplate to one call.

---

## Example: S3-005 (Tier S) — multi-homogeneous + persistent blob-upload-fails-middle

```ts
it("S3-005: SR / multi-homogeneous + persistent middle blob-upload-fails / 1r → prefix lands, tail blocked", async () => {
  const w = await setupCase({
    dt: "SR",
    presence: "local-only",
    blob: "lb",
    batch: "multi-homogeneous",
    batchCount: 5,
  });

  await w.exchange({
    rounds: 1,
    inject: { kind: "blob-upload-fails", target: "middle", recov: "persistent" },
  });

  // r0, r1 ship (prefix before the failure)
  expect(await w.recordExists("cloud", w.subjectIds[0])).toBe(true);
  expect(await w.recordExists("cloud", w.subjectIds[1])).toBe(true);
  // r2 (middle) doesn't, and r3, r4 don't either despite their blobs being fine
  for (const id of w.subjectIds.slice(2)) {
    expect(await w.recordExists("cloud", id)).toBe(false);
  }
  // peerWatermark sits at r1
  const { peer } = await w.watermarks();
  expect(peer["local"]).toEqual(w.hlcOf(w.subjectIds[1]));
});
```

---

## What's NOT in the harness (escape hatches)

- Direct adapter access via `w.local.db` etc. — tests that need to mutate state mid-exchange (rare) can do it inline.
- Custom failure modes beyond the listed `FailureSpec` variants — escape via `w.local.storage.failNext(key)` direct on the FailingObjectStorageAdapter.
- Multi-app scenarios — every test runs with exactly one app namespace by default; tests that need two apps can build a second namespace and merge it into `w.local.namespaces` / `w.cloud.namespaces` manually.
- Out-of-band storage tampering (deleting a blob between rounds) — supported via direct adapter access but not in the spec.

---

## File layout

```
__tests__/
  sync-test-harness/
    index.ts                      # re-exports setupCase, types
    setup-case.ts                 # the main entry point
    side.ts                       # builds a Side (db + storage + applier + clock)
    operations.ts                 # driveOperation + driveConcurrent
    failure-injection.ts          # FailingObjectStorageAdapter, FailingSyncTransport
    presets.ts                    # presence × tomb × blob × wm seeding tables
    mock-app-source.ts            # the AppSyncableApplier mock (extracted from exchange.test.ts)
  s0-baseline.test.ts             # S0-001..S0-009
  s1-presence-op.test.ts          # S1-001..S1-025
  s2-tombstone.test.ts            # S2-001..S2-015
  s3-blob-failure.test.ts         # S3-001..S3-015
  s4-watermark-reset.test.ts      # S4-001..S4-011
  s5-concurrent.test.ts           # S5-001..S5-011
  s6-pagination.test.ts           # S6-001..S6-008
  s7-app-row-conflict.test.ts     # S7-001..S7-007
  exchange.test.ts                # keep existing tests as smoke
```

Per-seed test files keep diffs small as candidates are implemented; the
top-level imports stay short because everything routes through
`./sync-test-harness/index.ts`.

---

## Open design questions

1. **Clock determinism for `both-diverged`**: the harness needs two clocks
   that produce distinct HLCs in a controlled order. Current `exchange.test.ts`
   uses a shared incrementing `time` counter — works for sequencing but makes
   it hard to assert "T₂ > T₁ by exactly 1 wallTime tick". Proposal: harness
   exposes a `w.tick()` method that advances both clocks' shared wallClock by
   1, so tests that care can sequence explicitly. Default behavior is
   automatic ticking on each seeding/operation call.

2. **AR app-namespace key convention**: tests need a stable key format.
   Proposal: `app/<appId>/<subjectId>` — matches the prefix-encoded-key model
   we settled on. Hard-code it in the harness; tests don't pass keys in.

3. **`exceeds-page-limit` performance** — *resolved*: `SyncEngine` now takes
   a `pageLimit` option (default 1000 in production). The harness sets it to
   5 for `exceeds-page-limit` cases and seeds 6 records, exercising the same
   `hasMore` / multi-round-resume / no-dup / watermark-fan-out invariants in
   ~3ms instead of seeding 2001 rows. The absolute 2000 threshold is a
   tuning parameter, not a code path under test.

4. **Failure-injection composability**: `inject` is a single value, not an
   array. If a candidate ever needs two simultaneous failures (e.g. one blob
   upload + one blob download), the harness will need to accept an array.
   None of the current 100 candidates require this — defer.

5. **Should `setupCase` return a typed discriminated union on `dt`?** e.g.
   `World<"SR">` exposes `subject` as a `DataRecord`, `World<"AW">` exposes it
   as an `AppSyncableRowEntry`. Adds type safety; adds harness complexity.
   Probably worth it for AR/AW assertions where reaching into `entry.row` is
   awkward.
