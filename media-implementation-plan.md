# Media storage & transfer — implementation plan

**Status:** not yet implemented. Branch `media-storage-and-video` in `starkeep-core` and `starkeep-apps`.
**Date:** 2026-08-01

This is the build spec. The reasoning behind every decision here — what was considered, what was
rejected, the cost model, and the verification of current behaviour — lives in
[`media-storage-and-transfer-plan.md`](./media-storage-and-transfer-plan.md), referenced below as
"the design doc" with section numbers. **This doc says what to build; that one says why.**

Where they disagree, assume this doc is a bad distillation and the design doc is right — *unless* the
design doc carries a dated **Superseded** or **Refined** note pointing here, which marks a decision
genuinely changed after the split. Two exist so far, both in design-doc §6: consumers request pixel
sizes rather than class names (§7.1 here), and AI has no capture-time exception (§7.2 here).

---

## 1. What we are building

Photos today has one derived size (400 px), generated on demand, replicated in full to every node,
with everything in S3 Standard forever. This replaces that with:

1. A **rendition ladder** — four still sizes plus video-specific classes — derived once, on-device, at
   ingest.
2. **Residency as policy**: a node declares what it keeps per size class; declining a blob is a
   legitimate state rather than a sync failure.
3. **Declared storage intent** per blob, with the resulting availability reported back on the record,
   so no app can thaw the archive by accident.
4. **Originals archived to Deep Archive** once their ladder is verified durable, after a minimum hold.
5. **Video and modern-format support** in Photos, which is the same problem and drops out of the same
   work.

Expected outcome: ~6–9× reduction in cloud storage cost, originals never needed for any interactive
path, and a phone that can hold a 60k-item library in a bounded byte budget.

---

## 2. The rendition ladder

> **Every long edge and quality level below is provisional.** They are reasoned from panel
> resolutions and cost, not measured. The visual test (§7 of this doc, §3.4 of the design doc) is a
> **gate on backfill** — do not backfill the library at unverified quality levels. The *structure* of
> the ladder is settled; the integers are the test's output.

### 2.1 Stills

| Size class | Max long edge | Codec | Typical | Serves |
|---|---|---|---|---|
| *(ThumbHash)* | ~32 px equiv | inline in metadata | ~25 B | instant placeholder, zero requests |
| `image-thumb` | 400 px | AVIF q50 | ~20 KB | grid tiles, list rows |
| `image-medium` | 1280 px | AVIF q55 | ~110 KB | **all routine on-device AI**, fullscreen stage 1, share/export default |
| `image-screen` | 2560 px | AVIF q55 | ~350 KB | phone fullscreen, laptop, AI re-crops of small subjects |
| `image-large` | 4272 px | AVIF q60 | ~950 KB | 4K TV, laptop retina fullscreen, zoom, OCR, print preview |
| `original` | native | as captured | 3–80 MB | print, export, editing, re-derivation |

### 2.2 Video

| Size class | Max spec | Typical (30 s) | Serves |
|---|---|---|---|
| `video-poster-thumb` | 400 px still, frame ~1 s | ~20 KB | grid tile |
| `video-poster-720p` | 1280 px still | ~110 KB | larger-thumbnail UIs, pre-roll / paused state |
| `video-skim` | ~480 px, 2 fps, 8× speed, ≤20 s out | ~80 KB | hover / long-press identification |
| `video-720p` | 720p H.264 ~1.5 Mbps, full framerate | ~5.6 MB | inline playback |
| `video-1080p` *(off by default)* | 1080p H.264 ~4 Mbps | ~15 MB | TV / large-screen playback |
| `original` | as captured | 30 MB–6 GB | export, editing |

`video-poster-720p`'s 1280 px maximum is pinned to `video-720p`'s, not chosen independently — a
poster sharper than the footage it hands off to degrades visibly at the transition into playback.

Live Photos / Motion Photos: the motion clip is a child record of the still, labelled
`image-motion`, with a short playable `image-motion-preview` (design doc §8.4).

### 2.3 Sizing rules — these are maxima, not targets

**Rule 1.** A rendition's long edge is `min(original long edge, class maximum)`. A class never
upscales and never emits a file larger than its source.

**Rule 2.** Generate a class when the original exceeds the **next lower class's** maximum. No offset,
no margin. The bottom rung is always generated.

| Class | Max | Generate when original exceeds |
|---|---|---|
| `image-thumb` | 400 | *(always)* |
| `image-medium` | 1280 | 400 |
| `image-screen` | 2560 | 1280 |
| `image-large` | 4272 | 2560 |
| `video-poster-thumb` | 400 px | *(always)* |
| `video-poster-720p` | 1280 px | 400 px |
| `video-skim` | 480 px, 2 fps, ≤20 s | *(always — see below)* |
| `video-720p` | 1280 px / ~1.5 Mbps | *(always, subject to the no-op clause)* |
| `video-1080p` | 1920 px / ~4 Mbps | 1280 px |

**Video adds two clauses.** Bitrate is a second maximum (`min(source, class max)` on each axis
independently). And **if both resolution and bitrate would be unchanged, do not transcode — use the
original**; a 480p 800 kbps clip is its own `video-720p`. **`video-skim` is exempt** and is generated
for every video, because it differs from its source in the time dimension. Skim speed factor is
`max(8, duration_seconds / 20)`, capping output at ~20 s and ~40 frames.

**Consequences to build against:**

- Every record has an instantly-readable copy at `min(original, 4272)`. No interactive path ever
  needs the original.
- Applicable classes are a contiguous prefix from the bottom, so "top applicable class" fully
  describes the set. The ladder-complete gate and the derivation sweeper both rely on this.
- Every record has an `image-thumb`, so the grid needs no fallback path.
- **No consumer may assume `image-screen` means 2560**, or name a size class at all. Consumers ask
  for a target long edge in pixels and the server resolves which rendition to serve; actual
  `width`/`height` come back with the record. See §7.1 for the rule and the API shape.

---

## 3. Derivation — when and where

**The rule: derive at the first point where the bytes are resident, and never transfer an original in
order to derive from it.** For capture that is the phone; for bulk import it is wherever the import
lands. Zero egress, zero Lambda, zero thaw. A node may only derive from bytes it already holds.

**Sync renditions before originals.** `image-thumb` + `image-medium` are ~130 KB against a 3 MB HEIC,
so the library becomes browsable everywhere within seconds while the original uploads behind it. This
is a scheduling change in the sync supervisor, not a protocol change. (On iOS the ordering may not
hold — background `URLSession` can ship an original before the app has had CPU to derive. Acceptable:
the archive gate makes the original wait.)

**Ownership when derivation doesn't happen — two steps, no coordination protocol, no lease, no
marker:**

1. **The originating node owns derivation indefinitely.** If it cannot right now (battery, thermal,
   offline, no codec, not scheduled), it retries later from a node-local work queue.
2. **The cloud is the fallback, and it is a singleton.** If a record's ladder is still incomplete
   after `derivationFallbackHours` (default 24) and the original is in the cloud, a scheduled sweeper
   hands it to the derivation Lambda. One actor, therefore no contention.

**Derivation state is a query, not a field.** There is no `needs-derivation` flag. A missing class is
the absence of a child record with `photos/rendition=<class>`, which the `parentId` filter makes
cheap — and it is the same query the ladder-complete gate needs.

**The fallback is guaranteed thaw-free** because the archive transition is gated on ladder
completeness: an incomplete original is by construction still instantly readable.

**Two places the fallback cannot reach** (build for these, don't paper over them):

- **`no-cloud` records** have no cloud original, so responsibility never leaves the local nodes. Such a
  record stays ladder-incomplete, is never archived, and is never evictable. A `no-cloud` record with
  an incomplete ladder and one replica is the highest-risk state in the system — surface it in the
  residency inspector.
- **HEIC and raw.** The cloud fallback covers JPEG, PNG, WebP and AVIF only, and the custom libvips
  build that would change that is **rejected for now** (§8). The sweeper must record per-record
  attempt outcomes so it does not retry an undecodable format daily.

**Backfill** is a one-time resumable, rate-limited batch job on the laptop, reading originals from
local object storage (symlinks to watched files — no byte duplication) and pushing renditions as it
goes so archiving can start on the oldest material immediately.

---

## 4. Data model and API changes

**Renditions are shared image records** — child records with `parent_id` set, exactly as thumbnails
are today, not app-specific data. They are the accessible form of the library after originals are
archived, so any image-granted app needs them. Accepted costs: they outlive a Photos uninstall, and
the label namespace stays `photos/`.

Changes required:

1. **`photos/rendition=<class>` replaces the `thumbnail` bare flag.** Single-valued label written
   through `POST /data/labels/values` (upserts and tombstones the rest). Values: `image-thumb`,
   `image-medium`, `image-screen`, `image-large`, `video-poster-thumb`, `video-poster-720p`,
   `video-skim`, `video-720p`, `video-1080p`, `image-motion`, `image-motion-preview`. **No `native`
   value.** `crop` stays as it is — it is a user artifact, not a rendition.
2. **`parentId` filter on `/data/records`**, combinable with `label`/`labelValue`. This deletes the
   O(library) scan the resize handler does today, and makes derivation state a cheap query.
3. **Negated-label filter** (or an `originals-only` flag) so the grid can page originals server-side.
   Without it a 60k-item library is 300k+ records and paging is meaningless.
3b. **Variant resolution by target long edge** — `variant=<labelKey>&variantLongEdge=<px>[,<px>…]` on
   `/data/records`, returning the resolved child per target with its actual dimensions and signed URL
   (§7.1). Expressed generically over child records, a label key and the `width`/`height` columns, so
   the platform never learns what `image-medium` is. **This is what keeps size-class names out of every
   consumer**, which matters because class maxima move at the visual test and again on any respec.
4. **New `IMAGE_METADATA_COLUMNS`**: `perceptual_hash` and `thumb_hash`. Both are deterministic from
   the bytes, so they are per-category metadata, not labels; both are computed during derivation.
5. **`availability` on every record** (§5.2).
6. **New registry types**: `image/dng` plus `cr2`, `cr3`, `nef`, `arw`, `raf`, `orf`, `rw2` as
   `image/*`. Today `.dng` falls to `other/other`, which is ungrantable to installable apps — ProRAW
   is invisible to Photos. This is a live bug.
7. **`video/*` grant in the Photos manifest.** The registry and the video metadata columns already
   exist; only the manifest is missing.

---

## 5. Cloud storage

### 5.1 Declared intent at PUT

Apps declare an intent from a platform vocabulary that says nothing about AWS. The intent decides
three things: storage class, tag, and Object Lock retention.

| Intent | Meaning to the app | Storage class | Tag | Retention |
|---|---|---|---|---|
| `instant` *(default)* | readable now, at normal latency, whenever read | Intelligent-Tiering, automatic tiers only | none | **none, ever** |
| `archive` | may be unavailable for up to 48 h when read | Glacier Deep Archive | `starkeep:intent=archive` | 1 year — **not applied until item 36** (§5.6) |

Photos maps **every rendition class → `instant`**, `original` → `archive`.

- `instant` → presigned PUT carries `x-amz-storage-class: INTELLIGENT_TIERING`. Object lands in I-T
  directly. No tag, no lifecycle rule, nothing to reconcile.
- `archive` → presigned PUT carries `x-amz-tagging` with `starkeep:intent=archive`; **one** lifecycle
  rule transitions objects carrying that tag **and** `starkeep:ladder=complete` to Deep Archive.

**The bucket's I-T configuration must never enable the asynchronous archive tiers.** That is the AWS
default, so the requirement is that we never add an `IntelligentTieringConfiguration` for them —
assert it in the installer. With only the automatic tiers (all millisecond-latency), every rendition
is provably `instant` for its whole life and no rendition can ever require a restore.

**Two floors, both meaning "do not archive it":** originals under ~1 MB (Deep Archive's 40 KB
per-object overhead makes it cost more than leaving it), and originals that are functionally the top
of their own ladder. Stricter wins; a failing original is written `instant`.

Presign path must allow three headers: `x-amz-storage-class`, `x-amz-tagging`,
`x-amz-checksum-sha256`.

### 5.2 Availability — a field on the record

Returned by `/data/records` alongside everything else, by whichever data server was asked, about its
own storage. The same record is `instant` on the laptop and `archived` in the cloud.

| Value | Meaning |
|---|---|
| `instant` | readable now, at normal latency |
| `restoring` | restore in flight; includes estimated ready-at |
| `archived` | requires explicit restore; includes tier and expected latency |
| `absent` | this node does not hold the bytes (an `Elided` record) |

Three rules:

- **Reads of an archived object fail loudly and never restore implicitly.** A presign or GET against
  an `archived` key returns **409** with tier and expected latency. Restores happen only through an
  explicit `POST /data/records/{id}/restore`, which returns estimated cost and time before doing
  anything, and which is rate- and volume-limited per app.
- **It is maintained, not computed on read.** Per-record `HeadObject` on listing is O(library).
  Update from S3 Event Notifications (`LifecycleTransition`, `ObjectRestore:Completed`,
  `ObjectRestore:Delete`), with a **daily S3 Inventory** report as the reconciling backstop (~$0.02/mo
  at the operator's scale). The reconcile also reports objects whose actual class disagrees with
  their declared intent.
- This is what makes the future slideshow feature safe by construction rather than by convention.

### 5.3 The archive gate

**Gate on verified durability, not on age.** When every *applicable* class for a record is confirmed
present in the cloud, tag the original `starkeep:ladder=complete`. Until then it sits in I-T and is
instantly readable — which is what makes the cloud derivation fallback thaw-free.

**Then hold for `archiveHoldDays` (default 7) before transitioning.** This is a primary user-facing
setting, not a safety margin: it buys a week to catch a derivation bug before the input is behind a
48-hour thaw, *and* it is what people who edit recent originals will raise. Under I-T the whole range
from a week to a year spans under $0.50/month at the operator's scale and flattens after 90 days.

Transition cost is fixed and does not depend on how long you waited: $0.05/1,000 objects plus
$0.004/GB checksum computation — ~$5.15 once for the operator's 500 GB.

### 5.4 Restore flow

A real feature, not an error path: request → `RestoreObject` → poll → notify → serve, with the
restored copy held for a configurable window (default 7 days) so a print session does not re-thaw.
Use **Standard** (12 h) for single-item restores, not Bulk — the difference is six hundredths of a
cent and it saves 36 hours. Bulk restores of many objects go through S3 Batch Operations.

### 5.5 Sync bytes through CloudFront

Sync downloads should request **CloudFront signed URLs** for `shared/*` instead of S3 presigned URLs
— same keys, same signing infrastructure, same behavior. Lower per-GB price, a 1 TB/mo free tier,
edge caching that makes a second device's sync of the same object nearly free at origin, one fewer
credential path. **Uploads stay on presigned S3 PUT**; CloudFront is not the write path.

Signed URLs can also be **long-lived and returned inline with the record list**, since keys are
content-addressed and the cache policy already excludes the signature from the cache key. That
removes a ~150–300 ms Lambda hop before first byte.

### 5.6 Object Lock

**Compliance mode plus versioning** (versioning is already on for non-ephemeral installs). Covers the
two most probable failures: an errant lifecycle rule and a credential compromise. Account-level loss
stays uncovered and is a named residual risk.

**This splits into two items that must be sequenced apart, and the split is the whole point:**

| | When | Why |
|---|---|---|
| **The bucket flag** — `objectLockEnabled: true`, no default retention | **Item 0, before any real install** | Can only be set at bucket creation; missing it is unrecoverable without an AWS Support request |
| **Applying compliance retention** to `archive`-intent PUTs | **Item 36, deliberately last** | Undeletable objects during development are a liability, not a protection |

**An Object-Lock-enabled bucket with no retention configured behaves exactly like an ordinary
bucket** — nothing becomes undeletable until a retain-until date is actually written on an object.
So the flag costs nothing to carry through development, and carrying it is what keeps the option
open. **Deferring the flag would forfeit Object Lock permanently for every install made meanwhile;
deferring the retention costs nothing.** Only the second is deferred.

Three constraints, the first two irreversible:

- **Object Lock can only be enabled at bucket creation.** Every install that happens before item 0
  lands can never get it without an AWS Support request.
- **No bucket-level default retention, ever** — not now, not at the end. Retention can be extended
  but never reduced, so any object written under a bucket default is permanently undeletable, which
  would make rendition supersession impossible. Retention is set **per object, on `archive` intent
  only**.
- **Must ride `!ctx.ephemeral`**, exactly like versioning does, or an e2e bucket can never be torn
  down.

Retention period default: **1 year**, not a decade. The threat model is detected in days to weeks,
and compliance retention makes an accidentally-captured original undeletable and billable until it
expires.

**Until item 36 lands, originals carry no retention**, so the errant-lifecycle-rule and
compromised-credential risks are live and unmitigated for the whole build. That is an accepted
development-time exposure, not an oversight.

---

## 6. Local and on-device storage

### 6.1 Residency — the platform unblocker

Today a missing blob is a *failure*: the sync engine holds the watermark back so the record is
re-shipped forever. There is no way to say "I have the metadata and I am intentionally not fetching
the bytes." **This single behaviour blocks both a phone node and any archive tier.**

**Add a fifth residency state, `Elided`:** metadata present, blob deliberately absent, watermark
advances. The mechanism is a decision consulted before the transfer:

```
decideResidency(record, nodePolicy, localOverrides) → "fetch" | "elide"
```

- `"elide"` → apply the metadata row, skip the blob, **advance the watermark**.
- `"fetch"` that then fails → unchanged: hold the watermark, retry.

Inputs resolve in a fixed order, and the order matters because two of them pull opposite ways:

1. **Record constraints** (carried on the record, honoured identically by every node) — **restrictive
   wins**, nothing below may override.
2. **Local pin** — this node's per-record override.
3. **The node's retention rule for this record's size class**, then that class's **budget**.

### 6.2 Retention policy — per size class, no residency classes

**There is no residency-class enum in the data model.** A node's policy is a table with one row per
size class (including `original`):

| Setting | Values |
|---|---|
| **keep** | all / recent-only / on-demand-only / never |
| **recency window** | for *recent-only*: how far back, plus "anything opened in the last N days" |
| **byte budget** | a cap on this row |

`Full`/`Library`/`Browse`-style presets may front this in the UI, but they **write** these settings
rather than being stored.

**Default budgets** — sized as working sets, not libraries:

| Size class | Default | Roughly |
|---|---|---|
| `image-thumb` | 1 GB | 50,000 tiles |
| `image-medium` | 4 GB | 36,000 items |
| `image-screen` | 2 GB | 6,000 items |
| `image-large` | 1 GB | 1,100 items |
| `video-poster-thumb` | 0.2 GB | 10,000 clips |
| `video-poster-720p` | 0.3 GB | 2,700 clips |
| `video-skim` | 0.5 GB | 6,500 clips |
| `video-720p` | 4 GB | 700 clips of 30 s |
| `video-1080p` | 1 GB | 65 clips of 30 s |
| `original` (photo) | 2 GB | 600 HEIC, or 25 ProRAW |
| `original` (video) | 3 GB | one or two 4K clips |
| **Total** | **19 GB** | |

**No row defaults to zero.** A zero budget makes the class unreachable offline and silently disables
the recency rule, so re-opening yesterday's photo re-downloads it.

`original` is split photo/video because one 4K clip is worth hundreds of stills in bytes, and under a
pooled budget one silently starves the other depending on ingest order. Every other class gets the
split for free from its name prefix.

**Independent of all budgets: originals captured *here* are retained until confirmed durable
elsewhere, and until every applicable class has been derived from them.** Capture never blocks.

### 6.3 Eviction

Three distinct mechanisms; only the first is covered by §6.1.

1. **Decline** — never fetch. Fetch-time, `decideResidency` → `"elide"`. Bounds new arrivals only.
2. **Evict** — delete an already-resident blob. Needed when a budget is reduced and what is held no
   longer fits, when a capture node releases a durable and fully-derived original, and under ordinary
   budget pressure as the library grows past a fixed device.
3. **Backpressure** — what happens when eviction cannot free enough.

Nothing enforces any of this today. Eviction needs three things that do not exist:

**A persisted resident-set index with sizes, grouped by size class and media type.** `size_bytes` is
already on `FileRecordRow`, so sizes are free — but residency is currently *derived* via a
`localStorage.has()` probe per record, which is 300k+ probes once renditions exist. **This amends a
stated design decision of the sync engine and should be adopted deliberately.**

**A blob-level durability predicate.** This is the only item in the plan that destroys data if it is
wrong. Today the strongest available statement is "an object exists at that key": the push path sends
no checksum, and `has()` is `HeadObject` → boolean, discarding size, checksum, storage class and
restore state — and returning `true` for a Deep Archive object that cannot currently be read at all.

Fix, made cheap by content-addressing:

- **Send `x-amz-checksum-sha256` on the presigned PUT.** The key already *is* the SHA-256, so S3
  rejects any body that does not match rather than storing it. "S3 returned 200" becomes "S3 confirmed
  these bytes are the bytes this key names", with no extra request and no trust in the uploader.
- **Widen `ObjectStorageAdapter.has()` from a boolean to the object facts `HeadObject` already
  returns** — size, checksum, storage class, restore state. Same call, same cost, and it is what
  `availability` wants too.
- **Multipart needs an explicit decision.** Multipart computes a composite checksum over part
  checksums, not a whole-object SHA-256. Verify per part, or use a full-object algorithm S3 supports
  for multipart — confirm against current S3 docs. This matters exactly for the largest and least
  replaceable objects.
- **The coverage watermark may not stand in for this.** Watermarks are metadata coverage; `Elided`
  makes that gap structural, because a peer advances its watermark *precisely because* it declined the
  blob. Evicting on watermark evidence means deleting a last copy on the word of a node that does not
  have it either.

**A trigger with hysteresis, per size class.** High/low-water marks (evict to 80% on crossing 95%),
evaluated per class so a full `video-720p` budget evicts video and does not touch stills.

**Rules that fall out:**

- **Pins count against their class's budget, and pins win.** Otherwise someone pins 200 GB into a
  zero budget and eviction thrashes forever. Overage is shown per row, not swallowed; the eviction
  pass treats the pinned set as fixed.
- **Capture never blocks.** On overage, shed load in a fixed order: stop fetching other nodes'
  renditions for that class → stop prefetching its recency window → prompt to raise the budget or
  unpin. Originals captured here and not yet durable-or-derived are **never** evictable.
- **Lowering a budget is a destructive action.** Compute what would be evicted, show count and byte
  total, require confirmation. Anything not confirmed durable elsewhere is excluded and reported
  separately ("12,431 originals will be removed; 47 kept because they are not yet confirmed
  elsewhere"), and leaves later when it qualifies.
- **Until the durability predicate exists, a reduction that would evict originals must refuse rather
  than proceed**, and say so.

### 6.4 Per-record overrides — two axes

| | Travels with | Enforced by |
|---|---|---|
| **Cloud exclusion** (`starkeep/no-cloud`) | the record, as a label — every node must honour it identically | `decideResidency`'s restrictive tier, **plus a server-side refusal of blob writes** for `no-cloud` records |
| **Local pin** | nothing — node-local state beside the resident-set index | the eviction pass |

Conflating these is the expensive mistake available here: a pin shared as a label would let one
device's preference silently rewrite every other device's cache policy.

**No new residency state is needed** — `Elided` covers both a `no-cloud` record on the cloud node and
an unpinned over-budget record on a phone.

**Expose the control as rules over labels**, not 63,000 checkboxes. "This album never leaves the
phone" is a rule over a label, and the label machinery exists.

**`no-cloud` moves the single-copy risk to the device.** So "confirmed durable elsewhere" must be able
to mean another *local* node, and the durability predicate must be a **replica count across nodes**
with a configured minimum — plus a visible warning wherever the control is exposed while the count
sits at one.

### 6.5 Streaming transfers

Transfers currently buffer the whole object in memory (`source.get()` → `destination.put()`). A 2 GB
ProRes clip cannot sync. Replace with a streamed transfer plus multipart upload above ~8 MB. Required
for video regardless of everything else.

---

## 7. Serving

### 7.1 UI — consumers ask in pixels, never in class names

**A consumer requests a target long edge in pixels. The server resolves which cached rendition to
serve. No consumer names a size class, and no consumer needs to know the ladder exists.**

This is not a convenience wrapper — it is the only way the rest of the plan holds together. Sizes are
per-record maxima (§2.3), so `image-screen` does not mean 2560 and a client cannot compute which class
it wants. Class maxima move when the visual test lands (§8) and can move again on a respec (§9). Every
client that hard-codes a class name is a client that has to be found and changed on each of those
events, on devices that update on their own schedule.

**Resolution rule, applied server-side per record:**

1. The **smallest rendition whose long edge is ≥ the requested target**.
2. If none qualifies, the **largest rendition that exists**.
3. **Never the original.** Resolution is over renditions only — it does not fall through to the
   archived original, however large the request. Exceeding the ladder is an explicit restore (§5.4),
   never an implicit one, which is the same guarantee §5.2 enforces at the storage layer.

**Mechanism — a generic parameter, not a ladder-aware one.** The platform must not learn what
`image-medium` is. `/data/records` gains a variant-resolution parameter expressed purely in terms of
things it already stores — child records, a label key, and the `width`/`height` columns:

```
GET /data/records?…&variant=photos/rendition&variantLongEdge=400,1280
```

For each record it returns the resolved child per requested target: record id, object key, signed URL,
actual `width`/`height`, and `type`. Several targets may be requested at once, which is what
progressive presentation needs. The response carries actual dimensions, so a client that wants to
reason about what it got can — it just never has to *ask* in those terms.

Two properties this preserves: the resolution rides the record list that was being fetched anyway
(§5.5), so it costs no extra round trip; and any image-granted app gets the same resolution for free
rather than reimplementing the ladder.

**What consumers actually request** — illustrative, not an API contract:

| Consumer | Requests | Typically resolves to |
|---|---|---|
| Grid tile | tile size × device pixel ratio | `image-thumb` |
| Phone fullscreen | viewport long edge, progressively | `image-medium` → `image-screen` |
| Laptop windowed | actual viewport long edge | `image-medium` or `image-screen` |
| Laptop fullscreen / retina, 4K TV | actual viewport long edge | `image-large` |
| Share / export | ~1600 px | `image-medium` — **must not restore an original** |
| Zoom beyond the largest rendition, print, edit | — | explicit restore (async, notified) |

**Progressive presentation:** ThumbHash (inline, zero requests) → tile-sized request on scroll into
view → viewport-sized request on open → a larger request only if the viewport genuinely exceeds what
stage 2 returned. Because rule 2 clamps to the largest rendition that exists, a client can request its
full viewport size without needing to know whether this particular record has a top rung that large —
it simply gets the best available and can compare the returned dimensions against what it asked for.

**Do not speculatively request sizes larger than the viewport needs** — under I-T a read promotes the
object back to Frequent Access for 30 days, quietly undoing the tiering that makes the large classes
cheap. This is now enforceable in one place rather than trusted to every call site.

Open, and settled on the Android app: replace vs. cross-fade between stages; whether AVIF decode on a
mid-range Android is fast enough that early stages are even visible; and whether the third stage is
worth issuing on a phone at all.

### 7.2 On-device AI

**All of it reads renditions, never originals — with no exception at capture time.** The routine path
reads **`image-medium`**, on every device, at every point in a record's life.

| Task | Model input | Reads |
|---|---|---|
| Face detection (SCRFD) | 640×640 letterbox | `image-medium` |
| Face embedding (ArcFace) | 112×112 aligned crop | `image-medium` |
| Small/distant faces | 112×112 | `image-screen` (re-crop when the box is < ~60 px in `image-medium`) |
| Semantic embedding (SigLIP 2) | ~384×384 | `image-medium` |
| Object detection (Objects365) | ~640×640 | `image-medium` |
| OCR (future) | text-resolution | `image-large` |

Every routine input is ≤640 px, so `image-screen` would ship and decode 4× the pixels the model
consumes — ~7 GB vs ~21 GB across a 60k-item catch-up scan, and on a phone the decode half is battery.

**Why there is no capture-time exception.** An earlier draft had AI read the original directly at
capture, on the grounds that it is local, free, and the best available input. That does not survive
inspection and is dropped:

- **No resolution advantage.** Every routine input is ≤640 px and `image-medium` is 1280, so there is
  2× headroom before the original's extra pixels could matter at all. They are discarded either way.
- **No meaningful quality advantage.** Downscaling `image-medium` (AVIF q55, 1280) to 640 low-passes
  away most of what q55 cost in the first place. The difference against original→640 is marginal, and
  no model in the table is sensitive at that margin.
- **It is actively more expensive.** Decoding a 48 MP ProRAW to produce a 640 px letterbox is ~50 MB
  of I/O and a full-resolution decode for ~1 MB of useful pixels. That is the *same* argument that
  rules out `image-screen`, only more so — and on a phone the decode is battery.
- **It splits the library across two input sources**, which is the real problem. Capture-time
  processing would embed from originals while catch-up processing on any other device embeds from
  `image-medium`. Face clustering and similarity search compare those embeddings against each other,
  so a systematic difference in preprocessing between the two halves of the library is a correctness
  hazard, not just an inconsistency. **One input source, always.**

The only genuine advantage the original had was never about its pixels: during ingest the deriver
already holds a decoded full-resolution bitmap, so feeding the model from it would avoid a second
decode. That is a pipeline optimization, and it is not worth buying at the cost of the bullet above.
**If it is ever wanted, the correct form is to run AI from the deriver's in-memory `image-medium`
bitmap before it is encoded** — same pixels as every other device would read, no second decode, and
the single-source property preserved.

Two consequences worth building to:

- **Ingest ordering:** derive `image-medium` first, then run AI from it. Cheap, since derivation
  happens at ingest anyway (§3).
- **AI is fully independent of whether a device ever held the original.** A phone that elided every
  original can do the complete AI pass, and archiving originals never blocks anything.

---

## 8. Visual test — a gate on backfill

Run before item 8 (backfill). Output is a table of final integers replacing the provisional ones in
§2. Deliberately **not** automated: SSIM/VMAF bracket the search, but the decision is what the
operator finds acceptable in a library they will keep for decades.

In order of how expensive it is to get wrong:

1. **Quality level per class.** Find the knee at the size each class is actually viewed at. The right
   quality is not constant across sizes — artifacts hide more easily at 400 px than at 4272.
2. **Whether the long edges are right**, on real devices at real distances. Specifically: is
   `image-medium` upscaled acceptable as phone fullscreen (if yes, the phone skips `image-screen`
   entirely and the mobile byte budget improves ~3×), and is `image-large` enough for zoom.
3. **AVIF vs JPEG/WebP at equal bytes**, including decode time on a mid-range Android.
4. **Video parameters** — `video-skim` frame rate and speed factor, `video-720p` bitrate.
5. **Whether generation-2 renditions are acceptable** — a class derived from `image-screen`/
   `image-large` vs. from the original, and the downscale ratio below which artifact filtering stops.
   **If gen-2 fails, respec machinery fails and every future change means thawing the archive.**
6. **The near-boundary case** — rebuilding `image-medium` at 1280 from an `image-screen` at ~1300,
   the worst downscale ratio the system can produce.
7. **Whether a mixed library is visible** — old and new `image-screen` side by side. Decides whether
   re-derivation can be lazy or must sweep eagerly.

Sample must be the operator's own hard cases, not a stock set: fine text (screenshots, documents,
signs), foliage, night/high-ISO, skin tones, smooth gradients, plus at least one Live Photo and one
4K clip.

---

## 9. Respec — changing a class after the library is built

Not built until there is a real respec to run, but its enabling constraint (no bucket-level default
retention) must land in item 0.

- **Staleness is a query, not a version field**: a rendition is stale when its long edge ≠
  `min(parent's long edge, class max)`, or its `type` ≠ the class's current codec. `parentId` makes
  it one indexed query. Encoder quality is not recoverable from metadata; accept that gap — a
  quality-only respec re-derives that class unconditionally.
- **Re-derive from the smallest applicable class ≥ ~1.5× the new target**, not from the largest. When
  several classes change at once, derive all of them from the highest *unchanged* class in one pass.
- **Two limits:** a record's top applicable class can only be rebuilt from the original; near-boundary
  records are poor sources.
- **Supersession, not coexistence.** On registration, the old child's `photos/rendition` label is
  tombstoned in the same set-valued write. The old record still exists but is no longer a rendition —
  it is an orphan awaiting the reaper. No consumer learns a respec happened.
- **Single owner per pass** (two nodes re-deriving produce two replacements, since AVIF encoders are
  not bit-identical). Cloud is the sensible default. Lazy trigger plus a low-priority sweep.
- **Reaping is the one place this loses data.** Requires: refcount over records (content-addressed
  keys mean two records legitimately share an object), no Object Lock on renditions, a ≥30-day wait
  (I-T's minimum duration), tombstones propagating before bytes are removed, and **never reaping a
  record's current top applicable class**.

---

## 10. Configuration

**Library profile** (one per library): **Cost-first** / **Balanced** *(default)* / **Everything
instant** (originals never leave I-T; ~$1.90/mo more at 500 GB) / **Local-first** (cloud holds
renditions only; `no-cloud` applied to originals by default — requires a NAS or desktop retaining
originals, and the replica-count minimum is what keeps it from being a data-loss feature).

**Device retention** (one per node): the §6.2 table. Each row shows projected disk use next to its
budget; the page shows a total.

**Per-record overrides**: never/always sync to cloud (travels with the record); always keep on this
device / keep if budget allows (node-local). Set on selections, expressed as rules over labels.

**Original hold period**: `archiveHoldDays`, default 7. A primary setting, not Advanced — it is most
likely to be changed for a reason unrelated to cost.

**Advanced**, all defaulted: class maximum long edges and quality levels (post-visual-test), rendition
codec (AVIF / WebP / JPEG — the fallback matters on slow devices, since AVIF encode is 3–10× JPEG's
CPU), video bitrate and HLS duration threshold, archive tier, restored-copy retention window, eviction
water marks, minimum replica count.

**The operator's configuration:** Balanced; phone keeps `image-thumb` for everything, `image-medium`
for 90 days, `image-screen` on demand, nothing else (~8 GB); laptop keeps every rendition class and no
originals; `video-1080p` off.

---

## 11. Work breakdown

### Phase 0a — cannot be done later

**0. `objectLockEnabled: true` on the files bucket**, ephemeral installs excluded, **with no
bucket-level default retention**. Trivial code, two irreversible properties: Object Lock can only be
enabled at bucket creation, and any object written under a bucket default is permanently undeletable.
**Must land before anyone has a bucket worth protecting.**

**This item does not make anything undeletable.** It only preserves the *option* — a bucket with the
flag set and no retention configured behaves identically to one without it. Actually writing
compliance retention on originals is item 36, deferred to the end (§5.6), so nothing during
development is protected against deletion.

### Phase 0 — platform unblockers (`starkeep-core`). Nothing else lands without these.

1. Residency policy + `Elided`; separate *declined* from *failed* in watermark advance. Fetch-time
   decision only.
1b. **Eviction, byte accounting, and the durability predicate** — persisted resident set grouped by
   class and media type, per-class water marks, defined overage order. Larger than item 1, and the
   part the Android app actually exercises.
1b-i. **Make upload success verifiable** — `x-amz-checksum-sha256` on the presigned PUT; widen
   `has()` to return object facts. Prerequisite for eviction *and* for `availability`. Decide the
   multipart checksum story alongside item 2.
1c. **Per-record overrides** — `no-cloud` as a record label in `decideResidency`'s restrictive tier;
   node-local pins; **cloud data server refuses blob writes for `no-cloud` records**.
2. Streaming / multipart blob transfer.
3. `parentId` and negated-label filters on `/data/records`; delete the O(library) scan in the resize
   handler.
3b. **Variant resolution by target long edge** on `/data/records` (§7.1) — generic over child records,
   a label key and `width`/`height`; returns the resolved child per requested target with its actual
   dimensions and signed URL. Gates item 9.
4. Route sync downloads through CloudFront signed URLs.
5. Allow `x-amz-storage-class`, `x-amz-tagging`, `x-amz-checksum-sha256` through the presign path.
5b. **Retrieval intent + availability** — `instant`/`archive` accepted at write and mapped;
   `availability` on every record; archived reads return 409; explicit rate-limited restore endpoint.

### Phase 1 — the ladder (`starkeep-apps/photos`, small core changes)

6. Ladder definition with max-size semantics; `photos/rendition=<class>` replacing the `thumbnail`
   flag; manifest update.
7. On-device derivation at ingest; renditions-before-originals sync ordering.
9. Grid and viewer serve from the ladder **by requesting pixel sizes, never class names** (§7.1, item
   3b); remove the "only labelled thumbnails render" behaviour.
9b. **Run the visual test (§8) and replace the provisional numbers with measured ones.** → gates 8.
8. Backfill job for the existing library. **Blocked on 9b.**

### Phase 2 — the Android app. Depends on Phases 0 and 1.

**Also how Phase 0's residency work gets validated** — it must not be deferred behind the cloud-side
items. The phone peer is the only honest consumer of `Elided`; a real handset carrying a 60k-item
library against an 8 GB budget is the test harness.

**Build to the iOS constraint even on Android** — no persistent background execution, no foreground
service. Four rules: no sync round may be assumed to complete; no work item may assume more than a
few seconds; byte transfer is delegated to an OS-managed mechanism surviving app death; nothing is
scheduled that depends on the app being open.

10. Narrow `getRawDatabase(): DatabaseSync` to an interface so a second driver can exist.
11. Adapters: `DatabaseAdapter` over op-sqlite, `ObjectStorageAdapter` over expo-file-system.
12. RN/Expo dev-client shell; Cognito auth; sync peer running the existing engine.
13. Native modules: `MediaStore` observation, `ImageDecoder` derivation, `MediaCodec` transcode.
14. `WorkManager` job graph on the constrained model — no foreground service.
15. Grid + viewer + **residency inspector** + the per-class retention and budget matrix.
16. Motion Photo XMP extraction (`GCamera:MicroVideoOffset` / `Container:Directory`) — needed at
    *capture* on Android, unlike iOS.

Deferred to later as optimization: foreground services, unrestricted WorkManager, direct filesystem
access, `MediaCodec` batch pipelines. **Do not plan on reusing `photos-ui`** — it is React DOM with
inline CSS strings.

### Phase 3 — storage classes

17. Declared intent at PUT; ladder-complete gate over *applicable* classes only; `archiveHoldDays`.
18. **One** lifecycle rule: tag-filtered Deep Archive above the ~1 MB floor. Renditions need none.
    **Assert in the installer that no async-tier `IntelligentTieringConfiguration` is ever created.**
19. Restore flow — request, poll, notify, serve, retain.
19b. **Availability maintenance** — S3 Event Notifications plus a daily Inventory reconcile.
19d. **Respec machinery** (§9) — staleness query, re-derivation source rule, label supersession,
    refcounted reaper gated behind item 20 and a 30-day minimum age. Not built until there is a real
    respec to run.

### Phase 4 — dedup and local import. Depends on Phase 1.

Deliberately small; Takeout specifics wait until a real export has been inspected.

20. **Record-level dedup** — a content-hash match must not produce two records for one object key.
    Needed regardless of import, and the reaper is blocked on it.
21. `perceptual_hash` and `thumb_hash` columns; both computed during derivation.
22. Three-tier duplicate resolution — SHA-256 → capture fingerprint (`DateTimeOriginal` +
    `ImageUniqueID`, else make/model + native dimensions) → perceptual hash of `image-thumb`. **Skip
    and log, never delete.** **Ships report-only for tiers 2 and 3** until calibrated against a real
    export: bursts, panoramas, screenshots and Storage Saver re-encodes are what decide the
    thresholds, and a false positive silently discards a wanted photo.
23. Delete `GoogleImportPanel` — a dead shell against an API Google withdrew in March 2025.
24. Resumable, per-item, content-hash-keyed local folder import with its own tracking table.
25. *(Deferred until a real Takeout export exists: sidecar parsing, filename de-mangling, pair
    reassembly.)*

### Phase 5 — video

26. `video/*` grant in the Photos manifest; video metadata extraction into the existing columns.
27. Poster + `video-skim` + `video-720p` transcode, on-device first. **H.264 by default** — the only
    codec both platforms hardware-encode (iOS has no VP9/AV1 encoder; Android VP9 encode is patchy).
    VP9/WebM stays a config knob for laptop/cloud derivation. **Skim parameters are a hypothesis —
    measure before fixing them.** Skim is probably better as an animated AVIF/WebP than a video.
28. Player with range requests; **progressive MP4, not HLS**, below a configurable ~2-minute duration
    threshold. Verify range requests through the existing cache policy rather than assuming.

### Phase 6 — formats and moving pictures

29. `image/dng` + camera raw types in the registry (fixes the invisible-ProRAW bug).
30. Derive from the DNG's embedded full-res JPEG preview rather than decoding raw — verify against
    real ProRAW and Pixel files first; preview dimensions vary by camera.
31. Live Photo pairing at ingest (iOS capture gets it free from `PHAsset.mediaSubtypes`; imports do
    not). Pairing must happen at ingest, where sibling files arrive together.
32. **HEIC decode for laptop backfill via the macOS platform decoder** (ImageIO / `sips` / a small
    native binding) — *not* libvips.

### Phase 7 — iOS, configuration, measurement

33. iOS target: PhotoKit + background `URLSession` + `BGProcessingTask` behind the same interfaces.
34. Profile UI — library profile, the retention/budget matrix with projected disk use per row, and
    per-record overrides as rules over labels.
35. Per-prefix cost breakdown off the already-bootstrapped CUR, so the cost model can be checked
    against a real bill rather than trusted.
36. **Per-object compliance retention on `archive` intent only, never renditions, plus its
    confirmation UX** *(was item 19c in Phase 3)*. Deliberately the last thing to land: compliance retention cannot be
    shortened or removed by anyone, so every original written under it is undeletable and billable for
    a year, and a derivation or ingest bug that produces garbage originals during development becomes
    permanent. Turn it on when the pipeline is trusted, not before. **Still no bucket-level default
    retention** — per object, always. (The bucket flag itself is item 0 and is already in place.)

---

## 12. Rejected and out of scope

| | Status |
|---|---|
| **Custom libvips (libheif + libde265)** | **Rejected for now.** Exhaust the alternatives first: reliable on-device derivation, the macOS platform decoder for backfill (item 32), embedded-preview derivation. Reconsider only against a measured count of records left ladder-incomplete for want of a cloud decoder — which item 15's residency inspector produces. **Accepted consequence: the cloud derivation fallback does not cover HEIC or raw.** |
| **Server-side fetch of a remote library** (Drive-hosted Takeout, Dropbox, generic URL) and streaming archive extraction | Deferred. Buys wall-clock only, and now costs more since the libvips build is rejected. Revisit only if home-upstream wall clock is a real problem in practice. |
| **JXL** | Out of scope. sharp reports input and output both `false`; it is not a rendition format; no device in the capture set produces it. |
| **On-demand arbitrary sizes** (`=w1024` style) | Rejected. Requires a resizer in the request path; the fixed ladder is a static CloudFront-cacheable object. |
| **Peer catch-up derivation** | Rejected. It transfers an original specifically in order to derive from it, which is the one rule §3 does not bend. |
| **A `needs-derivation` flag** | Rejected. Derivation state is a query. A shared mutable "somebody fix this" flag invites two nodes to derive and produce two children. |
| **Named residency classes** (`Full`/`Library`/`Browse`) in the data model | Rejected. May be UI presets; nothing stores one and no behaviour is conditioned on one. |
| **A `cool` intent → Glacier IR** | Not a default. Retained as a per-installation override for the very-many-small-items case that item 35 would surface. |
| **A separate `work` rung for AI** | Not needed. `image-medium` covers it. |
| **Cross-account replication / second provider** | Deferred. Account-level loss is a named, unmitigated residual risk. |

---

## 13. Open items that gate work

1. **Every size and quality level is unverified** (§8). The largest open item. The failure mode is
   quiet and permanent — a quality level a little too low is invisible on a small sample and
   irreversible across 60k photos once the originals are in Deep Archive. **Gates backfill.**
2. **On-device derivation throughput is unmeasured.** The whole ladder economics assume a phone can
   derive four classes within opportunistic windows. Phase 2 answers this before anything depends on
   the answer — a further argument for not deferring it.
3. **AVIF encode cost on-device** — 3–10× JPEG CPU. Measure on a real phone before AVIF becomes the
   default rather than a setting.
4. **Dedup thresholds are unvalidated in the false-positive direction.** Calibrate against a real
   Takeout export before tiers 2 and 3 are trusted; ship report-only until then.
5. **`video-skim` parameters are a guess** — 4 fps / 8× / animated container. Test against real clips
   of varying length.
6. **The I-T monitoring fee scales with object count, not bytes** ($0.32/mo at 500 GB, $0.96/mo at
   2 TB). A library of very many very small items is where an explicit Glacier policy could still
   win. Item 35's CUR work settles it; the `cool` override makes acting on it a config change.
7. **Multipart checksum verification** — confirm against current S3 docs rather than assuming. It
   matters exactly for the largest and least replaceable objects.
8. **Unverified prices**: CloudFront and S3 data-transfer-out rates, and the derived byte sizes per
   class, which are estimates and the weakest input in the cost model.
9. **The Google migration path is externally fragile.** Verify the current state of the Picker API,
   Library API scopes, and Takeout-to-Drive before building against them — and prefer designs that
   degrade to "the user hands us a folder", which no vendor can take away.
