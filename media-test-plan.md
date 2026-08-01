# Media storage & transfer — test plan

**Companion to** [`media-implementation-plan.md`](./media-implementation-plan.md). Item numbers here are
that document's item numbers. **Status:** living — updated as each item lands, not written at the end.

This doc says *how we know each item works*. It is organized by work item, and each item carries three
things:

- **Automated** — what is covered by tests in the repo, and where they live.
- **Manual / operator** — what cannot be automated and who has to look at it.
- **Gaps** — what is knowingly untested, with the reason.

A gap with a reason is a decision. A gap without one is a bug waiting to be found in production, so
every entry under **Gaps** must say why.

---

## Cross-cutting principles

**Test the property, not the implementation.** The residency, durability and archive-gate items all
have the shape "this must never happen" (never evict a last copy, never implicitly thaw, never
archive an incomplete ladder). Those get tests that assert the *negative* directly, because a test
that only checks the happy path passes just as well when the guard is deleted.

**Anything that can destroy data gets an adversarial test.** Three places qualify: the eviction pass
(item 1b), the reaper (item 19d), and dedup tiers 2–3 (item 22). For each, the test suite must contain
at least one case that would delete a wanted object if the guard were removed, and assert it doesn't.

**Numbers from §2 of the plan are provisional.** No test may assert a specific class maximum (400,
1280, 2560, 4272) as a *literal*, because those integers are the visual test's output (item 9b) and
will change. Tests assert *relationships* — a rendition never upscales, classes form a contiguous
prefix, resolution picks the smallest ≥ target — and read the maxima from the ladder definition.

**Consumers must not name size classes.** A grep-level test asserting no size-class string literal
appears outside the ladder definition is worth more than any single behavioral test here, because the
failure it prevents is "a client hard-codes `image-screen`" and that is invisible until a respec.

---

## Open gaps register

**This table is an index, not the record.** Each per-item **Gaps** section below is authoritative
for detail and reasoning; this exists so nobody has to read the whole document to find out what is
open. When a gap closes, strike it here *and* in its section.

Severity is about the consequence of shipping with it, not the effort to close it:

- **Blocking** — something reads as working and is not, or data can be lost. Must close before the
  relevant item is trusted in production.
- **Deferred** — knowingly incomplete, with a named item that closes it. Safe meanwhile.
- **Accepted** — will not be closed here; the reason is recorded.

| Severity | Gap | Item | What closes it |
|---|---|---|---|
| **Blocking** | `RestoreObject` is never actually called — the endpoint records state, returns an estimate, and thaws nothing. It **looks complete and is not**. | 5b | Item 19 |
| **Blocking** | Nothing maintains `availability`. Every record reads `instant` in a real deployment regardless of what happened to it. | 5b | Item 19b |
| **Blocking** | Multipart uploads are unverified above the part threshold in the buffered `put()` path; the streamed path verifies, the convenience method does not. | 1b-i / 2 | An `e2e-aws` test plus routing all large writes through `putStream` |
| **Blocking** | The attempt ledger has no storage, so the never-retry-undecodable guarantee is built, tested, and **inert** — a sweeper would re-fail on every HEIC daily. | 7 | A node-local (non-syncable) table |
| **Deferred** | No cloud derivation sweeper is scheduled. Decision logic exists and is tested. | 7 | Scheduled Lambda |
| **Deferred** | No lifecycle rule exists, so `archive`-tagged objects are tagged and nothing acts on them. | 4/5 | Item 18 |
| **Deferred** | Nothing declares `archive` intent yet; every write is `instant`. | 4/5 | Item 17 |
| **Deferred** | `absent` is never written on the cloud, so a `no-cloud` record reads `instant` there. | 5b | Item 19b |
| **Deferred** | The local data server does not report `availability` at all. Harmless today (local bytes are readable or elided) and therefore invisible. | 5b | Wiring the local `/data/records` response |
| **Deferred** | No eviction pass is scheduled; `runEviction` is reachable and uncalled. | 1b | Item 15/34 (residency inspector) |
| **Deferred** | `protectedLocally` is never set, so the durability predicate is the only thing between eviction and a last copy. | 1b | Item 7's derivation-input tracking |
| **Deferred** | `recencyAtMs` is always null from the sync engine, so `recent-only` behaves as `all`. | 1b | Host decider supplying capture time |
| **Deferred** | Only one rung is produced by the resize path in practice until every ingest route uses `deriveStillLadder`. | 6/7 | Item 7 completion |
| **Deferred** | ThumbHash and perceptual hash are not computed despite their columns existing. | 4/21 | Derivation populating them |
| **Deferred** | Video derivation is not wired; the ladder helpers are tested and uncalled. | 6 | Item 27 |
| **Deferred** | Renditions do not sync before originals. **The plan's claim that this is a scheduling change is wrong** — it needs blob transfer decoupled from the metadata prefix rule. | 7 | A protocol change, not yet scoped |
| **Deferred** | No test asserts consumers never name a size class. | 6 | Item 9, when there is a consumer that could violate it |
| **Accepted** | Every number in the ladder is unverified. The largest open item in the plan; gates backfill. | 6 | Item 9b — human judgement, cannot be automated |
| **Accepted** | Buckets created before item 0 can never get Object Lock. | 0 | Nothing — AWS design |
| **Accepted** | A permanently corrupt source retries forever with a warning rather than escalating. | 2 | Surfacing it in the residency inspector |
| **Accepted** | Restore estimates are unvalidated against a real bill. | 5b | Item 35 (CUR) |

Test-coverage gaps that are not behavioural risks — no end-to-end variant resolution through a
running server, no route-level test of the local server's filters, `MAX_CHILDREN_PER_PAGE`
truncation, video variants, `precheckThumbnail`'s composition, the S3 `availability` mapping, real
image bytes through `deriveStillLadder`, and whether the `NOT EXISTS` is actually indexed — are
listed in their own sections rather than here, because each is "we did not write this test" rather
than "this does not work".

---

## Phase 0a

### Item 0 — `objectLockEnabled` on the files bucket

**Automated** — `packages/admin-installer/__tests__/cloud-data-server-hardening.test.ts`, under
Pulumi's runtime mocks (no cloud, no engine):

| Test | Asserts |
|---|---|
| `enables Object Lock on the files bucket` | `objectLockEnabled === true` for a real install |
| `configures no bucket-level default retention` | **zero** `BucketObjectLockConfigurationV2` resources exist |
| `leaves Object Lock off so the bucket can be torn down` | ephemeral installs get neither the flag nor a config |

The second and third matter more than the first. A bucket-level default retention would make every
object written under it permanently undeletable and rendition supersession impossible, and it is the
kind of thing a later "let's finish the Object Lock item" change adds without noticing — so the
absence is asserted, not just the presence.

IAM: `s3:PutBucketObjectLockConfiguration` added to the foundational permissions boundary and the
cloud-data-server temp-install policy (AWS requires it alongside `CreateBucket` +
`PutBucketVersioning` to create a bucket with the flag).

**Manual / operator** — the first real install after this lands must be checked with
`aws s3api get-object-lock-configuration --bucket <files-bucket>`, which should return
`ObjectLockEnabled: Enabled` and **no `Rule`**. Nothing in the mocked test suite proves AWS accepted
the flag; only a real install does.

**Gaps** — buckets created *before* this item cannot be retrofitted, by AWS's design. Any existing
install is permanently without Object Lock and no test can detect or fix that. This is the accepted
consequence the item's ordering exists to minimize, not a defect.

---

## Phase 0

### Item 1b-i — verifiable uploads and widened `has()`

Two separable properties, tested separately because they fail separately.

#### (a) The broker decides what may be written at a content-addressed key

The uploader has no say. Because record keys *are* the SHA-256, the presign
endpoint derives the expected checksum from the key and binds it into the
signature; S3 then rejects a mismatched body rather than storing it.

**Automated**

| Test | Where | Asserts |
|---|---|---|
| `derives the checksum from the key and returns it` | `cloud-data-server/__tests__/routes-db.test.ts` | pinned value is the key's hash, and `x-amz-checksum-sha256` appears in the signed URL — advertising it beside the URL without signing it would let an uploader drop the header |
| `ignores a caller-supplied checksum in favour of the key's` | same | a body-supplied checksum is not honoured; honouring it would reduce the guarantee to "the uploader verified its own bytes", which is no guarantee |
| `pins nothing for a non-content-addressed key` (in the app-data presign test) | same | app-syncable subKeys are stable names, not hashes — inventing a pin would reject every legitimate rewrite |
| `contentHashFromDataRecordObjectKey` rejection table | `protocol-primitives/__tests__/object-keys.test.ts` | shard/hash disagreement, wrong namespace, uppercase, wrong segment count all return `null` — each is a way a non-Starkeep key could otherwise dictate the pin |
| `sha256HexToBase64` throws on malformed input | `storage-adapter/__tests__/checksum.test.ts` | a silently-wrong conversion would defeat exactly the verification it provides, so it must throw rather than produce a plausible string |
| fake-cloud blob-upload trio | `testkit/__tests__/fake-cloud.test.ts` | matching body accepted; mismatched body **400s and stores nothing**; missing header **refused** |

The fake cloud's `/__blob/` stand-in was made to *enforce* the checksum, and the
`MockObjectStorageAdapter` likewise rejects a mismatched body. This is the load-bearing
part: without it, every test of this path would pass identically with the verification
deleted.

**Gaps**

- **Multipart uploads go up unverified.** Confirmed against the current S3 docs
  (`checking-object-integrity-upload`), **not assumed** — this closes the plan's open item 7.
  SHA-256 is **composite-only** for multipart; full-object multipart checksums exist but are
  CRC-only (CRC64NVME/CRC32/CRC32C), because only CRCs linearize from part checksums. So a
  whole-object SHA-256 pin is *not available* for multipart, and passing one fails the upload
  rather than verifying it. The mechanism that does work is **per-part**: each `UploadPart`
  carries its own `ChecksumSHA256` and S3 rejects a bad part, with the composite attesting the
  assembly; the uploader must additionally verify the whole-object hash as it streams and abort
  on mismatch. **That belongs to item 2 (streaming/multipart transfer) and is not done yet** —
  today the >5 MB path in `S3ObjectStorageAdapter.put` uploads unverified. This is the plan's
  own "matters exactly for the largest and least replaceable objects", so it must not be
  forgotten when item 2 lands. **Closed by item 2** — see its section below for both halves
  (per-part checksums, plus whole-object verification that errors the stream before the upload
  can complete).
- **No test proves S3 itself rejects a bad body.** Everything above is against mocks and the
  fake cloud. Only a real presigned PUT against a real bucket does that; it belongs in the AWS
  tier (`e2e-aws`).

#### (b) `stat()` — existence is not readability

`has()` returns `true` for a Deep Archive object that cannot currently be read at all.
Anything deciding whether a read will succeed, or whether it is safe to drop the only
other copy of some bytes, must use `stat()` and read `availability` / `checksumSha256`.

**Automated**

| Test | Where | Asserts |
|---|---|---|
| `distinguishes an archived object from an absent one` | `storage-adapter/__tests__/mock-object-storage-adapter.test.ts` | `has()` says `true` **and** `stat()` says `archived` for the same key — the exact confusion the widening exists to end |
| `reports a restore in flight` | same | `restoring` is its own state, not "archived" and not "readable" |
| `reports null when no checksum was supplied` | same | unknown ≠ verified; a store that hashed bytes at read time would answer a different question |
| `reports an unknown checksum rather than synthesizing one` | `storage-fs/__tests__/adapter.test.ts` | a local filesystem verifies nothing at write time and must say so — the durability predicate keys on this distinction before it deletes anything |
| `follows a symlink to report the target's size` | same | symlinked keys are how the watcher avoids duplicating watched files |
| `sha256Base64ToHex` returns null for a composite | `storage-adapter/__tests__/checksum.test.ts` | a multipart composite must never be compared against a `contentHash` as though it were one |

`MockObjectStorageAdapter.setAvailability()` exists solely so tests can produce an object
that **exists and cannot be read** — there is no other way to get one in-process, and the
guarantees that matter most in this plan are only reachable from that state.

**Gaps**

- **The S3 `availability` mapping is untested.** `availabilityOf()` reads HEAD's
  storage-class / archive-status / restore triple, including the case that motivated it: an
  Intelligent-Tiering object reports `INTELLIGENT_TIERING` whether or not it has sunk into an
  async archive tier, and only `ArchiveStatus` says which. The `storage-s3` package has no test
  harness for HEAD responses yet. **This is a real hole, not a deferral** — it should be closed
  with an `aws-sdk-client-mock` test of `stat()` when item 5b needs the same mapping.
- No consumer reads `availability` yet; it is wired but unexercised until item 5b.

### Items 1 / 1b / 1c — residency, eviction, durability, per-record overrides

Landed as one unit. They were separable on paper and not in practice: budgets without byte
accounting don't bind, and a decision without an enforcement point is advisory.

#### The property that matters most

> **A declined blob advances the watermark. A failed blob does not.**

Before this, those were the same event — a blobless record held the watermark and the peer
re-shipped it forever — which is why "I have the metadata and I don't want the bytes" was
inexpressible and both a phone node and any archive tier were blocked.

`sync-engine/__tests__/residency-exchange.test.ts` asserts both halves *against each other* in
one test (`holds the watermark on failure and advances it on decline`), because each alone
passes under an implementation that gets the other backwards.

| Test | Asserts |
|---|---|
| `applies the metadata and skips the bytes` | record present, blob absent, `elided` counted |
| `advances the watermark, so the peer stops re-shipping it` | round two ships nothing and the decider is not consulted again |
| `counts the decline separately from an applied record` | a node quietly declining everything must not look identical to a healthy one |
| `does not credit byte accounting for bytes that never arrived` | accounting follows bytes, not intent |
| `does not report an arrival when the transfer fails` | a flaky link must not let a node convince itself it is full of things it doesn't have |
| `residencyOf` group | `staged` vs `elided` vs `resident` vs `tombstoned` vs `absent`; elided-ness **re-evaluated, not stored**, so raising a budget makes a record staged again with no migration |

#### The decision (`residency-policy.test.ts`, 19 tests)

Resolution order is tested by conflict, not in isolation — a record constraint beating a pin,
a pin beating an exhausted budget, a pin beating `keep: "never"`. Getting the order wrong
doesn't look like a bug; it looks like a preference being honoured.

Also covered: each keep rule; recency window including "old but opened recently"; **unknown
date fetches rather than declines** (a metadata gap must not silently cost you the bytes);
unclassified records fall back to fetching (over-fetching costs disk, under-fetching costs
data); budget checked last so a class is only declined for want of room, never for want of
interest; and `validateRetentionPolicy` refusing a zero budget with a message pointing at
`keep: "never"` — a zero budget reads as a limit and behaves as a prohibition.

**Class names in these tests are deliberately nonsense** (`classA`). A test using real ladder
names would encode the opposite of the design property: the platform must never learn what
`image-medium` is.

#### Eviction and durability (`eviction.test.ts`, 30 tests)

Per the cross-cutting principle, this is the suite where **every "kept" case would delete a
wanted object if its guard were removed**:

| Guard | Test |
|---|---|
| Nothing evicted without a confirmed replica elsewhere | `refuses to evict anything not confirmed elsewhere` — and reports `shortfall`, rather than claiming a success it didn't achieve |
| No content hash → no way to tell a correct replica from an object merely occupying the key | `refuses when there is no content hash to verify a replica against` |
| Durable ≠ readable | `refuses to drop the last instantly-readable copy` (an archived copy is durable and twelve hours away) |
| A failing probe is not evidence of presence *or* absence | `treats a failing probe as no evidence at all` |
| Corruption reaches a human | `surfaces suspected corruption` — a checksum disagreement is evidence a copy is wrong, not merely a reason to skip |
| Unverified ≠ verified | `does not count a present-but-unverified replica by default`; counting it requires an explicit opt-in |
| The operator's reduction request is answered honestly | `refuses outright when no peer is available to confirm anything` — quietly degrading into "keep everything" would look like it worked |

Plus the mechanics: hysteresis (nothing below the high-water mark; frees to the low mark and
**not far past it**); bytes deleted and index row forgotten together; re-derivable blobs
(renditions) evicted without a durability bar, which is what makes a phone cache workable;
backpressure advancing one shed step at a time with the operator prompt last, because capture
never blocks.

#### `starkeep/no-cloud` (item 1c)

Enforced on **both** blob-write entry points in the cloud handler, not just the one the sync
engine happens to use — `refuses to presign a write for a record marked starkeep/no-cloud`.
A fetch-time residency decision cannot stop an inbound push, so a guarantee only one side of a
transfer enforces is not a guarantee. Content-addressed keys can be shared by two records; any
one of them saying no-cloud refuses the write, because the exclusion is about the bytes.

Pins are node-local (a `local_pins` table), deliberately **not** a label. A pin shared as a
label would let one device's preference silently rewrite every other device's cache policy.

#### Bugs this suite caught

- **Unbound SQL placeholders in the eviction candidate query.** Kysely parameterizes plain
  values, so `where("pinned", "=", 0)` compiled to `?` in a statement prepared once and bound
  with one argument — `evictionCandidates` silently returned **nothing**, i.e. eviction would
  never have evicted anything. Fixed with `sql.lit`.

**Gaps**

- **`protectedLocally` is never set yet.** The field and its guard exist and are tested, but
  nothing writes it until item 7 (derivation) knows whether bytes are still needed as an input
  here. Until then the durability predicate is the only thing between the eviction pass and a
  last copy — which is why its default is to refuse.
- **No eviction is scheduled.** `runEviction` is wired and reachable but nothing calls it on a
  timer or on budget crossing. Deliberate: the trigger belongs with the residency inspector UI
  (item 15/34), and an unattended eviction loop before that exists is the wrong order.
- **`recencyAtMs` is always null from the sync engine.** Capture time lives in the per-category
  metadata table, not the record row, and the engine has only the row. A null reads as
  "unknown" and therefore fetches, so the failure is conservative — but `recent-only` is
  currently equivalent to `all` for records synced this way until the host's decider supplies
  the date.
- **No test drives residency through the real local-data-server.** The manager is wired into
  both engines and the config path, but the integration tests exercise the sync-engine seam,
  not the assembled server. Closing this needs a fixture with a `retention` policy in
  `config.json`.

### Item 2 — streaming / multipart blob transfer

Two properties the previous buffered implementation could not have.

#### (a) A transfer never materializes the object

`source.get()` → `destination.put()` held the whole object in memory, so a 2 GB clip could not
sync at all — not slowly, at all. `ObjectStorageAdapter` gains `getStream` / `putStream` over
**web `ReadableStream`** (not Node streams, so the same interface stays implementable on React
Native and in a browser for Phase 2), and `transferFile` uses them.

| Test | Where | Asserts |
|---|---|---|
| `never calls the buffered get/put` | `sync-engine/__tests__/streamed-transfer.test.ts` | counts calls to `get`/`put` and requires **zero** — this is how we know the streaming path is the real one and not a wrapper around the old behaviour |
| `round-trips a streamed write and read` | `storage-fs/__tests__/adapter.test.ts` | multi-chunk source, so the write path is exercised as a stream rather than a single enqueue that happens to look like one |
| `short-circuits when the destination already holds the key` | streamed-transfer | no stream is opened at all |
| `does not leave the key marked in-flight after a failure` | streamed-transfer | a leaked in-flight marker would make every retry return false without attempting anything, and the record would be stuck forever |

#### (b) A corrupted transfer fails rather than landing — and this closes the item 1b-i gap

The gap recorded under item 1b-i was that multipart uploads went up unverified, because a
whole-object SHA-256 is not available for multipart (composite-only; full-object multipart
checksums are CRC-only). Both halves of the fix are now in:

- **Per part** — `putStream` passes `ChecksumAlgorithm: "SHA256"` to `Upload`, so S3 validates
  each `UploadPart` and rejects a corrupted one, with the stored composite attesting the
  assembly.
- **Whole object** — the writer hashes as the bytes go past and **errors the stream at
  end-of-input** on a mismatch. The ordering is the point: the digest is only final when the
  stream ends, which is also when the upload wants to complete, so checking *after* the pipe
  resolves would mean the multipart upload has already completed and the bad object is stored.
  `verifyingStream` fails from inside `pull` at `done`, which makes the upload reject and abort.

| Guard | Test |
|---|---|
| A corrupt transfer stores nothing | `rejects a transfer whose bytes don't match the key, storing nothing` |
| A truncated stream is caught | `catches a truncated stream` (`stream-verify.test.ts`) — what a dropped connection looks like, and what a length check alone would miss |
| The failure is a stream *error*, not a return value | `errors the stream rather than closing it when the digest disagrees` — a consumer that finalizes on close would already have stored the object |
| The FS write is atomic | `leaves nothing at the key when the digest disagrees`, `leaves no partial file behind either`, `does not clobber an existing object when the replacement fails` — writes go to a temp name and rename in, because a half-written file at the real key looks exactly like a complete one to `has()`, which is how a corrupt object becomes something the durability predicate counts as a replica |
| Records with no derivable hash still transfer | `transfers unverified when no hash is derivable` — `fileHash` falls back to the object key when a record has no `contentHash`, and a key is not a hash; failing those every round would break records predating content hashing |
| A content-addressed key alone is enough | `still recovers the hash from a content-addressed key alone` |
| The multipart upload is aborted, not abandoned | code-level: `upload.abort()` in the catch, so a failed upload doesn't linger as billable orphaned parts (S3 charges for them and there is no lifecycle rule to reap them) |

**Bugs found while doing this**

- **A leaked source stream on a failed write.** `transferFile` abandoned the source stream when
  `putStream` threw, keeping the underlying HTTP response open. Since a failed transfer is
  retried every round, leaked responses accumulate until the connection pool starves — which
  surfaces much later as *unrelated* requests hanging. Now explicitly cancelled on both the
  transfer path and inside the HTTP adapter.
- **A test fixture with a made-up content hash.** `residency-exchange.test.ts` used
  `"d".repeat(64)` as the hash of bytes `[4,5,6]`. Once transfers were verified, the transfer
  correctly failed — and the test looked like a residency bug. Fixture now derives the hash from
  the bytes. Worth noting as a pattern: **fixtures with fake hashes are now load-bearing lies.**

**Gaps**

- **Nothing exercises a real multipart upload.** The per-part checksum path, `Upload`'s
  switch-over at the part-size threshold, and `abort()` are all untested — `storage-s3` has no
  harness that runs a >8 MB body through the SDK. This is the plan's own "matters exactly for
  the largest and least replaceable objects", so it needs an `e2e-aws` test against a real
  bucket, not a mock.
- **A corrupt source retries forever.** A checksum mismatch surfaces as a blob-transfer failure,
  so the watermark holds and the next round tries again. That is the safe direction — neither
  silently accepting nor silently skipping corrupt bytes — but it means a permanently corrupt
  source loops with a warning rather than escalating. Worth an explicit surfaced state when the
  residency inspector lands.
- **`Content-Length` on the streamed PUT depends on `sizeBytes`.** S3 rejects a presigned PUT
  with chunked transfer encoding, so a streamed upload needs an explicit length. Records always
  carry `sizeBytes`, so this holds in practice; when it doesn't, the request goes out chunked
  and will fail against real S3 rather than silently uploading something truncated. Untested
  against real S3 — same `e2e-aws` gap as above.

### Item 3 — `parentId` and negated-label filters; deleting the O(library) scan

The scan this replaces was not merely slow. `/data/records?limit=1000&include=labels` listed
every readable record to learn two bits ("is this a thumbnail", "does it already have one"),
and above the page limit it answered the second one **wrongly**: a record outside the first
1000 read as "no thumbnail yet", so the same thumbnail was derived again on every attempt. A
performance fix that is also a correctness fix.

**Automated**

| Test | Where | Asserts |
|---|---|---|
| `returns records that carry no such label` | `storage-sqlite/__tests__/exclude-label.test.ts` | the basic exclusion |
| `excludes regardless of the label's value` | same | negation is over the key, not a value — see below |
| `returns a record exactly once when it holds many other labels` | same | a `LEFT JOIN … IS NULL` would multiply the row before the null test, so a record with three face labels would come back three times |
| `does not exclude on a tombstoned label` | same | a retracted rendition label means the record is no longer a rendition; treating the dead row as live would hide it from the grid **permanently**, with nothing to un-hide it |
| `is scoped to the naming app` | same | namespaces exist so two apps can use one key name; excluding on the key alone would let one app's vocabulary hide another's records |
| `combines with ordinary column filters` | same | "children of X that are not renditions" |
| `emits a correlated NOT EXISTS` / `ignores tombstoned label rows` / `does not join` | `storage-aurora-dsql/__tests__/query-builder.test.ts` | the same three properties at the SQL level for the cloud dialect — an *uncorrelated* subquery would exclude every record as soon as any record carried the label |
| `pushes parentId into the query rather than filtering after it` | `cloud-data-server/__tests__/routes-db.test.ts` | the constraint reaches SQL, so pages come back full and the cursor is honest |
| `treats parentId=none as a null-parent filter` | same | sentinel rather than an empty value, which would be indistinguishable from a caller that built the query string from an undefined variable |
| `rejects a malformed notLabel rather than ignoring it` | same | silently ignoring it returns renditions mixed into the grid, which **looks like the filter working** on a small library |
| `combines parentId with a label filter` | same | "a thumbnail *of this record*" is one lookup, not a label scan plus a client-side parent check |
| `parentId filtering` group | `storage-sqlite/__tests__/exclude-label.test.ts` | `eq` selects one record's children; `isNull` selects top-level records |

**Design notes worth keeping**

- **`excludeLabel` has no value component, deliberately.** `?label=` distinguishes presence
  from a specific value because a positive query has a reason to. A negated one asking "not
  carrying key K with value V" would silently *include* records carrying K with some other
  value — the opposite of what it reads as.
- **`include=labels` was added to the single-record GET** on both servers. Asking about one
  record is the cheapest possible form of "is this record a rendition"; without it the only way
  to answer was to list the library and look.
- The two resize paths (Next route and cloud Lambda) now share `precheckThumbnail` in
  `photos-lib`, continuing the existing rule that a rule kept in both would eventually be fixed
  in only one.

**Gaps**

- **No test proves the query is actually indexed.** The tests assert the right SQL is emitted
  and the right rows come back; nothing measures that `NOT EXISTS` over `record_labels` uses
  the primary key rather than scanning. On a 300k-row label table that difference is the whole
  point of the item. Needs an `EXPLAIN` assertion or a seeded-volume benchmark.
- **The local data server's filters have no route-level test.** The SQL layer is covered by
  `storage-sqlite`, and the cloud route by `routes-db`, but the local server's own parameter
  parsing (`parentId=none`, malformed `notLabel`) is only covered transitively.
- **`precheckThumbnail` itself is untested.** It is two `fetch` calls and a boolean; the rules
  it composes are tested, the composition is not. A fake `fetchPath` would cover it cheaply.

### Item 3b — variant resolution by target long edge

Split in three, because the three parts fail differently: a pure resolver
(`protocol-primitives/records/variants.ts`), a gatherer over the adapter interface
(`storage-adapter/database/variant-queries.ts`, shared by both servers so it cannot be fixed in
only one), and the parameter contract at each server's edge.

#### The rules (`protocol-primitives/__tests__/variants.test.ts`, 30 tests)

| Rule | Tests |
|---|---|
| 1 — smallest at or above target | rounds **up** not down (500 px must not be served 400 and upscaled); picks the *smallest* qualifying rung, not merely a qualifying one (2560 for a 401 px request is ~40× the pixels — and under I-T a read promotes the object back to Frequent Access for 30 days) |
| 2 — clamp to the largest that exists | lets a client request its full viewport without knowing whether this record has a rung that large |
| 3 — **never the original** | asserted as an *absence*: no candidate set contains a parent, and `never returns something larger than its largest variant` sweeps a range of targets. Exceeding the ladder must be an explicit restore, the same guarantee the storage layer enforces by refusing to thaw on read |

Also: long edge of a **portrait** variant is its height, not its width; unmeasured variants are
excluded rather than guessed at (and an all-unmeasured record resolves to `null`); zero and
negative dimensions are not measurements.

**Determinism is tested, not assumed.** Two variants can legitimately share a long edge (a
class that clamped to its source, or a re-derivation mid-supersession). An unstable choice hands
a different URL to each request, defeating client and edge caching for exactly the records with
the most variants — so ties break on id, and the test resolves the same set in two orders.

**Test candidates are named by their dimensions, never by a class.** A test calling something
`imageMedium` would encode the very assumption this module exists to prevent: that a class name
tells you a size. It does not — classes are per-record maxima.

#### The gathering (`storage-sqlite/__tests__/variant-queries.test.ts`, 12 tests)

Every case here is one where a naive version silently resolves to the *wrong child*:

| Test | Would otherwise serve |
|---|---|
| `ignores children that are not labelled as variants` | someone's **crop** when they asked for a 400 px tile — the bug reading `parent_id` alone always had |
| `ignores a variant whose label has been retracted` | bytes the app has disowned |
| `ignores a soft-deleted variant` | a deleted object |
| `is scoped to the naming app` | another app's `rendition` key |
| `keeps each record's variants to itself` | a different record's image |
| `never resolves to the parent record itself` | the original — rule 3 at the gathering layer |

Plus: a record whose variants have no dimensions is omitted; a partially-measured record
resolves from the measured ones; a whole page resolves in one pass.

#### The edge (`cloud-data-server/__tests__/routes-db.test.ts`, 7 tests)

The contract is **refuse, don't half-answer**. A caller that asked in pixels precisely so it
would not have to reason about classes has no way to notice a silently-empty answer.

- `variant` without `variantLongEdge` (or vice versa) → 400. Either alone is meaningless, and
  answering it returns no variants, which reads as "this record has none".
- Malformed label ref → 400.
- `400px`, `12abc`, `400.5`, `-400`, `0` → 400. `parseInt` would accept the first two, and
  `"400px"` is exactly what string-concatenating a CSS value produces.
- More than `MAX_VARIANT_TARGETS` sizes → 400.
- **Neither parameter present does no variant work at all** — asserted by counting queries, so
  the extra child lookup cannot creep into every existing caller's request.

#### Design notes

- **URLs ride the record list.** Resolution lives on the list endpoint precisely so it costs no
  extra round trip; a grid that presigned every tile separately would have given back the hop
  this design removes. One signature per distinct variant, not per (record, target) pair, since
  progressive presentation frequently resolves several sizes to the same child.
- **A variant the caller may not read arrives without a URL** rather than being omitted — being
  omitted would read as "no variant that size".
- Long URL TTL (6 h) is safe because keys are content-addressed and the cache policy already
  excludes the signature from the cache key.

**Gaps**

- **No test resolves variants end-to-end through a running server.** The three layers are
  covered separately and their seams are typed, but nothing asserts that a real
  `GET /data/records?variant=…&variantLongEdge=…` returns a populated `variants` map with
  working URLs. That needs a fixture with parent+child records and metadata in the
  local-data-server harness.
- **`MAX_CHILDREN_PER_PAGE` truncation is untested.** A record with more children than the cap
  degrades to a truncated candidate set, which could resolve to a smaller variant than exists.
  Far above any real case, but the behaviour is unasserted.
- **Video variants are untested.** The resolver reads `width`/`height`, which the video metadata
  table also has, but no test exercises a video parent — and video classes are not purely a
  long-edge ladder (bitrate is a second axis). Revisit with item 27.
- **Nothing yet consumes this.** Item 9 is the first consumer; until then the grep-level check
  that no size-class literal appears outside the ladder definition (see cross-cutting
  principles) has nothing to check.

### Items 4 + 5 — CloudFront sync downloads; presign header allowlist

#### Item 4 was already built; what was missing was proof

`GET /files/{key}/presign` already routed `shared/*` through the CloudFront signing chokepoint,
and the chokepoint itself was well covered (`cloudfront-signing.test.ts`: grant enforcement,
namespace confinement, path traversal, case-bypass). What no test asserted was that **the route
the sync engine actually uses reaches it** — and if it handed back an S3 presigned URL instead,
the sync path would quietly keep paying origin egress with no edge caching and nothing would
look wrong.

| Test | Asserts |
|---|---|
| `signs shared bytes through CloudFront, not S3` | URL carries the CF domain and `Signature=`, and **not** `X-Amz-Signature` — asserting the absence is what distinguishes the two |
| `leaves app-syncable bytes on S3 presign` | CloudFront never serves `apps/*`; routing them there would need a second origin and grant model for no benefit, since they are not shared data |
| `404s a key with no object behind it` | existence is still checked before signing |

Uploads stay on presigned S3 PUT, unchanged — CloudFront is not the write path.

#### Item 5 landed with its consumer, not as bare plumbing

The header allowlist (`x-amz-storage-class`, `x-amz-tagging`, `x-amz-checksum-sha256`) on its own
would have been a disconnected capability, so it went in together with the **declared retrieval
intent** that uses it.

**The vocabulary says nothing about AWS.** An app declares `instant` or `archive` — what latency
it can tolerate — and has no opinion about tiers. `retrieval-intent.test.ts` asserts the
rejection of `glacier`, `DEEP_ARCHIVE`, `standard`, `cool`: a caller reaching for a provider
concept has escaped the abstraction and is refused rather than accommodated.

| Property | Test |
|---|---|
| Default is `instant` | `defaults to instant when the caller says nothing` — a write that forgot to think about retrieval must not become something that takes 12 hours to read |
| `instant` carries **no tag at all** | `gives an instant write no tag at all` — an untagged object is *structurally* ineligible for the archive lifecycle rule, a stronger guarantee than one depending on a rule reading a value the right way round |
| Both intents land in Intelligent-Tiering | `writes both intents to Intelligent-Tiering, gating the freeze elsewhere` — `archive` is **not** written straight to Deep Archive, because the transition is gated on ladder completeness and a hold period, neither known at write time. Freezing on write would freeze originals whose ladder does not exist yet — exactly when the original is the only readable copy |
| Class and tags are **signed** | `binds the storage class and tags into the signature` — an unsigned header is one the uploader can drop, letting it pick its own tier and tag its way into (or out of) a rule it was never granted |
| A typo is refused | `refuses an unrecognized intent rather than defaulting` — defaulting `"archve"` is silently wrong in both directions: `instant` costs money quietly, `archive` imposes a 48-hour thaw nobody asked for |

**The tag strings are defined once**, in `protocol-primitives`, because they are written by the
presign path and read by the bucket lifecycle rule — different packages. A drift is silent both
ways: objects that never transition (a bill nobody notices), or objects that transition before
their ladder is complete (the only readable copy behind a 48-hour thaw).

**Gaps**

- **`storageClassForIntent` currently ignores its argument.** Both intents map to
  `INTELLIGENT_TIERING` today and the distinction lives entirely in the tag. That is correct for
  now — the freeze is the lifecycle rule's job (item 18) — but the function reads as though it
  branches and does not. It stays a function rather than a constant because item 18 is where the
  branch would appear if the design changed, and a constant would hide that decision point.
- **No lifecycle rule exists yet**, so an `archive`-tagged object is tagged and nothing acts on
  it. Item 18. Until then `archive` is inert, which is the safe direction.
- **Nothing declares `archive` yet.** Photos will map originals to it (item 17); today every
  write is `instant` by default, so the tagging path is exercised only by tests.
- **No test proves S3 accepts the signed headers.** All of this is against mocks — the URL is
  inspected for the header names, not exercised. Signature validation failures here report only
  "SignatureDoesNotMatch", so this belongs in the `e2e-aws` tier alongside the multipart gap.

### Item 5b — availability on every record; 409 on archived reads; explicit restore

The guarantee: **a read never restores implicitly.** Without it a future slideshow feature
would thaw an entire archive one image at a time — each thaw costing money and twelve hours,
with nothing in the call path looking wrong. That is the property the plan means by "safe by
construction rather than by convention", and every test below is either *the caller is told
before trying* or *the caller is refused rather than silently committed*.

#### Availability is maintained, not computed

A `HeadObject` per record on listing is O(library) and would make every grid scroll a storm of
storage requests. So it is a stored fact (`shared_object_availability` / `shared.object_availability`),
read once per page, keyed by **object key rather than record id** — keys are content-addressed,
so two records legitimately share one object and readability is a property of the object. Per-record
rows could disagree about one blob.

| Test | Asserts |
|---|---|
| `reports instant for an object nothing has moved` | absence of a row means the default |
| `assumes instant for an object nothing has reported on` (unit) | the direction is deliberate: being wrong this way costs a recoverable 409 that self-corrects; defaulting to `archived` would be safe in the other direction and useless, since every record would look unreadable until proven otherwise |
| `reports archived, with the tier and the wait, on the listing itself` | unreadability is known **before anything is attempted**, on the listing the client already fetched — not discovered as a stalled image |
| `treats only instant as readable now` (unit) | `restoring`, `archived` and `absent` are all "not now", and `absent` is distinct from `archived` — collapsing them would send a client to a restore endpoint with nothing to restore |

#### Reads refuse

| Test | Asserts |
|---|---|
| `refuses a file-url for archived bytes with 409, and does not restore` | the 409 carries tier and expected latency, **and no availability row is written** — a read must not have side effects, least of all billable ones |
| `409s a read of bytes already being restored rather than queueing another` | `ObjectRestoring` is its own answer |

#### Restoring is a decision, not a discovery

Two-step by design: without `confirm`, the endpoint returns an estimate and does nothing. A
single-step endpoint would make the cost and the wait something a caller learns *after*
committing to them.

| Test | Asserts |
|---|---|
| `returns an estimate and does nothing without confirmation` | estimate present, **zero writes** |
| `issues the restore only on explicit confirmation` | exactly one write |
| `defaults to the fast tier and lets a caller opt into the cheap one` | Standard (12 h) by default — the difference to Bulk is hundredths of a cent and 36 hours, so Bulk earns its wait only in batch |
| `reports an already-readable record without restoring it` | two clients racing on one archived record is ordinary, not an error |
| `does not queue a second restore for bytes already thawing` | idempotent under retry |
| `403s a caller with no read grant on the type` | a **read** grant is enough to ask — requiring write would leave a read-only app able to see a record is archived and unable to act |
| `makes Bulk much cheaper and much slower` (unit) | the trade in one number: 4× the wait to save under $2 on 100 GB |

Rate limiting counts **live `restoring` rows** rather than keeping a ledger, so a restart cannot
forget what is in flight and the window closes on its own as restores complete. Both a count and
a byte volume are capped, because either alone is trivially evaded — a thousand small objects and
one enormous one are different shapes of the same mistake.

#### A harness trap avoided

`fakeDsqlWithGrants` takes availability rows as a **parameter** rather than letting tests
register their own route afterwards. Routes match in registration order and the helper registers
first, so a default there would shadow every per-test override — the exact trap that file already
documents for the label routes. The default availability route is also scoped to the
`select * …` shape specifically: a looser pattern swallowed the rate limit's aggregate and handed
it a row list where it expected a count, which "worked" by accident because the missing column
read as zero.

**Gaps**

- **Nothing maintains availability yet.** No S3 Event Notification handler, no Inventory
  reconcile — that is item 19b. Today the only writer is the restore endpoint itself, so in a
  real deployment every record reads `instant` until item 19b lands. The plumbing, the API shape
  and the refusals are all real; the *input* is not.
- **`RestoreObject` is never actually called.** The endpoint records `restoring` and returns the
  estimate, but does not yet issue the S3 request — item 19 (request → poll → notify → serve).
  So a confirmed restore currently marks state and thaws nothing. **This is the most misleading
  gap in the plan so far**: the endpoint looks complete and is not.
- **`absent` is never written on the cloud.** The local server could compute it cheaply from
  local blob presence; the cloud cannot without an O(library) probe, so it needs the inventory
  reconcile. A `no-cloud` record therefore reads `instant` in the cloud today.
- **The local data server does not report availability at all.** The store exists on SQLite and
  the adapter implements it, but the local `/data/records` response has not been wired. Records
  are always readable locally unless elided, so the omission is currently harmless — and
  currently invisible, which is why it is written down.
- **Restore estimates are unvalidated against a real bill.** The per-GB figures come from the
  plan's cost model, itself listed as an unverified input. Item 35's CUR work settles it.

## Phase 1

### Items 4 / 21 / 29 — core type and metadata column changes

**Item 29 was a live bug, not a missing feature.** `.dng` fell through to `other/other`, which is
Drive-only and **ungrantable to installable apps** — so ProRAW files synced fine and no app could
ever be granted them. Photos simply could not see them.

| Test | Asserts |
|---|---|
| `maps every raw extension to a real image type, not the catch-all` | dng, cr2, cr3, nef, arw, raf, orf, rw2 |
| `makes them grantable to installable apps` | the actual fix — the category is in `APP_GRANTABLE_CATEGORIES`, which `other` is not |
| `registers each maker's format separately` | not one shared `image/raw`: the embedded-preview layout derivation reads differs per vendor, so a single type would leave nothing to branch on. Grants are per category, so `image` still covers all eight |
| `routes them to the image metadata table` | they behave like any other image downstream |

`perceptual_hash` and `thumb_hash` are **metadata, not labels**, because they are deterministic
from the bytes — a label is an app's *assertion*, and anyone re-deriving from the same file
reproduces these exactly. `thumb_hash` is on video too, so a grid mixing stills and clips has no
hole where a placeholder should be. A test asserts `content_hash` stays on the record row:
perceptual hash matches re-encodes and resizes, which is what makes it useful for import dedup and
what makes it **unsafe as an identity** — a candidate-finder, never a decision.

**Gaps** — the columns exist and nothing writes them yet: derivation computes neither hash (see
item 7). The raw *types* are registered, but nothing can decode a raw file — deriving from the
embedded preview is item 30. Recorded explicitly rather than left as an empty section, because a
missing **Gaps** block is ambiguous between "none" and "nobody wrote them".

### Item 6 — the rendition ladder and `photos/rendition`

**No test asserts a class maximum as a literal.** Those integers are the visual test's output
(item 9b) and a test asserting `1280` would have to be edited by the same change that makes it
wrong — exactly when nobody is thinking about whether it *should* be. Every test asserts a
relationship or reads the number from the ladder itself.

| Rule | Tests |
|---|---|
| **Rule 1** — never upscales | `emits min(original, class maximum)` swept over every class and a range of sources; `never emits a file larger than its source`. This is *why* a class name tells you nothing about a file's size, and therefore why resolution must be server-side |
| **Rule 2** — generate when the original exceeds the next lower maximum | `adds a class exactly when the original passes the class below it` — asserts both sides of the boundary, since "no offset, no margin" is the actual specification |
| Bottom rung unconditional | `always generates the bottom rung, however small` — so every record has an instantly-readable copy and the grid needs no fallback |
| **Contiguous prefix** | `produces a contiguous prefix from the bottom, never a gap` — the property the ladder-complete gate and the derivation sweeper both read "top applicable class" off. Neither would be expressible if the set could have holes |
| Own-top-of-ladder floor | `means every generated class is the same size as the original` — freezing such an original saves nothing |

Video adds two clauses, both tested: **bitrate is a second maximum** (either axis dropping is
enough to transcode; neither dropping means don't), and **skim is exempt from the no-op clause**
because it differs from its source in the *time* dimension — a 15-second clip has no smaller
resolution worth making but still benefits from a 2-second scrub. `video-poster-720p`'s maximum is
asserted **equal to `video-720p`'s** rather than to a literal, because it is pinned to it: a poster
sharper than the footage it hands off to degrades visibly at the transition into playback.

`photos/rendition` replaces the bare `thumbnail` flag. It is **single-valued** and written through
the set-valued endpoint, so a respec replaces the rung rather than leaving two with nothing to say
which is current. There is deliberately **no `native` value**: the original is not a rendition, and
giving it a rung would make "every applicable class is present" unsatisfiable and let variant
resolution serve an archived original.

Manifest: raw types added to the image grant (with the rationale that without them the files are
invisible), and a `video/*` grant added — the registry and video metadata columns already existed,
only the grant was missing.

**Gaps**

- **Every number in the ladder is unverified.** This is the plan's largest open item, and it
  gates backfill. The failure mode is quiet and permanent: a quality level slightly too low is
  invisible on a small sample and irreversible across 60k photos once originals are archived.
- **Only one rung is ever produced.** The resize path still generates a single size and labels it
  `image-thumb` via `THUMBNAIL_SIZE_CLASS`. That constant exists to be deleted by item 7 — the
  places referring to it are the list of code that assumed one derived size.
- **`isThumbnail` now reads broader than its name.** It answers "is this any rung", which is what
  its callers (may-this-be-derived-from, should-the-grid-show-it) actually ask. Renaming it would
  touch the grid and both resize paths for no behavioural change, so it was left; `renditionClassOf`
  is what to use when the rung matters.
- **No test asserts consumers never name a size class.** The cross-cutting principle calls for a
  grep-level check, and item 9 is the first consumer that could violate it. Worth adding with
  item 9 rather than before it, when there is something to check.
- **Video ladder helpers are unused.** `applicableVideoClasses` and friends are tested and
  exported but nothing calls them until item 27.

### Item 7 — derivation at ingest (partial; see the correction below)

**The rule obeyed:** derive where the bytes already are, and never transfer an original in order
to derive from it. `deriveStillLadder` takes bytes rather than a record id, so it can only be
called by something that already holds them and there is no code path that could fetch anything.

One decode produces every rung. Decoding a 48 MP ProRAW is the expensive part, and doing it per
rung would multiply it for output that is collectively smaller than the source. `image-medium` is
emitted **first**, because ingest runs AI off it and every routine model input is ≤640 px.

**Automated** — `photos/__tests__/derivation.test.ts` (18 tests). The encoding itself is not
tested: that is sharp, and asserting sharp resizes is asserting sharp. What is tested is
everything deciding *whether work happens*, where failures are silent.

| Test | Guards against |
|---|---|
| `is not complete while any applicable rung is absent` (swept over each rung) | an original archived with nothing readable in its place — the ladder-complete gate's predicate |
| `does not demand rungs that do not apply to a small original` | every small photo permanently ineligible for archiving *and* permanently re-attempted |
| `ignores classes it did not ask for` | a superseded rung awaiting the reaper reading as "incomplete" |
| `cannot decode HEIC or raw` | the fallback silently appearing to cover a phone library, which is mostly HEIC |
| `never retries a format this node cannot decode` | **the sweeper re-downloading and re-failing on every HEIC in the library, daily, forever** |
| `does not back off a record whose bytes simply are not here` | backoff applied where the fix is a transfer, not another attempt |
| `backs off further with each consecutive failure, up to a cap` | an unbounded backoff, which eventually means "never" |
| `resets the count on any non-transient outcome` | a record that failed twice, succeeded, then failed again starting from an hour |
| `retries a previously-complete record` | a stale `complete` blocking re-derivation after a respec or a reaped child |
| `does not take over before the window elapses` | the cloud racing the originating node rather than backstopping it |

Both resize paths (Next route and cloud Lambda) now derive the whole ladder through the shared
`publishRendition`, and the **"already has a thumbnail, stop" early return was removed** — with a
ladder, one existing rung says nothing about the others, and that check would have frozen every
record at whatever it happened to have. Skipping is now per rung, so a retry after partial failure
finishes the job rather than duplicating it.

Dimensions are written per rendition and **not** best-effort: variant resolution orders by long
edge, so a rendition without them is excluded from resolution entirely — storage nobody ever reads.

#### Correction to the plan: sync ordering is not a scheduling change

The plan says renditions-before-originals "is a scheduling change in the sync supervisor, not a
protocol change." **That does not survive contact with the engine.**

Blob pushes are gated on the metadata contiguous-prefix rule: within a node's stream, items ship in
HLC order and a blob failure halts the rest. Renditions are *children*, so the original's record
must exist first and therefore has the earlier HLC — its 40 MB blob is pushed before any 20 KB
rendition. Reordering within a node bucket would break the prefix rule that the coverage watermark
depends on, which is not a scheduling knob but the correctness argument for the whole exchange.

Achieving it properly needs blob transfer decoupled from the metadata prefix rule — a protocol
change. **Not attempted here**, and deliberately not faked with a partial version. The consequence
is that on a slow uplink the library is browsable only after originals upload, not within seconds.
The plan's own mitigation still holds: the archive gate makes the original wait, so nothing is
*incorrect*, only slower than intended.

**Gaps**

- **No cloud sweeper runs.** The decision logic (`fallbackIsDue`, `shouldAttemptDerivation`) and
  the outcome vocabulary exist and are tested; nothing schedules them. That needs a scheduled
  Lambda and is infra work.
- **The attempt ledger has no storage.** The types and transitions are complete and tested, but
  nothing persists a `DerivationAttempt` yet — so today the "never retry HEIC" guarantee is
  available and unused. It needs a node-local table, deliberately not syncable: an attempt is a
  fact about *one node's* capabilities, and syncing it would let a phone's failure tell the laptop
  not to bother.
- **ThumbHash and perceptual hash are not computed.** The columns exist (items 4/21); derivation
  does not populate them.
- **No test derives real image bytes.** Everything above is the decision layer. A fixture-based
  test that runs a real JPEG through `deriveStillLadder` and asserts the rungs' dimensions obey
  Rule 1 would be cheap and is worth adding.
- **Video derivation is not wired.** `applicableVideoClasses` is tested; no transcode path exists
  (item 27).

*(Sections for items 9, 9b, 8 and onward are appended as each lands.)*

---

## Flakes found along the way

Recorded here rather than silently fixed, because each is a real signal about a test's
assumptions.

| Test | Symptom | Assessment |
|---|---|---|
| `local-data-server/__tests__/sync-over-wire.test.ts` → `drains more than one page of records with the small pageLimit` | Failed intermittently under full-monorepo parallel load (`expected 1 to be greater than 1`) | **Fixed.** The cause was real, not merely timing: creating a record nudges a background exchange on a 50 ms debounce, and `transferFile` returns `false` for a key whose transfer is already in flight. So a `/sync/now` round can truthfully report "nothing shipped" while a concurrent background round is mid-transfer — and `converge()`, which stops on one quiet round, reads that as done. The test now drains to the **actual end state** (every record present on B) and asserts the pagination property as an entailment (per-round cap ≤ PAGE_LIMIT, and more than PAGE_LIMIT records arrived) rather than counting rounds. Green 3/3 in isolation and under full parallel load. |

---

## Known holes this plan cannot close

These are listed once here rather than repeated per item.

| Hole | Why it stays open |
|---|---|
| Rendition quality levels | Item 9b is explicitly a human judgement on the operator's own hard cases. SSIM/VMAF can bracket the search; nothing can decide it. |
| On-device derivation throughput | Needs a real handset (item 2 of the plan's open items). Phase 2 answers it; no CI machine's timing generalizes to a mid-range Android. |
| AVIF encode cost on-device | Same. 3–10× JPEG CPU is a claim to measure, not to assert in a test. |
| Dedup tiers 2–3 false-positive rate | Needs a real Takeout export. Ships report-only until calibrated, which is itself the mitigation. |
| Multipart checksum semantics | Must be confirmed against current S3 docs and a real multipart upload, not assumed from the SDK's types. |
| Account-level loss | Named residual risk in the plan; cross-account replication is out of scope. |
