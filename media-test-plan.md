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
| ~~Blocking~~ | ~~`RestoreObject` is never called.~~ **Closed (item 19)** — the endpoint issues it, and a test asserts the SDK call rather than the recorded state. | 5b | — |
| ~~Blocking~~ | ~~Nothing maintains `availability`.~~ **Closed (item 19b)** — notifications *and* the daily Inventory reconcile. | 5b | — |
| **Blocking** | Multipart uploads are unverified above the part threshold in the buffered `put()` path; the streamed path verifies, the convenience method does not. | 1b-i / 2 | An `e2e-aws` test plus routing all large writes through `putStream` |
| **Blocking** | The attempt ledger has no storage, so the never-retry-undecodable guarantee is built, tested, and **inert** — a sweeper would re-fail on every HEIC daily. | 7 | A node-local (non-syncable) table |
| **Deferred** | No cloud derivation sweeper is scheduled. Decision logic exists and is tested. | 7 | Scheduled Lambda |
| ~~Deferred~~ | ~~Nothing produces a video yet.~~ **Closed** by items 26/27. | 28 | — |
| **Deferred** | The video player is not visually verified, and no test drives a real `<video>` element. | 28 | Human review (same class as 9b) |
| ~~Blocking~~ | ~~`unsupported` decided by regex over an error message.~~ **Closed** — typed `UndecodableError` decided at the point of failure; the old fixture was a string no decoder produces, so every real HEIC was retried forever while the test passed. | 7/24 | — |
| **Blocking** | The DNG preview parser has never been run against a real ProRAW or Pixel file, only hand-built TIFFs. The plan explicitly asks for this first. | 30 | Real camera fixtures |
| **Deferred** | Nothing reads Apple's content identifier, so Live Photo pairing only ever reaches `filename` confidence in practice. | 31 | A QuickTime/maker-note reader |
| **Deferred** | CR3 is ISO-BMFF, not TIFF, so preview extraction finds nothing in it and reports it undecodable. | 30 | A CR3 container parser |
| **Accepted** | HEIC decode is macOS-only; a Linux container leaves such records ladder-incomplete and therefore unarchived. | 32 | — (measure via item 15) |
| **Blocking** | No UI is wired to the retention projection, and per-record overrides as rules over labels are unbuilt. Item 34 is half-done. | 34 | The matrix UI |
| **Blocking** | Nothing produces a `SizeClassCensus`, so the projection has no real input. Same query the residency inspector needs. | 34/15 | A grouped local query |
| **Deferred** | `BackfillStore` has only an in-memory test double; the durable version should be the node-local SQLite ledger import already uses. | 8 | Reuse `import-store` |
| **Deferred** | Backfill is **built but never run** — correctly gated on item 9b. | 8 | Item 9b |
| ~~Blocking~~ | ~~Nothing calls `deriveVideoLadder`.~~ **Closed** — `deriveAndPublishVideo` wires probe → facts → derive → publish → gate; the import loop now discovers video and no longer buffers whole files. | 26/27 | — |
| **Deferred** | Skim parameters (8x / 20s / 2fps) are an untested hypothesis; may be better as animated AVIF. | 27 | Measurement against real clips |
| **Deferred** | VP9/WebM transcoding is written but never exercised by a test. | 27 | A fixture asserting the webm path |
| **Accepted** | Derivation output is buffered in memory. Bounded by the ladder (720p @ 1.5 Mbps); revisit if 1080p opt-in ships. | 27 | — |
| **Deferred** | No test proves video is routed to the `shared/*` (S3) behaviour rather than the gateway. Serving it through the chunked gateway origin makes CloudFront return whole objects and silently kills seeking. | 28 | An `e2e-aws` 206-through-CloudFront assertion |
| ~~Deferred~~ | ~~No lifecycle rule exists.~~ **Closed (item 18)** — one tag-filtered rule requiring both tags, above a ~1 MB floor. | 4/5 | — |
| ~~Deferred~~ | ~~Nothing declares `archive` intent.~~ **Closed (item 17)** — Photos declares it for originals; renditions stay `instant`. | 4/5 | — |
| ~~Deferred~~ | ~~`absent` is never written for objects that never existed.~~ **Closed** — the reconcile reports stored keys the inventory does not list. | 5b | — |
| ~~Deferred~~ | ~~The local data server does not report `availability`.~~ **Closed** — reports `absent` for an elided record, which a client otherwise renders as a broken image. | 5b | — |
| **Deferred** | No eviction pass is scheduled; `runEviction` is reachable and uncalled. | 1b | Item 15/34 (residency inspector) |
| **Deferred** | `protectedLocally` is never set, so the durability predicate is the only thing between eviction and a last copy. | 1b | Item 7's derivation-input tracking |
| **Deferred** | `recencyAtMs` is always null from the sync engine, so `recent-only` behaves as `all`. | 1b | Host decider supplying capture time |
| **Deferred** | Only one rung is produced by the resize path in practice until every ingest route uses `deriveStillLadder`. | 6/7 | Item 7 completion |
| ~~Deferred~~ | ~~ThumbHash and perceptual hash are not computed.~~ **Closed** (items 9 and 22) — both computed during derivation. | 4/21 | — |
| **Deferred** | Video derivation is not wired; the ladder helpers are tested and uncalled. | 6 | Item 27 |
| **Deferred** | Renditions do not sync before originals. **The plan's claim that this is a scheduling change is wrong** — it needs blob transfer decoupled from the metadata prefix rule. | 7 | A protocol change, not yet scoped |
| ~~Deferred~~ | ~~No test asserts consumers never name a size class.~~ **Closed (item 9)** — a grep test over `src`/`app`/`infra` with a small reviewed allowlist, verified to fire on an injected violation. | 6 | — |
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

### Item 9 — grid and viewer serve from the ladder, by pixel size

**What changed behaviourally:** the grid used to render *only records carrying the thumbnail
label* — i.e. the renditions themselves — showing a placeholder for everything else. That
inverted what a library is: a photo was unclickable until something was derived from it, and a
fresh import was a grid of grey boxes. The grid now lists **originals** and displays a
**rendition of** each, resolved server-side from a requested pixel size.

#### The guard that matters most

`__tests__/no-size-class-in-consumers.test.ts` — a grep over `src`, `app` and `infra` for any
quoted size-class name, with a deliberately small allowlist (the ladder, derivation, publication,
and the one constant naming the pre-ladder rung).

This is worth more than any single behavioural test here, because the failure it prevents — a
client hard-coding `image-screen` — is **invisible until a respec**. Everything renders, every
test passes, right up until the maxima move and devices that update on their own schedule are
asking for a rung that no longer means what it meant. The ladder's numbers are *expected* to be
respecified, so this is not hypothetical.

**Verified to fire**: injecting `const SNEAKY = "image-screen"` into the grid component makes it
fail. A grep guard that has never seen a violation is worth nothing.

It also asserts the allowlist stays ≤6 entries — not style, but because every entry is a place
that must be revisited on a respec, and the list growing quietly is the thing to notice.

#### End-to-end resolution (closes an item 3b gap)

`apps/local-data-server/__tests__/variant-resolution.test.ts` — six tests through a **running
server**, which is the layer where a wiring mistake (a param never read, a map never attached, a
URL never signed) passes every unit test.

The fixture uses the test app's own label key, `testapp/size-rung` — **not** `photos/rendition`.
A platform that had quietly hard-coded Photos' vocabulary would still pass with the real key; with
a meaningless one it cannot.

| Test | Asserts |
|---|---|
| `returns a resolved variant per requested pixel size, with a URL` | keyed by what was *asked for*; URL rides the listing so a grid needs no per-tile round trip |
| `rounds up to the smallest rendition at or above the target` | 500 px is not served a 400 px image and upscaled |
| `clamps to the largest rendition rather than reaching for the original` | **rule 3, observable from outside** — exceeding the ladder never resolves to the parent, which is what would make a zoom request thaw an archived file |
| `excludes renditions from the listing itself` | otherwise a 60k library is 300k+ records and the client cannot tell how far to page |
| `omits variants for a record that has none` | empty map and no rendition read the same way: show the placeholder |
| `does not attach variants when they were not asked for` | the extra child query does not creep into every existing caller |

#### Client-side behaviour

| Test | Asserts |
|---|---|
| `shows the rendition the server resolved for the tile size` | the original's own bytes are **never** fetched when a rendition exists — the entire economic argument for the ladder |
| `does not fetch a large original's bytes just to fill a 180px tile` | a record mid-derivation shows its placeholder rather than pulling 40 MB for a thumbnail |
| `serves a small original directly when it has no renditions yet` | below the floor the round trip is not worth waiting for |
| `still asks for nothing until the tile is near the viewport` | lazy loading survived the rewrite |

ThumbHash is stage zero: computed during derivation from the bitmap already in hand, stored on the
**parent** record (the grid lists originals, so a hash on a child would be one join from the thing
that needs it), and decoded client-side. It costs **zero requests**, which is the whole reason it
lives on the record rather than in object storage.

**Gaps**

- **The viewer does not yet do progressive presentation.** The grid resolves a tile size and the
  library query also requests a larger size, but the viewer still uses `getFullSizeSrc` rather
  than stepping ThumbHash → tile → viewport. The plumbing is there; the staging is not.
- **Requested sizes are fixed, not measured.** `LIBRARY_VARIANT_TARGETS` is `[540, 2048]` rather
  than the actual viewport, because the list request happens before layout and a per-window size
  would mean a different cache key per window for no visible gain. A viewer that genuinely needs
  a larger size should issue its own request; it does not yet.
- **`DIRECT_SERVE_MAX_BYTES` is a guess.** 512 KB is where serving an original into a tile stops
  being obviously fine. Unmeasured.
- **No test renders a real ThumbHash.** The decode path is exercised only through the "no
  placeholder" branch; nothing asserts a decoded data URL appears.

### Items 17 + 18 — declared intent, the archive gate, and one lifecycle rule

#### The gate is split, and that is the whole design

The **app** asserts its derived ladder is complete, because only it knows what a complete ladder
*is* — the platform must never learn what `image-medium` means, and a platform-side check would
have to. The **platform** independently applies its own floors and refuses to tag if they fail.

**Neither side alone can freeze anything**, and each test removes one side's contribution:

| Test | Removes | Asserts |
|---|---|---|
| `refuses when the app does not assert a complete ladder` | the app's half | no tagging call is made at all |
| `refuses a small object even when the app says the ladder is complete` | the platform's floor | an app that is *wrong* about its ladder still cannot archive a 200 KB file |
| `refuses a record marked starkeep/no-cloud` | — | tagging a record with no cloud bytes would assert something about an object that should not exist |
| `requires write access, not merely read` | — | this changes how an object is stored; a read-only app has no business making it slow for everyone else |
| `does not itself transition anything` | — | tagged ≠ transitioned; the hold period is what buys a week to catch a derivation bug |

#### One lifecycle rule, and the conjunction is the safety argument

An object transitions only when it carries **both** `starkeep:intent=archive` **and**
`starkeep:ladder=complete`. Either alone is wrong: intent-only would freeze originals whose
renditions do not exist — exactly when the original is the only readable form — and ladder-only
would freeze things nobody asked to be slow.

Renditions are **never tagged**, so they are *structurally* ineligible. That is stronger than a
rule that has to read a value the right way round.

| Test | Asserts |
|---|---|
| `creates exactly one lifecycle rule` | one rule, one transition — the plan's "**one** lifecycle rule" |
| `requires BOTH the intent tag and the ladder-complete tag` | the conjunction |
| `transitions only to Deep Archive, above the small-object floor` | ≥1 MB, because Deep Archive's 40 KB per-object overhead and 180-day minimum make a small frozen object **dearer *and* slower** — strictly worse on both axes |
| `never configures Intelligent-Tiering's asynchronous archive tiers` | **asserted as an absence.** I-T's automatic tiers are all millisecond-latency; its async tiers are not, and an object in one exists and cannot be read. Enabling them would silently break `instant` for every rendition, with no code change anywhere to notice. The failure mode is somebody *adding* this resource later to save money |
| `creates no lifecycle rule` (ephemeral) | a rule on a disposable bucket would transition objects teardown then has to thaw |

#### A guard fired that was worth having

Adding `s3:PutLifecycleConfiguration` pushed the foundational permissions boundary **past AWS's
6144-character managed-policy ceiling** (6161). An existing test caught it.

The fix was a deliberate widening, not a formatting trim: the seventeen enumerated bucket-level
`s3:Get*` reads collapsed into one wildcard. What makes it sound is the statement's Resource —
**bucket ARNs only, never `bucket/*`** — so object actions like `s3:GetObject` cannot match
however the wildcard expands, including for actions AWS adds later. Writes stay enumerated,
because the dangerous half of a boundary should be explicit. And this is the *ceiling*: the
install-time temp policy still enumerates exactly what it needs, so nothing any identity actually
holds got wider.

**Gaps**

- **Nothing verifies the tag actually reaches S3.** The gate's tagging call is asserted against a
  mock. Whether S3 accepts the tag set, and whether the lifecycle rule then matches it, is only
  observable against a real bucket — and a mismatch between the rule's filter and the tags written
  is silent in both directions. **This is the highest-value `e2e-aws` test in the plan so far**,
  because the consequence of the rule being subtly wrong is either objects that never archive (a
  bill nobody notices) or objects that archive too early (the only readable copy behind a thaw).
- **`archiveHoldDays` is not configurable end to end.** The program accepts it and defaults to 7;
  no config surface sets it, and the plan calls it a *primary* user-facing setting.
- **The gate is called only from the resize paths.** A record whose ladder completes some other
  way — a backfill, a re-derivation — is never gated. A sweeper should call it; none exists.
- **The two floors are only half implemented.** Object size and cloud exclusion are enforced; the
  "original is functionally the top of its own ladder" floor is defined in `ladder.ts`
  (`isOwnTopOfLadder`) and **not consulted by the gate**, so a 300 px original that satisfies the
  size floor could still be tagged despite archiving saving nothing.

### Items 19 + 19b — the restore actually restores; availability is maintained

Closes both remaining **Blocking** gaps.

#### Item 19 — the endpoint stopped lying

It previously recorded `restoring`, returned a correct estimate, enforced the rate limit, and
**thawed nothing**. That is worse than not having the endpoint: it reports progress on a restore
nobody started, and the object never becomes readable.

| Test | Asserts |
|---|---|
| `actually asks S3 to thaw the object` | the **SDK call**, not the recorded state — asserting the state is what let the gap exist |
| — same test | Standard tier, and a hold of more than a day so a print session does not re-thaw |
| `does not ask S3 to thaw anything when only an estimate was requested` | the estimate step has no side effects |

`restoreObject` returns `"already-in-progress"` rather than throwing when S3 reports one, because
that is the ordinary outcome of two clients asking at once — treating it as a failure would tempt
a caller into a retry that cannot help and costs a request.

#### Item 19b — availability is fed by real events

Without this, `availability` reports whatever a record was written as **forever**: an archived
original still claims to be instantly readable, and the 409 protecting callers from a silent
twelve-hour stall never fires. The field would be decoration.

**The wiring is real, not just the logic** — that distinction is what separates closing this gap
from moving it. `BucketNotification` + `lambda.Permission` are created in the Pulumi program and
asserted:

| Test | Asserts |
|---|---|
| `subscribes the Lambda to the events that change readability` | exactly transition / restore-completed / restore-expired |
| `subscribes to restore expiry, not just restore completion` | the one most easily forgotten — without it an object reads as available **forever** after one restore, fine for a week and wrong for months |
| `does not subscribe to object creation` | a new object is instant, which is already the default for a key with no row; subscribing would write a row per upload to record nothing |
| `grants S3 permission to invoke the function, scoped to the bucket` | S3 cannot invoke without it, and the apply fails with an unhelpful message if the permission is created second |
| `creates no bucket notification` (ephemeral) | — |

The mapping layer (`availability-events.ts`, 14 tests) is pure and provider-shaped-but-not-coupled:

- **Transitions between readable classes record nothing.** One row per object per tiering decision,
  all saying the same thing, is churn rather than information.
- **A removal is `absent`, not `archived`.** Collapsing them would send a caller to a restore
  endpoint with nothing to restore.
- **Intelligent-Tiering's async tiers are handled** even though the installer asserts we never
  enable them — "must never" is doing a lot of work in a sentence about someone else's console,
  and the cost of ignoring them is a read that hangs for twelve hours while availability insists
  everything is fine.
- **Out-of-order delivery is resolved by observation time, not arrival order.** A nightly snapshot
  taken at 03:00 must not overwrite a transition that happened at 04:00 merely by arriving after
  it. A tie keeps what is stored, because at-least-once delivery redelivers the same event.

Events are written as **Starkeep Drive**, the standing cloud-write identity for shared-record
custody — the Lambda's own execution role deliberately has no data-plane access. They are
delivered straight to the same Lambda rather than via SNS/SQS: the handler is idempotent, so
at-least-once needs no deduplication, and a queue would add a component whose only job is holding
events for a consumer that is already warm.

**Gaps**

- **No notification test against real S3.** Whether the event shape matches what
  `handleS3Availability` parses is only observable against a real bucket. The key decoding
  (`+` → space, then percent-decode) is exactly the sort of thing that is wrong in one direction
  for keys containing unusual characters and silent about it.
- **The local data server still does not report availability.** Intended to close alongside this
  and deferred for size; harmless today because local bytes are readable or elided, and therefore
  still invisible.

#### The daily Inventory reconcile — the backstop

Event delivery is at-least-once, and a poison record is deliberately swallowed rather than making
S3 redeliver a batch forever. Both are right, and both mean something can be lost — so without a
backstop a record stays wrong indefinitely, and the wrongness is invisible until somebody reads it.

Inventory rather than a HeadObject sweep: ~$0.0025 per million objects, against 300k requests to
probe a 300k-object library daily. **That cost difference is why availability is a maintained fact
at all**, so the backstop had to preserve it.

**What an inventory can and cannot see** shapes the whole design. It reports storage class and
Intelligent-Tiering access tier; it has **no restore-status field**. So the sweep splits:

- Archived-vs-readable is settled from the report alone, at no per-object cost.
- Restore state is settled by probing — but only for records claiming to be mid-restore whose
  estimated ready time has passed. **That set is bounded by outstanding restores, not library
  size**, which is what keeps a daily check affordable.

| Test | Asserts |
|---|---|
| `marks an object archived when the inventory says so and the store does not` | the backstop's actual job |
| `sees through Intelligent-Tiering to its asynchronous access tier` | storage class alone would call it readable |
| `does not overwrite an event newer than the snapshot` | a 03:00 report read at 05:00 must not revert a 04:00 transition — the snapshot's own time travels with the observations |
| `leaves a live restored copy alone despite an archived storage class` | an inventory cannot see thaws; otherwise every reconcile marks a freshly-restored object unreadable *while the user is looking at it* |
| `flags a restore whose estimated ready time has passed` | the only thing that ever unsticks a lost `ObjectRestore:Completed` |
| `never marks a restoring key as vanished` | inventory silence about a restoring key is not evidence of deletion |
| `reports an archived object that was expected to stay readable` | **reported, never silently corrected** — nothing can un-archive it, and the interesting question is which rule put it there |
| `writes nothing for an unknown key that is readable anyway` | instant is the default; writing it says nothing |

**The ingestion is wired, not just written.** `aws.s3.Inventory` produces a daily CSV; a second
notification subscription triggers on the manifest landing. Keyed on **`manifest.checksum`
specifically**, because S3 writes data files first and the checksum last — anything else would
ingest a partial report. Tests assert the subscription exists and its suffix.

The column order is read from the manifest's `fileSchema` rather than assumed, since assuming it is
how a schema change silently reinterprets `StorageClass` as a size. CSV is parsed with quote
handling rather than `split(",")`, because object keys may contain commas.

#### The local server now reports availability

Locally the answer is nearly always `instant` — bytes on a disk are readable or absent. The case
that matters is **`absent`**, which is what an elided record looks like: metadata present, blob
deliberately declined. A client that cannot tell that from "readable" renders a broken image
instead of an explanation.

One filesystem `stat` per record on a page is microseconds. The reason the cloud cannot do the same
is that its equivalent is a HeadObject per record — O(library) in network requests.

**Gaps**

- **No test ingests a real inventory report.** The reconcile logic has 18 tests; the CSV/gzip/
  manifest path that feeds it has none. Whether the manifest's field names match what is parsed,
  and whether key decoding is right for unusual characters, is only observable against a real
  report. Together with the notification shape, this is now the main `e2e-aws` debt for item 19b.
- **`unexpectedlyArchived` has no caller supplying `expectedInstant`.** The reconcile supports the
  check and the ingestion does not pass a predicate, so the "a rendition must never be archived"
  audit is available and unused — it needs a bounded query for rendition children among archived
  keys.
- **Inventory reports are never reaped.** They accumulate daily under `_starkeep/inventory/`. Small
  (a few MB) and outside `shared/`, so nothing breaks, but a lifecycle rule expiring them after a
  week is the obvious follow-up.

## Phase 5

### Item 28 (byte layer) — ranged reads and range serving

A `<video>` element does not download a file and play it; it **seeks**, by issuing `Range`
requests. The byte layer had no notion of a range at all, which made this the half of item 28 worth
doing before any transcode exists to play.

**What the plan asked to verify rather than assume: the CloudFront cache policy.** Verified against
live AWS docs, and the answer inverts the naive expectation — `Range` must **not** be added to the
cache key. CloudFront handles ranges natively, caching the whole object and slicing from it; adding
`Range` to `headersConfig` would fragment the cache into one entry per distinct byte range, and
since browsers pick arbitrary ranges the hit rate would collapse. The existing
`headerBehavior: "none"` is already correct. **This is recorded because it looks like a bug and is
not** — a future reader "fixing" it would destroy the video cache hit rate.

Two real constraints fell out of the same docs:

- **`Transfer-Encoding: chunked` from the origin makes CloudFront return the entire object instead
  of the range.** So video bytes must be served from the `shared/*` behaviour (S3 origin, real
  `Content-Length`) and never through the gateway origin, which streams chunked. Seeking would
  silently degrade to full downloads — a performance cliff with no error anywhere.
- Range on a compressed object is expressed in *compressed* offsets. Not a live problem (CloudFront
  does not compress video MIME types) but it is why `compress: true` and ranges coexisting is worth
  knowing about rather than assuming.

**Two genuine defects found in the local path**, both in `GET /data/files/:token`:

1. **No `Range` handling whatsoever** — every response was 200 with the whole body. Seeking was
   impossible, and Safari frequently refuses to play at all without a 206.
2. **`localAdapter.get()` read the entire object into memory to serve it.** Unremarkable for a 3 MB
   still; an outright OOM for a 4 GB clip, once per concurrent request. Now `stat()` + `getStream()`
   piped to the response.

`getStream(key, range?)` gained an optional inclusive `ByteRange` across all four adapters. Inclusive
at both ends deliberately: HTTP and S3 are both inclusive, so no layer translates and there is no
boundary to get wrong — and the failure mode of an exclusive type here is silently dropping the last
byte of every file rather than failing loudly.

**Tests.** Nine parser cases and eight end-to-end cases through a running server. The parser cases
are the ones that fail *quietly*:

- **A suffix range (`bytes=-500`) means the LAST 500 bytes, not the first.** Read as a prefix it
  returns real bytes from the wrong end of the file under a status code asserting they are right.
- An oversized suffix is *satisfiable* per RFC 7233 and means the whole file — rejecting it would
  break "give me the last 10 MB" of a 2 MB file.
- Ends that overrun are clamped (browsers routinely ask for a fixed chunk past EOF); starts past the
  end are 416 **with the real length**, not clamped, since clamping would serve the last byte to a
  client that asked for something nonexistent.
- Malformed and multi-range requests fall back to the whole object, which is always a *correct*
  response — it is what a server without range support does.

The e2e cases assert **bytes, not just status**: a 206 carrying the wrong slice is worse than a 200,
because the client trusts it and assembles a corrupt file. The parser passing proves nothing about
the route — a header parsed perfectly and then never consulted passes every parser test.

The fs adapter's ranged reads were **verified by sabotage**: ignoring the `range` argument fails
exactly the three new tests and nothing else, so they prove the range reaches the filesystem rather
than being applied after a full read.

The HTTP adapter treats a **200 response to a ranged request as an error**. A server that ignores
`Range` answers with a success status carrying the wrong bytes; unchecked, the caller writes a whole
object into a slot sized for a chunk and the corruption only surfaces later in the assembled file.

#### The player, and a collision only video exposes

The player is a plain `<video>` with `preload="metadata"`. Below the length where adaptive streaming
earns its keep, a progressive MP4 with moov-at-front seeks correctly over ordinary range requests;
HLS would add a manifest, a segmenter and a JS player to achieve the same thing. `metadata` rather
than `auto` because a viewer should fetch the few kilobytes that make the scrub bar work, not start
pulling the whole file — and under Intelligent-Tiering a read promotes an object back to Frequent
Access for 30 days, so speculative full reads quietly undo the tiering that makes storage cheap.

**Wiring the player surfaced a real hole in variant resolution.** A video's children include a
poster *and* a transcode **at the same long edge** — `video-poster-720p` and `video-720p` are both
1280 — and resolution orders by long edge, breaking ties on id. Asking for 1280 could therefore hand
back either. The client had no way to tell: the variant entry was `{url, width, height}` with no
type. Painting a tile from whatever came back eventually puts an MP4 in an `<img>`; playing it puts
a JPEG in a `<video>`. **Neither fails loudly.**

The server already resolved the variant's `type` and simply was not surfacing it in the response
shape the app consumed. Now `posterSrc` and `playbackSrc` filter on it. Variants with no type are
treated as stills, which keeps a still-only library working against an older server and errs in the
safe direction — assuming video would blank the grid for everyone.

**A second bug in the same area**: variant URLs were minted with `application/octet-stream`. A
browser sniffs its way to displaying an `<img>` regardless, but `<video>` is strict — served as
octet-stream a perfectly good MP4 simply refuses to play, with nothing in the console to explain it.
Variant URLs now carry the variant's own type.

`playbackSrc` returning `null` is a real answer meaning "show the poster, do not offer play". A clip
whose transcode has not been derived is *not ready*, not broken — and falling back to the original
would be worse than useless, since it is the large file the transcode exists to avoid streaming.

#### Gaps

- ~~**Nothing yet produces a video to serve.**~~ **Closed** by items 26/27.
- **The player is not visually verified.** Same class as item 9b: whether seeking feels right, and
  whether the poster-to-first-frame transition is clean, is human judgement.
- **No test drives a real `<video>` element.** The source-selection logic is covered; that a browser
  actually plays what it is handed is not, and cannot be without a browser.
- **`Accept-Ranges` is advertised by the local server only.** CloudFront and S3 emit it themselves,
  so the cloud path is covered, but that is inherited behaviour rather than something asserted here.
- **No test proves video is served from the `shared/*` behaviour rather than the gateway.** The
  chunked-encoding constraint above is documented and honoured by the current routing, but a routing
  change could violate it silently. An `e2e-aws` assertion on a 206 through CloudFront would close it.

### Items 26 + 27 — probing and deriving video

The video ladder rules, the `video/*` grant and the metadata columns all landed earlier (items 6 and
11). What was missing was anything that reads a container or produces bytes.

**ffmpeg is discovered, not depended on.** Bundling `ffmpeg-static` would put an ~80 MB binary in
every install whether or not it ever derives a video, so the binary is found on PATH: where it
exists derivation works, and where it does not the ladder reports the classes it could not produce.
That degradation is deliberately **terminal, not transient** — a missing ffmpeg is the `unsupported`
case the import ledger already models, and retrying it every sweep would burn each run rediscovering
that ffmpeg is still not installed.

#### Three real bugs, all found by tests that nearly did not run

**1. The suite was silently skipping everything.** `hasFfmpeg` was set in `beforeAll` and read when
choosing `it` versus `it.skip` — but that choice is made during *collection*, which happens before
any hook runs. Every ffmpeg test skipped and the file reported green. Now resolved with a top-level
`await`, plus a `STARKEEP_REQUIRE_FFMPEG=1` guard that turns "ffmpeg is missing" into a failure
wherever the coverage is supposed to be real. **A suite that reports green while testing nothing is
worse than one that fails**, and this is exactly how such a suite rots.

**2. Explicit rotation handling was wrong in the obvious direction.** Knowing a portrait phone clip
is encoded landscape plus a display matrix, the instinct is to bake the rotation in with
`transpose`. That is wrong: **ffmpeg's autorotate is on by default and has already applied it**, so
an explicit transpose rotates a second time and turns a correctly-tagged portrait clip into a
landscape rendition of sideways footage. Verified directly rather than reasoned about — a frame from
a 640x480 clip carrying a 90° matrix comes out 480x640 with no filter and 640x480 under
`-noautorotate`. `transposeFilter` is now a *named no-op with a test pinning it*, because "obviously
we must transpose" is a change someone will otherwise make again.

The rotation is still parsed and stored: consumers doing their own decoding need it, and the ladder
compares maxima against the **display** long edge.

**3. `-movflags +faststart` cannot write to a pipe.** ffmpeg refuses with "muxer does not support non
seekable output", because faststart relocates the moov atom by rewriting the file. This would have
broken **every** video rendition in the library. It survived the first test run because the 640x480
fixture hits the no-op clause, so nothing ever asked for a transcode — the transcode path had no
coverage at all. Video output now goes to a temp file. Dropping faststart would have made it
pipeable and defeated the point: **moov-at-front is precisely what makes item 28's ranged serving
worth anything**, since with the index at the end a player must fetch the whole file before the
first frame.

#### What the tests pin

- **Rotation**: `-90` and `270` are the same quarter turn (iPhones write one, other cameras the
  other; compared against a literal `90`, half a library ends up on its side). Quarter turns swap
  the axes, half turns do not.
- **Frame rate**: `30000/1001` is 29.97, not `NaN` — parsed as a float the whole string is `NaN`,
  which then gets written to the database as a real-looking value. `0/0` is ffprobe for "unknown"
  and must become `null`, not `NaN`.
- **Capture time** prefers `com.apple.quicktime.creationdate` over the generic `creation_time`,
  because on a re-muxed clip the latter is the *re-mux* time — which sorts a decade-old holiday
  video into last Tuesday.
- **No bitrate declared means unbounded, not zero.** Zero reads as "already below every ceiling" and
  suppresses every transcode — failing in the direction that silently ships no renditions.
- **Never upscale**: `min(iw,N)`, not a flat target. The other axis is `-2` (even), because an odd
  dimension is a hard H.264 error under yuv420p, not a rounding warning.
- **The poster is not frame zero.** Real footage often opens black — fade-in, exposure ramp — and a
  grid of uniformly black video tiles looks broken in a way that is entirely self-inflicted. A tenth
  in, capped at one second so a long clip's poster still shows what the clip is *of*.
- **Partial success is reported, not discarded.** A failed transcode must not throw away a poster
  that already succeeded, or the grid gets a hole for a thumbnail that was sitting right there.
- **The moov atom is at the front** of produced video — verified load-bearing (without faststart
  only `mdat` appears in the first 256 bytes).

#### Wiring it up (closes the blocking gap)

`deriveAndPublishVideo` is the call site: probe → write facts → derive → publish each rung → assert
the gate. Three things fell out of connecting it that were not visible while the pieces sat apart.

**The import loop could not see video at all.** Its extension set was stills only, so a camera-roll
import walked past every `.mov` silently — half a library missing with no error to explain it.

**The import loop buffered every file whole.** It did `readFile(path)` to hash and hand on the bytes,
which is unremarkable for a 3 MB still and an **OOM for a 4 GB clip** — and video is now importable.
`registerFile` now takes a **path**, not bytes, and the hash is computed by streaming, so no whole
file is ever resident. A test asserts the hash is unchanged by that switch, because a different hash
means every previously imported file looks new and the entire library re-imports.

**Rendition dimensions are measured, not predicted.** Variant resolution orders by long edge, so a
rendition with no dimensions is invisible to it — storage nobody ever reads. Computing them from the
source and the requested maximum is wrong, because the scale filter rounds the free axis to an even
number; a rendition whose dimensions are subtly wrong sorts into the wrong place and is served at the
wrong size, which is worse than missing. The output is already on disk for `faststart`, so measuring
costs one ffprobe against a local file.

Two ordering decisions are pinned by tests:

- **Facts are written before any rendition.** Interrupted after them, the record is a
  correctly-shaped placeholder; interrupted the other way, the layout cannot place it at all.
- **A poster registers as `image`, moving renditions as `video`** — and the metadata `typeId`
  follows. The poster is what the grid paints, and registering it as video hides it from every
  image-granted app. Sending the wrong `typeId` writes into a table the record has no row in.

The archive gate is asked **only when the ladder is actually complete**. Claiming completeness with a
rung missing is how an original gets frozen behind a 48-hour thaw while the thing that would be read
instead does not exist.

#### Gaps

- ~~**Nothing calls `deriveVideoLadder`.**~~ **Closed** — `deriveAndPublishVideo` wires probe →
  facts → derive → publish → gate, and the import loop now discovers video.
- **No HTTP surface starts an import**, so the video path is exercised by tests rather than by the
  app. Same gap the still path has; one route closes both.
- **Skim parameters remain a hypothesis, not a measurement.** 8x minimum, 20s target, 2 fps — the
  plan says so explicitly, and skim may be better as an animated AVIF than as a video. Untested
  against real clips of varying length.
- **VP9/WebM is written but never exercised.** The code path exists behind `codec: "vp9"`; no test
  produces one, so it is unverified.
- **Output is buffered in memory.** Bounded by construction (720p at 1.5 Mbps), so acceptable now,
  but a 1080p opt-in on a long clip would make this worth streaming.
- **No audio-bearing fixture.** The `-c:a aac` path and the skim's `-an` are asserted only against
  silent sources, so "strips audio" is proven while "keeps and re-encodes audio" is not.

## Phase 6

### Items 30 / 31 / 32 — raw preview, Live Photo pairing, HEIC decode

#### The live bug this started from

The import ledger's whole value is that `unsupported` is terminal and `failed` is retried. That
distinction was made by matching the error text against `/unsupported|undecodable/i`. The message
libvips actually produces for an iPhone photo is:

> `heif: Error while loading plugin: Support for this compression format has not been built in`

which contains **neither word**. So the most common capture format in the world was classified as a
transient failure and **retried on every run, forever** — exactly what the ledger exists to prevent.

Worse, the test covering the terminal path used the fixture string `"undecodable-here: no HEIC
decoder"`, which no decoder has ever produced. It was written to match the classifier rather than to
reproduce a failure, so it passed while the real thing looped. **A fixture that cannot fail the way
production fails is not evidence of anything.** The fixture is now libvips' real message, verbatim.

Classification now happens at the point of failure and is carried in the type
(`UndecodableError`). An error message is the *presentation* of a failure, not its classification —
upstream libraries reword them between minor versions, and each rewording silently flips a terminal
outcome into an infinite retry. Anything unrecognised stays **retryable**, because guessing
"terminal" abandons files a retry would have imported, silently and permanently.

#### What sharp actually does with HEIC (verified, not assumed)

```
sharp.format.heif.input     → true
sharp(heic).metadata()      → OK: heif 800x600
sharp(heic).resize().jpeg() → FAILS: "…has not been built in"
```

The format table reports what libvips was **compiled** with. The prebuilt sharp ships libheif with
AVIF but no HEVC decoder, because HEVC carries patent licensing a redistributed binary cannot
assume. **HEIC therefore looks supported at the probe layer and fails at the decode layer**, and
anything gating on "can I read the metadata" concludes it is fine.

Item 32's answer is the plan's: the macOS platform decoder (`sips` → ImageIO), not a custom libvips
build (§12 rejects that). `sips` rather than a native binding — present on every macOS install, no
build step, no native module to recompile per Node version. The asymmetry is deliberate: a Linux
container still cannot decode HEIC, such records stay ladder-incomplete, and **ladder-incomplete
means never archived**. The cost is storage, not a photo nobody can open.

#### Raw: the camera's own preview, not the sensor data

Decoding raw means demosaicing, white balance and a tone curve — colour science whose output would
not match what the camera showed the photographer. Every DNG already carries a JPEG the camera
rendered itself. A DNG is a TIFF, so this walks the IFD chain *and* the SubIFDs and returns the
largest JPEG by pixel area.

**Largest, not first.** Cameras write a 160×120 thumbnail beside the full-resolution render; taking
the first would build an entire ladder from the thumbnail — every rung produced, every one useless,
nothing in the output resembling an error. Following only the IFD chain *or* only the SubIFDs has the
same effect, since the full-size preview usually lives in a SubIFD.

A byte scan for `FFD8…FFD9` would be shorter and is wrong: the marker pair occurs inside raw sensor
data often enough to match, with no way to tell a real preview from a coincidence.

#### Live Photo pairing must happen at ingest

On iOS capture the pairing is free (`PHAsset.mediaSubtypes`); an import gets nothing but two files
named alike. Once they are two records with different ids and arrival times, **the only thing
connecting them is a filename the user is free to change** — so pairing happens during the walk,
while the sibling files are still visible together.

The risk is asymmetric, and the tests lean accordingly. A missed pair costs an untidy grid —
obvious and recoverable. A **wrong** pair demotes a real photo or a real video to a component of
something else, where the user will never look for it. So:

- Apple's shared content identifier wins outright when present. A **mismatch is positive evidence
  against** a pair, so it does not fall through to the filename heuristic — that would override the
  file's own answer with a guess.
- A clip longer than ~6 s is not motion, whatever it is called. Pairing a real video would bury it
  inside a photo's detail view.
- An ambiguous stem (`IMG_1.heic` + `IMG_1.jpg` + `IMG_1.mov`) is left **entirely unpaired**.
- The motion half is registered **after** the whole walk, so it attaches regardless of walk order.
  `IMG_1.heic` sorts before `IMG_1.mov` on most filesystems — precisely the kind of "usually true"
  that breaks on somebody else's disk. A test forces the reverse order.
- A pair whose still failed to import still imports the clip standalone. Losing the pairing costs a
  tidier grid; dropping the file loses somebody's video.

#### Gaps

- **Never verified against real camera files.** The DNG parser is tested against TIFFs built byte by
  byte — the right way to test an IFD walker, and *not* a substitute. The plan says explicitly:
  "verify against real ProRAW and Pixel files first; preview dimensions vary by camera." Still
  outstanding, and the most likely place this is wrong.
- **No content-identifier reader.** `pairingFacts` is a dependency nothing implements, so pairing
  currently reaches only `filename` confidence in practice. The authoritative signal is available in
  the QuickTime metadata and the HEIC maker note; reading it is unwritten work.
- **CR3 is not TIFF.** It is an ISO-BMFF container, so the IFD walker will find nothing in it and the
  file will be reported undecodable. `isRawType` claims it as raw, which is right for grants and
  wrong for preview extraction.
- **Item 32 is macOS-only by design**, so HEIC on a Linux container remains underivable. Accepted,
  not fixed — but the count of records stranded this way is exactly what item 15's residency
  inspector should surface.

## Phase 4

### Items 20 / 22 / 23 / 24 — dedup and local import

#### Item 20 — one object key, one record

Keys are content-addressed, so two registrations of the same bytes name the **same object**. If
both create records, deleting either has to decide whether the bytes may go — a refcount the reaper
cannot compute cheaply and must never get wrong. Collapsing at registration is what unblocks it:
after this, "delete the record, delete the object" is sound.

| Test | Asserts |
|---|---|
| `dedups a byte-identical top-level record, not just a derived child` | idempotent (200 + existing record), **no insert issued** |
| `does not collapse a top-level record into a child with the same bytes` | the lookup is scoped by parent — the same bytes may legitimately be a standalone photo *and* a rendition of something else, and those are different records sharing storage |

**A performance trap was avoided here.** The dedup query now runs on *every* registration, and the
existing `(original_filename, content_hash)` unique index cannot serve it — its leading column is
the filename, so a hash-only lookup would scan the table once per write. New indexes lead with
`content_hash` on both backends. Unconditional is what makes this an invariant rather than a hope,
and it is only affordable because of the index.

#### Item 22 — three tiers, and only one of them acts

**Nothing here deletes anything.** A duplicate is something *not imported*, which leaves the library
as it was — the reversible outcome. Deleting on a match would make a false positive permanent, and a
false positive here is somebody's photo.

| Tier | Acts? | Why |
|---|---|---|
| `identical` (content hash) | **skip** | the same file, definitionally — no threshold to get wrong |
| `same-capture` (timestamp + UID, else make/model + dimensions) | report | **a burst shares all of it** |
| `similar` (perceptual hash) | report | catches re-encodes; also catches things that merely resemble each other |

The adversarial cases are the point of the test file, not an afterthought:

- `only reports, never skips, because a burst looks exactly like this` — ten frames shot in one
  second share a capture second, a camera and dimensions, and every one is a photo somebody chose
  to keep.
- `does not match two screenshots against each other` — screenshots, exports and anything through a
  messaging app have no EXIF, and a *partial* fingerprint would match every one against every other.
  `captureFingerprint` returns `null` rather than something partial.
- `reports maximum distance for malformed input rather than throwing` — one bad stored hash must not
  abort an import scan, and 64 is the safe direction: maximally different never causes a false
  duplicate.

Perceptual hashing is dHash rather than aHash: it compares adjacent pixels, so it survives the
brightness/contrast changes a Storage Saver re-encode or an auto-levels pass introduce. Written
without BigInt because the project targets below ES2020 — a nibble-at-a-time build rather than
moving the whole project's target for one function.

#### Items 23 / 24

`GoogleImportPanel` and its types are deleted — a dead shell against an API Google withdrew in
March 2025.

The import run model is keyed by **content hash, not path**: paths move, and a resumed import must
recognise a file the operator reorganised between runs and must not re-import a merely-renamed one.

`shouldAttempt` distinguishes `failed` (retry) from `unsupported` (terminal), which is what makes a
resume useful rather than merely restartable — conflating them means either abandoning files that
would succeed on a second attempt, or spending every subsequent run re-failing on the same
unreadable hundred, which on a large import is indistinguishable from the tool being broken.
`isComplete` treats a run whose remainder is terminal-but-not-imported as **finished**, so an
operator is not left waiting for progress that will never come.

**Gaps**

#### Closing the loop

The three gaps above — no storage, no driver, and an O(library) tier-1 scan — are closed.

**The ledger is node-local and deliberately not syncable**, under
`$STARKEEP_DIR/app-local/photos/import/`, the same convention Photos' vision state already uses.
Syncing it would push a laptop's progress to a phone that has none of those files, and would let
one device's `unsupported` verdict tell another not to bother with a file it could read perfectly
well. SQLite rather than JSON because the lookup is "have I handled this hash" once per file across
tens of thousands — a JSON ledger is fine at a thousand items and quadratic misery at fifty
thousand, exactly when resumption matters most.

**Tier 1 became the server's job.** The loop registers and reads `deduped` off the answer rather
than scanning the library, so the O(library)-per-file scan is now one indexed lookup per file — and
the authoritative check is the one the library actually enforces rather than a second
implementation that can disagree with it. Tiers 2 and 3 fetch their candidate set **once per run**
rather than once per file: still linear in library size, but paid once.

| Test | Asserts |
|---|---|
| `does not re-register anything already imported` | the point of resumption |
| `recognises a file that moved between runs` | the hash is the identity precisely so an operator who reorganised the folder does not re-import everything |
| `retries a file that failed transiently` | `failed` is not terminal |
| `never retries a file this build cannot decode` | **counts attempts across two runs** — without this, every subsequent run spends itself re-failing on the same unreadable files, which on a large import is indistinguishable from the tool being broken |
| `treats byte-identical files as one item` | two copies in one folder are one object |
| `records a server-side dedup as skipped, not imported` | tier 1's answer comes from the server |
| `imports the file and reports the similarity, rather than skipping` | **tiers 2/3 run after the import, never instead of it** — the finding is a note for a human, not a reason to have withheld somebody's photo |
| `stops at the per-run cap and reports that it did` / `finishes the rest on the next run` | pacing, because an import competes with the derivation it triggers |
| `skips dotfiles and dot-directories` | `.thumbnails` and `.DS_Store` are noise |
| `includes camera raw` | the reason item 29 registered those types |

`computePerceptualHash` is now called during derivation, written alongside ThumbHash in one metadata
request — both are derived deterministically from the same decode, and two writes for one record
would be two round trips for nothing.

**Gaps**

- **No HTTP surface starts an import.** `runImport` takes its dependencies as arguments and nothing
  wires them to a route, so an operator cannot yet start one from the UI. The loop is exercised by
  tests, not by the app.
- **Tiers 2 and 3 are uncalibrated**, which is why they ship report-only. Calibrating needs a real
  Takeout export; until then the thresholds are guesses and are labelled as such.
- **The library index for tiers 2/3 has no loader.** `loadLibraryIndex` is a dependency the tests
  stub; nothing implements it against `/data/records`, so in practice those tiers currently report
  nothing.
- **`unsupported` is decided by matching an error message.** A decode failure is distinguished from
  a transient one by a regex over the thrown text, which is brittle — a reworded error silently
  becomes retry-forever. A typed error from the derivation path would be better.

*(Sections for items 9b, 8 and onward are appended as each lands.)*

---

## Phase 7

### Item 10 — narrowing the raw database

`getRawDatabase()` returned `node:sqlite`'s `DatabaseSync`, and that one concrete type is why a
second driver could not exist: the sync engine, resident set, state store, app-syncable applier and
installer all took it, so every one was nailed to a module React Native does not have.

The interface is **what the callers were measured to use** — `exec`, `prepare`, and on a statement
`run`/`get`/`all`. Nothing else appears anywhere in the codebase. A wider interface would be work a
second driver must implement that no caller needs, and each extra method is one more thing that has
to behave identically across drivers or produce a bug that appears only on a phone.

Synchronous is the one real constraint, and it is deliberate: the change-log write happens inside the
same logical operation as the record write it describes. Making it async opens a window where a
record exists and its change-log entry does not — precisely the state the contiguous-prefix watermark
cannot represent.

**The connection constructor stays concrete.** Opening a database is the one place that cannot be
driver-agnostic, and a blanket rename got this wrong first (it produced `new RawDatabase(path)`,
which the build caught).

The test uses a driver backed by **plain arrays, not SQLite**: something wrapping a real connection
could satisfy the interface by accident through a member the interface does not name, whereas this
can only satisfy it on purpose. If a consumer reaches for `close()` or `open()`, it stops compiling.

### Item 8 — the backfill job (built, not run)

**The item 9b gate is code, not a note.** The ladder's maxima are provisional until the visual test
replaces them, and backfill applies them to the whole library at once — then the archive gate fires
on each complete ladder and starts freezing originals behind a 48-hour thaw on the strength of sizes
that are about to change. Undoing that means paying to thaw everything it froze. `assertLadderMeasured`
refuses, names item 9b, and says what must happen first; a test asserts it reads **zero** originals
while refusing.

Other decisions the tests pin:

- **Never transfer an original to derive from it.** A non-resident original is `unavailable` —
  terminal, not a failure to retry, because the answer cannot change without a thaw somebody pays for
  deliberately.
- **Oldest first.** Archiving begins only on a complete ladder, and the oldest material is both least
  likely to be viewed and the largest share of the library.
- **Attempts are bounded.** A record that failed five times will not succeed on the sixth in the same
  run, and continuing costs the throughput of everything behind it.
- **Complete means "nothing left worth attempting"**, not "everything succeeded" — a library always
  holds undecodable records and unreachable originals, and counting them as unfinished leaves an
  operator watching a progress bar that never fills.

### Item 34 — projecting the retention matrix

The matrix is edited *before* it takes effect, so the projection answers "what happens if I do this"
while the operator is deciding. A UI reporting current usage would answer a different question.

Numbers come from a **census**, not from an average size times a record count: rendition sizes are
per-record maxima, so a library of screenshots and one of ProRAW have wildly different totals for
identical counts.

**Every rounding decision leans toward over-estimating**, because an operator told a row costs more
buys a bigger disk, while one told it costs less runs out of space and evicts what they asked to
keep. An unmeasured cutoff rounds *up* to the next measured point rather than interpolating
(interpolation is a guess presented as a measurement); the opened-recently working set is *added* to
the recency window rather than unioned, since the census cannot say how much they overlap.

**`on-demand-only` was the case worth getting right, and the compiler caught that it was missing.**
Projecting it as zero is badly wrong: on-demand caching converges on the working set and fills the
budget over time, so an operator shown "0 B" would size a disk for a row that grows to 50 GB. It is
estimated from what has actually been opened and flagged `demandDriven`, so the UI presents a floor
rather than a settled figure.

Pins are reported separately, because pins win over budgets — a row can exceed its own cap
legitimately, and an operator needs to know that is pins and not a bug. Classes the policy does not
mention fall to the fallback and **still appear in the table**; quietly omitting them would
under-report exactly the disk use nobody planned for.

#### Gaps

- **No UI is wired to the projection.** The logic is complete and tested; the matrix itself, and the
  per-record overrides as rules over labels, are unbuilt. Item 34 is half-done and this is the half.
- **Nothing produces a `SizeClassCensus`.** It needs a grouped query over records and blob sizes on
  the local node — the same shape the residency inspector (item 15) needs, and worth building once.
- **Backfill has no store implementation.** `BackfillStore` is an interface with an in-memory test
  double; the durable version should be the node-local SQLite ledger the import already uses.

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
