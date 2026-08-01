# Changing the ladder after the library is built

**Status: SUPERSEDED — folded into `media-storage-and-transfer-plan.md` as §4.6**, together with the
two amendments it required: §0's append-only premise is now scoped to originals and user-created
records, and §5.6's Object Lock retention now applies to `archive` intent only. This file is retained
as the working derivation; the plan is authoritative.
**Date:** 2026-08-01

The question: after backfill, we decide `image-medium` should be 1440 px rather than 1280 (or
`image-screen` 2880 rather than 2560). What happens to the ~60,000 renditions already written?

The proposal being evaluated: derive the replacements from the largest non-archived rendition rather
than from the original, then tombstone the obsolete ones for eventual deletion, possibly with a
version concept.

**Verdict: the approach works, and needs no new state at all.** Staleness is already recoverable
from existing type-specific metadata, so no version concept is required (§3). One correction to the
source rule (§2), and two collisions with already-settled decisions (§1). The applicability gap this
note originally flagged has since been fixed at source by §3.1.1's max-size semantics.

---

## 1. Two collisions to settle first

**(a) §5.6's Object Lock makes "eventual deletion" impossible for a year — and this is the one item
that cannot be retrofitted.** Compliance-mode retention cannot be shortened or removed by anyone,
including the account root. If renditions are written under a 1-year default retention, a superseded
`image-medium` is undeletable and billable until it expires. §5.6 already named this consequence
("'nothing is ever deleted' stops being a policy and becomes a fact enforced against the user"); it
did not anticipate that renditions would ever *want* deleting.

**Fix: make Object Lock retention the third thing the intent decides, alongside storage class and
tag.** This slots directly into §5.1's existing two-intent structure:

| Intent | Storage class | Tag | Object Lock retention |
|---|---|---|---|
| `instant` | `INTELLIGENT_TIERING` | none | **none** |
| `archive` | (lifecycle to Deep Archive) | `starkeep:intent=archive` | 1 year |

Set no bucket-level default retention; apply retention explicitly on `archive` PUTs only. The
asymmetry is justified by the threat model rather than by convenience: §5.6 protects against an
errant lifecycle rule and a credential compromise. Losing every original to either is permanent;
losing every rendition is a 48-hour thaw and a re-derivation pass — expensive and annoying, not data
loss. Locking the irreplaceable data and not the reproducible data is the correct shape.

**This has the same hard-deadline property as §10 item 0.** Retention is set at write time and
cannot be reduced afterwards, so every rendition written before this lands is permanently
undeletable. It belongs in Phase 0a next to the bucket flag, not in Phase 3 with the rest of the
storage-class work.

**(b) §0's "Append-only. Nothing is ever deleted" needs a scoped amendment,** not a reversal:
*originals and user-created records are append-only; renditions are reproducible cache and may be
superseded and reaped.* Nothing else in the plan depends on renditions being permanent — the Glacier
minimum-duration argument is about originals, and the cost model does not assume it.

One consequence to price in: **Intelligent-Tiering carries a 30-day minimum storage duration**
(`EarlyDelete-INT`, prorated at the Frequent Access rate — verified against the Price List API).
Reaping a superseded rendition inside 30 days of writing it pays the remainder at $0.023/GB-mo. The
reaper should therefore wait at least 30 days, which is comfortably shorter than the delay you would
want for safety reasons anyway.

---

## 2. The source rule — a correction and a hard limit

### The correction: not the largest rendition, the smallest one comfortably above the target

Deriving from `image-large` (3840) always works but is not the cheapest correct choice. To rebuild
`image-medium` at 1440:

| Source | Downscale | Bytes read per record |
|---|---|---|
| `image-large` 3840 | 2.7× | ~800 KB |
| `image-screen` 2560 | 1.8× | ~350 KB |

Both are one generation deep from the original, and both downscale by enough that the source's
encode artifacts are low-pass filtered away. `image-screen` reads 2.3× fewer bytes and — under
Intelligent-Tiering — promotes 2.3× fewer bytes back to Frequent Access for 30 days, which is the
actual cost of this operation (§4 below).

**Rule: derive from the smallest applicable class whose long edge is at least ~1.5× the target.**
Below 1.5× the downscale stops hiding the source's artifacts and generational loss becomes visible;
that threshold is a §3.4 question, not a known quantity.

**When several classes change at once, derive all of them from the highest *unchanged* class, in one
pass.** Rebuilding `image-medium` from a freshly-rebuilt `image-screen` would make it generation 3.
If `image-screen` and `image-medium` both move, both come from `image-large`.

### The top-class limit, now largely dissolved by §3.1.1

An earlier version of this note documented a serious gap: under the old fixed-target ladder,
`image-large` required an original ≥4,416 px, so a 12 MP capture (4,032 px) got none, was archived
anyway, and left 2,560 px as its best instant copy — meaning zoom, OCR and any re-derivation of
`image-screen` needed a 48-hour thaw.

**§3.1.1's max-size semantics remove that**, and they do it as a general rule rather than a special
case for the top rung. Every record now gets an `image-large` at `min(original, 4272)` whenever the
original exceeds 2,560, so:

> **Every record has an instantly-readable copy at its native resolution, or 4,272 px, whichever is
> smaller.** That copy is the re-derivation source for every class beneath it.

Which means re-derivation is possible for every class below the top, for every record, without ever
touching the archive. The residual limit is narrower than it was and cannot be removed:

- **The top applicable class still cannot be rebuilt from anything but the original.** For a record
  above 4,272 px that means `image-large` itself; for a 2,000 px original it means `image-screen` at
  2,000. Changing a class *maximum* only affects records whose original exceeds it, so raising
  `image-large` from 4272 later would need a thaw for exactly the >4,272 px population and nothing
  else.
- **The near-boundary case from §3.1.1 is the weak spot.** A 1,300 px original has `image-medium` at
  1,280 and `image-screen` at 1,300. Rebuilding the former from the latter is a 1.02× downscale — a
  re-encode with no artifact filtering, i.e. the worst generation-2 case in the system. It affects
  only originals sitting just above a class maximum, which real device sizes mostly avoid, but it is
  the case §3.4 should look at.

Both are narrow enough that the practical answer is the one the operator proposed: **re-derive from
the largest instantly-available rendition, and accept that the top class is a one-shot decision.**

---

## 3. No version concept — the spec is already recoverable from metadata

The operator's objection is correct and goes further than it first looks: **codec and quality are
type-specific metadata of exactly the same kind as `width`/`height`, so a version marker is
redundant state.** Checked against the registry as it stands
(`packages/protocol-primitives/src/types/core-types.ts`):

| Spec component | Where it already lives | Byte-derived? |
|---|---|---|
| long edge | `width` / `height` in `IMAGE_METADATA_COLUMNS` and `VIDEO_METADATA_COLUMNS` | yes |
| codec | the record's own `type` — `image/avif` vs `image/webp` vs `image/jpeg` are distinct registry entries | yes |
| video bitrate | `bitrate` in `VIDEO_METADATA_COLUMNS` | yes |
| video frame rate | `frame_rate` in `VIDEO_METADATA_COLUMNS` | yes |
| **still quality level** | **nowhere** | **no** |

**For video the argument is airtight.** `video-720p` is specified as "720p H.264 ~1.5 Mbps, full
framerate", and `width`, `height`, `video_codec`, `bitrate` and `frame_rate` are *all* existing
columns. Every component of the spec is already recorded, already byte-derived, and already
queryable. There is nothing a version label would add. The same holds for `video-skim` once its
parameters are fixed (§3.3) — frame rate and dimensions are columns; the speed factor is recoverable
from `duration_ms` against the parent's.

**For stills, three of four components are free and one is not.** Long edge and codec cover the two
changes actually worth re-deriving a library for. The gap is the encoder quality parameter, and it
is a real gap rather than an oversight: AVIF and WebP do not record the encoder's `quality` setting
in any standard readable field, and unlike video there is no bitrate analogue that works — bytes per
pixel at a fixed quality varies by an order of magnitude between a flat sky and foliage, so it
cannot be thresholded back into a quality level.

**Conclusion: drop the version label; use dimensions and type; accept that a quality-only change is
undetectable, because it is also not worth detecting.** A quality-only respec is the least likely
and least valuable of the three — a few percent of visual quality and ~15% of bytes — and if it ever
is wanted, the escape hatch needs no query at all: re-derive every rendition of that class
unconditionally, which is what a full pass would do anyway. Paying permanent per-rendition state to
optimise a sweep nobody is likely to run is the wrong trade, and it is the same instinct §4.2
already rejected when it deleted the `needs-derivation` flag: **derivation state is a query, not a
field.** A version label would have reintroduced exactly that field under a new name.

**The staleness predicate, then, is a join rather than a lookup**, because §3.1.1's max-size
semantics make every class's output size per-record:

> a rendition is stale when its own long edge ≠ `min(parent's long edge, class max)`, or its
> `type` ≠ the class's current codec

The parent's dimensions come from the same `IMAGE_METADATA_COLUMNS` on the parent record, and §4.4's
`parentId` filter is what makes the join a single indexed query. Zero new columns, zero new labels.

**Read-path behaviour is unchanged and is the part that matters.** Whatever finds stale renditions,
consumers must never see two `image-medium` children of one record. When the replacement is
registered, the old child's `photos/rendition` label is tombstoned in the same set-valued write §4.4
already specifies (`POST /data/labels/values` upserts and tombstones the rest). The old record still
exists and its bytes are still there, but it is no longer labelled a rendition — it is an orphaned
image record awaiting the reaper. "The `image-medium` of record X" stays one indexed query on
`parentId` + `labelValue`, and no consumer learns that a respec ever happened.

## 4. What it costs, and what the real argument is

Rebuilding one class across the library, at Model B (60k stills):

| | Re-derive from renditions | Restore originals from Deep Archive |
|---|---|---|
| Bytes read | 21 GB (`image-screen`) | 500 GB |
| Direct charge | ~$0.40 (I-T promotion to FA for 30 days) | $1.25 bulk retrieval + ~$2.45 staging |
| Wall clock | minutes to hours | **48 hours before the first byte** |
| Decoder needed | AVIF — works in stock sharp today | HEIC/DNG — **blocked on §8.1's custom libvips** |

At Model C the gap widens sharply, because re-derivation scales with rendition bytes (136 GB of
`image-large`) while a thaw scales with original bytes (2 TB): roughly $2.60 against ~$15.

**But the money is not the point at Model B, and overstating it would be dishonest** — $0.40 against
$3.70 is not what justifies building this. Three other things do:

1. **No 48-hour wait, and no restore window to manage.** A restore creates a temporary copy that
   expires; a multi-hour re-derivation job that outlives its restore window is a genuinely unpleasant
   failure mode, and it does not exist on the rendition path.
2. **The codec problem disappears.** The cloud cannot decode HEIC or DNG until §8.1's custom libvips
   build lands (§4.2 is explicit that this makes the cloud a poor fallback for *initial* derivation).
   Renditions are AVIF, which stock sharp handles — so **re-derivation in the cloud works today, on
   the operator's primary capture format, with no new build.** That is a strictly better position
   than initial derivation is in.
3. **It never touches the archive**, so it cannot interact with the 180-day Deep Archive minimum, with
   Object Lock, or with §5.1.1's restore rate limits.

**Who runs it — the one part that cannot be fully postponed, and it is not the choice of node.**
Whether a respec pass runs locally, in the cloud, or on both is genuinely a later decision, and
nothing in this design depends on it. Two primitives do have to be settled, and both are cheap:

- **A node may only derive from bytes it holds** (§4.1, unchanged). So the source rule is "the
  smallest applicable class ≥1.5× the target *that this node holds*", and a node with no local
  source simply skips the record. That is the same shape as §7.1's `Elided` — declining is a
  legitimate state, not a failure — so residency policy (§7.2) decides which nodes can participate
  without anything else needing to know.
- **A respec pass must have a single owner.** This is §4.2's reasoning applied unchanged: two nodes
  that both re-derive the same record produce *two* replacement records, because AVIF encoders are
  not bit-identical across platforms and the outputs are therefore different content-addressed keys.
  §4.2 solved this with "one actor, therefore no lease and no coordination protocol", and the same
  answer works here.

**Which** node owns it is then configuration rather than design. The cloud is the sensible default —
it holds every rendition, all instantly readable under I-T, with no residency gaps — and §4.2's
singleton sweeper already exists to schedule this shape of work. A local-first install (§9) can
point it at the laptop instead, and the only thing that changes is which records get skipped for
want of a local source.

**Eager or lazy.** Lazy-with-a-backstop: re-derive on next access, plus a low-priority background
sweeper driven by the same staleness query. Both read the same index, so this is one mechanism with
two triggers rather than two systems. A mixed library in the interim is acceptable for `image-thumb`
and `image-medium` and should be checked by eye for `image-screen`.

---

## 5. Deletion mechanics — the one place this can lose data

**Reaping must be refcounted over records, not per-record.** Keys are content-addressed, so two
records can legitimately reference one object — identical screenshots produce byte-identical
`image-thumb` renditions and therefore one shared key. Deleting the object on behalf of one
superseded record would silently break the other. This is the same gap §10 item 20 already records
("record-level dedup — content-hash match must not produce two records for one object key"), and the
reaper must not ship before it.

**Tombstones must propagate before bytes are removed.** §7.1's `Tombstoned` residency state already
exists, so the mechanism is there; the ordering requirement is that a node deletes local bytes on
seeing the tombstone, and the cloud does not remove the object until the tombstone has been
published. Content-addressing makes the failure mode benign either way — a node that deletes early
simply re-fetches.

**Never reap a rendition that is currently some record's top applicable class**, since it cannot be
rebuilt without a thaw. This is rule 3 of §3.1.1 restated for the deletion path.

---

## 6. What to build now

§3.4 has not been run, so the *first* setting of these numbers still happens before backfill
(§10 item 9b gates item 8). This machinery is for a *second* change, which is speculative. Per
`CLAUDE.md`, that argues for designing it and not building it.

Three things are worth doing now anyway, because they are cheap now and expensive or impossible
later:

1. **Object Lock retention on `archive` intent only** (§1a). Hard deadline — retention cannot be
   reduced after the fact, so every rendition written under a bucket default is permanently
   undeletable. **Phase 0a, alongside item 0.**
2. **§3.1.1's max-size semantics** must land with the ladder definition (item 6), before backfill
   writes 60,000 renditions under fixed-target rules. This is already folded into the plan; it is
   listed here because it is what makes everything else in this note work — without a
   native-resolution top class per record there is no re-derivation source and the whole approach
   falls back to thawing.
3. **Add three cases to §3.4's visual test**, since the sample is being encoded anyway: *(a)* a class
   derived from the original versus the same class derived from `image-screen`/`image-large`, to
   establish whether generation-2 renditions are acceptable and where the safe downscale ratio sits —
   if they are not, this entire approach fails and it is much better to know before backfill;
   *(b)* the low-ratio case specifically — rebuilding `image-screen` from a ~3,000 px master, which
   §2 flags as the weakest point of the master-rung scheme; *(c)* the mixed-library question, i.e.
   whether an old and a new `image-screen` are distinguishable side by side, which decides whether
   lazy re-derivation is acceptable.

Everything else — the sweeper, the reaper, the refcount — waits until there is a real respec to run.
