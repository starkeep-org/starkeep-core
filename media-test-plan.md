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

*(Sections for items 3, 3b, 4, 5, 5b and onward are appended as each lands.)*

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
