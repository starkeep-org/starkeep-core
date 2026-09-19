# Should renditions move to Glacier IR after 1–2 weeks?

**Status:** working analysis. **§5's recommendation has been adopted into
`media-storage-and-transfer-plan.md`** — see its §5.1 (two-intent vocabulary), §5.3.2 (the decision),
and §5.4 (re-run cost model). This file is retained as the derivation and the price provenance; the
plan is authoritative.
**Date:** 2026-08-01
**Prices:** re-pulled from the AWS Price List API, us-east-1, on this date.

The question: why not transition every size class except `video-720p`, `video-poster-thumb` and `video-skim` to
Glacier IR after one or two weeks, leaving originals in Deep Archive?

Short answer: the *instinct* is right and the plan under-uses cheaper tiers, but the selection rule
should be **object size × read rate**, not age. §1–§4 work that out for Glacier IR. **§5 then
supersedes the conclusion**: Intelligent-Tiering with the async archive tiers disabled applies the
same boundary automatically, costs $0.31/mo more at Model B in the best case for GIR and less in any
realistic one, and removes the per-class decision entirely. **That is the recommendation.**

Read §1–§4 for why the small classes must not go to Glacier under any scheme — that reasoning
survives and is what makes §5 work.

---

## 1. Two mechanics decide it

Neither is in the plan today. Both come from the Price List API.

**(a) GIR bills a 128 KB minimum per object.** Already noted in §5.3.1, but its consequence for the
ladder is not: `image-thumb` (20 KB) and `image-medium` (110 KB) are *both below the floor*. A 20 KB thumb is
billed as 128 KB — 6.4× inflation — which more than cancels the 5.75× storage discount.

**(b) GIR GET requests cost $0.01/1,000 — 25× Standard's $0.0004/1,000.** (`Requests-GIR-Tier2`
$0.00001/req vs `Requests-Tier2` $0.0000004/req.) This is the term that matters for classes with
many small objects read in bulk, and it is invisible in a per-GB comparison.

Supporting figures, all verified:

| Item | Price |
|---|---|
| GIR storage | $0.004/GB-mo (`TimedStorage-GIR-ByteHrs`) |
| GIR retrieval | $0.03/GB (`Retrieval-GIR`) |
| GIR GET | $0.01/1,000 (`Requests-GIR-Tier2`) |
| GIR transition | $0.02/1,000 (`Requests-Tier4` / `S3-GIRTransition`) |
| **GIR checksum fee** | **$0.004/GB** (`Compute-Checksum-Processed-GIR-Bytes`) — see §5 |
| GIR early-delete | prorated (`EarlyDelete-GIR`) — 90-day minimum duration |
| Standard storage / GET | $0.023/GB-mo / $0.0004 per 1,000 |
| Standard-IA storage / retrieval / GET | $0.0125/GB-mo / $0.01/GB / $0.001 per 1,000 |
| Object tag | $0.00000065/tag-mo |

**The break-even read rate is the same for every class: 0.63 origin reads per object per month.**
Storage saved is $0.019/GB-mo; retrieval costs $0.03/GB. So GIR wins only on objects fetched **less
often than roughly once every 47 days**. (Standard-IA's break-even is ~1.05 reads/mo — so for
objects read between ~0.6 and ~1.0 times a month, IA beats both.)

---

## 2. Per-class economics, Model B (60k stills, 3k clips, 500 GB originals)

| Class | obj size | count | Standard | GIR (128 KB floor applied) | Δ/mo |
|---|---|---|---|---|---|
| `image-thumb` | 20 KB | 60k | $0.026 | $0.029 | **−$0.003** |
| `image-medium` | 110 KB | 60k | $0.145 | $0.029 | +$0.115 |
| `image-screen` | 350 KB | 60k | $0.461 | $0.080 | **+$0.381** |
| `video-poster-thumb` | 20 KB | 3k | $0.001 | $0.001 | −$0.000 |
| `video-poster-screen` | 350 KB | 3k | $0.023 | $0.004 | +$0.019 |
| `video-skim` | 150 KB | 3k | $0.010 | $0.002 | +$0.008 |
| `video-720p` | 5.6 MB | 3k | $0.368 | $0.064 | **+$0.304** |

`image-thumb` and `video-poster-thumb` *lose money in GIR before a single byte is read*. That is the floor alone.

### The two scenarios compared

| | Proposed (`image-thumb`+`image-medium`+`image-screen`+`video-poster-screen`) | Alternative (`image-screen`+`video-poster-screen`+`video-720p`) |
|---|---|---|
| Gross storage saving | $0.512/mo | $0.704/mo |
| Recurring tag cost (§5.1) | −$0.119/mo | −$0.043/mo |
| **Net, zero reads** | **$0.393/mo** | **$0.661/mo** |
| One-time transition | $3.77 | $1.47 |
| Reads to break even | 13.1 GB/mo | 22.0 GB/mo |
| **Extra GET cost, one full cold re-read** | **$1.76** | **$0.63** |

At Model C (170k stills, 15k clips, 2 TB) the gap widens: **$1.15/mo net** for the proposal vs
**$3.33/mo net** for the alternative, with `video-720p` alone worth $2.28/mo.

The last row is the decisive one for the proposal. A single cold scroll through 60k grid tiles costs
**$0.58 in GIR GET requests** (60k × $0.0096/1,000) — one and a half months of the entire net saving,
for one browsing session, on a class that saves nothing on storage anyway. Add `image-medium` and it is
$1.15 per full AI catch-up scan (§6.2), which by design reads `image-medium` for every item.

---

## 3. Drawbacks that survive even for the good classes

1. **Tags are a real recurring cost and they scale with object count, not bytes.** §5.1 already
   established that `hot` is untagged specifically to avoid this. Tagging `image-thumb` + `image-medium` adds
   120k tags = $0.078/mo — 20% of the proposal's entire net saving, spent to demote the two classes
   that shouldn't be demoted. The alternative's list is 66k tags for twice the saving.

2. **CloudFront caching protects the wrong objects.** §5.5 routes reads through CloudFront, so repeat
   views of *hot* items are absorbed at the edge and never touch origin. But the objects a 2-week
   lifecycle rule demotes are precisely the cold-tail objects that get evicted from edge caches
   between views — so nearly every view of a demoted object is an origin fetch. CloudFront makes the
   retrieval fee cheap exactly where the transition doesn't apply, and does nothing where it does.

3. **The transition is one-way, and read patterns aren't monotonic in age.** An album rediscovered,
   a person the user starts searching for, an "on this day" surface, or the slideshow feature (§7.4)
   all re-read old renditions in bulk. Under I-T those objects promote back to Frequent Access for
   free; under a lifecycle rule they stay in GIR and pay $0.03/GB plus 25× GET forever. This is worth
   noting against §5.3.2, which rejected I-T on the monitoring fee — the proposal is essentially
   hand-rolled I-T with no promotion path and no measurement.

4. **It weakens the doc's own argument for rejecting I-T.** §5.3.2's case is "each size class has a
   known read frequency; paying S3 to rediscover that is paying for a fact we already have." That
   argument holds only if class membership determines the storage decision. Adding an age dimension
   concedes that class alone isn't sufficient — while still not measuring anything.

5. **90-day minimum storage duration.** Append-only makes this mostly moot, but not while §3.4 is
   still open: if the visual test changes quality levels, or §3.2's open question retires `image-screen` on
   phones, the superseded renditions were committed for 90 days at transition. Argues for not
   enabling any of this until after §3.4 and the backfill have settled.

6. **`availability` is unaffected — this is the one thing that genuinely doesn't break.** GIR is
   millisecond retrieval, so §5.1.1's field stays `instant`, there is no restore flow, no thaw
   hazard, and §7.4's slideshow constraint is untouched. None of the Deep Archive dangers apply.
   That's why the idea is worth taking seriously at all.

---

## 4. What the rule should be

Not age. **Demote a class to GIR when its objects are comfortably above 128 KB *and* read less than
~0.6 times per object per month.** Applied to the ladder:

| Class | Verdict | Why |
|---|---|---|
| `image-thumb`, `video-poster-thumb` | **Standard, always** | below the 128 KB floor; highest request volume in the system |
| `image-medium` | **Standard** | below the floor; the AI rung (§6.2) and fullscreen stage 1 — read constantly |
| `video-skim` | Standard | $0.008/mo at stake; not worth a tag |
| `image-screen`, `video-poster-screen` | **GIR — good candidate** | 350 KB, well above the floor; read once per open, and §3.2's open question may remove it from the phone path entirely, which would make reads genuinely rare |
| `video-720p` | **GIR — best candidate** | 5.6 MB objects, no floor problem, few objects so few tags, and playback is a deliberate rare act. §5.4 note 2 already flags this class as the lever for video-heavy libraries; it recommends Standard-IA, but GIR saves more if reads are as rare as expected |
| `image-large`, `video-1080p` | GIR (unchanged) | already the plan |

`image-screen` + `video-poster-screen` + `video-720p` → `cool` captures **$0.66/mo of the $0.70 available at Model B
and $3.33/mo at Model C**, with a third of the tags, a third of the transition cost, and none of the
`image-thumb`/`image-medium` request exposure.

**On the timing question specifically: the delay is nearly irrelevant.** By the same argument as
§5.2, the transition cost is fixed and the only cost of waiting is Standard storage during the
window. At Model B's growth rate a 14-day window holds ~0.36 GB of new renditions ≈ **$0.008/mo**.
Pick the window for safety margin (re-derivation, a bad quality level caught late), not for cost —
and the same 7-day default as §5.2 is fine. `video-720p` could arguably transition at day 1 like
`image-large` does, since it is never re-derived from itself.

---

## 5. Intelligent-Tiering, reconsidered — and this is probably the answer

§5.3.2 priced I-T and rejected it. That analysis modelled I-T **with both opt-in async archive tiers
enabled** (Archive Access, Deep Archive Access), and two of its three objections are objections to
*those tiers specifically*: the "retrieval latency changes silently on a schedule we do not control"
argument, and "I-T cannot reach Deep Archive economics for six months."

**Neither applies if the async tiers are left off.** With only the automatic tiers — Frequent Access →
Infrequent Access (30 days) → Archive Instant Access (90 days) — every tier is millisecond-latency,
`availability` is always `instant` (§5.1.1), there is no restore flow, and §7.4's slideshow
constraint is untouched. That is a materially different product from the one §5.3.2 priced, and it
should be evaluated on its own.

### The property that makes it fit this ladder

**I-T self-selects on the same 128 KB boundary that makes GIR wrong for the small classes.** Objects
under 128 KB are *neither monitored nor transitioned* — they stay at the Frequent Access rate, which
is the Standard rate, and they are **not charged the monitoring fee at all**. So `image-thumb`
(20 KB), `image-medium` (110 KB) and `video-poster-thumb` (20 KB) cost exactly what they cost today,
and the whole §1(a) floor problem simply does not arise.

That means the question this document opened with — *which classes are big enough to demote?* —
does not have to be answered. Put every rendition class in I-T and AWS applies the boundary. No
per-class judgement, no tag, no lifecycle rule per class, and nothing to revisit when §3.4 changes
the byte sizes.

### Verified prices

| | GIR | I-T (automatic tiers only) |
|---|---|---|
| Storage at rest | $0.004/GB-mo | $0.004/GB-mo (`TimedStorage-INT-AIA-ByteHrs`) — **identical** |
| Per-object recurring | tag $0.00000065/obj-mo | monitoring $0.0000025/obj-mo (`Monitoring-Automation-INT`) |
| Retrieval fee | $0.03/GB | **none — no `Retrieval-INT` line exists** |
| GET request | $0.01/1,000 | **$0.0004/1,000** (`Requests-INT-Tier2`) — same as Standard |
| Objects < 128 KB | billed as 128 KB | not monitored, not charged, stay at Standard rate |
| Promotion when read again | never — one-way | automatic and free |
| Transition | $0.02/1,000 + $0.004/GB | $0.01/1,000 + $0.004/GB |
| Latency / `availability` | ms / `instant` | ms / `instant` |

The GET line is the one that was missed the first time. **GIR charges 25× Standard per GET; I-T
charges exactly Standard.** For a ladder whose whole point is many small objects fetched by a grid,
that is not a rounding difference.

### The numbers

Steady state, assuming 95% of an append-only library is past the 90-day mark:

| Class | Standard | GIR | I-T |
|---|---|---|---|
| `image-thumb` | $0.026 | $0.068 | **$0.026** |
| `image-medium` | $0.145 | $0.068 | $0.145 |
| `image-screen` | $0.461 | $0.119 | $0.239 |
| `image-large` | $1.053 | $0.222 | $0.353 |
| `video-poster-thumb` | $0.001 | $0.003 | $0.001 |
| `video-poster-screen` | $0.023 | $0.006 | $0.012 |
| `video-skim` | $0.010 | $0.004 | $0.009 |
| `video-720p` | $0.368 | $0.066 | $0.078 |
| **Total (Model B)** | **$2.09** | **$0.56** | **$0.86** |
| **Total (Model C)** | **$7.71** | **$1.91** | **$2.84** |

Against the plan as written (Standard everywhere except `image-large` in GIR — $1.26/mo at B,
$5.35/mo at C):

- **all-I-T saves $0.39/mo at B, $2.51/mo at C**
- **all-GIR saves $0.70/mo at B, $3.44/mo at C — but only at zero reads**

### Where the crossover actually sits

GIR's advantage is a fixed $0.31/mo at B; its exposure is $0.03/GB plus a 25× GET surcharge on every
read. Solving for the read volume at which I-T becomes cheaper:

| Class | I-T beats GIR above |
|---|---|
| `video-720p` | **33 plays/month** |
| `video-poster-screen` | 283 reads/mo |
| `video-skim` | 400 reads/mo |
| `image-large` | 3,417 reads/mo (~114/day) |
| `image-screen` | 5,659 reads/mo (~189/day) |

**The video classes are not close** — 33 video plays a month is a bar any real library clears
trivially, because there are few video objects (so monitoring is nearly free) and each one is large
(so GIR retrieval is expensive). I-T is simply the right answer for `video-720p`, `video-1080p`,
`video-poster-screen` and `video-skim`.

The two big still classes are a genuine judgement call, and it is a judgement about browsing
volume: under ~190 `image-screen` fetches a day, GIR is cheaper; above it, I-T. At Model C the bar
rises to ~534/day, because monitoring scales with object count while GIR's retrieval scales with
bytes read.

### Recommendation

**Put every rendition class in Intelligent-Tiering with the async archive tiers disabled. Leave
originals on the explicit Deep Archive path (§5.2), unchanged.**

The arithmetic says GIR is $0.31/mo cheaper at B if reads are rare. Take I-T anyway, for four
reasons that are worth more than $0.31:

1. **It removes the decision instead of making it.** No 128 KB analysis, no per-class tagging, no
   lifecycle rule per class, and — importantly — nothing to redo when §3.4 replaces the provisional
   byte sizes. If `image-medium` comes out of the visual test at 140 KB instead of 110 KB, the GIR
   answer flips and the I-T answer doesn't change.
2. **I-T's cost is a ceiling; GIR's is a floor.** The GIR bill responds to browsing, to a new device
   syncing, to an AI catch-up scan, and to the future slideshow. §5.1.1 exists precisely to stop
   reads from surprising the bill; putting the interactive classes on a retrieval-metered tier
   reintroduces a milder version of the thing that section defends against.
3. **The one-way trap disappears.** A rediscovered album or a newly-searched face promotes back to
   Frequent Access free under I-T and stays expensive forever under GIR.
4. **The tag bill and the tag mechanism both go away** for renditions — no `cool` intent to assign,
   which is $0.12/mo at B and a chunk of §5.1's write-path complexity.

**§5.3.2's remaining objection still stands and should be kept:** paying per object per month to
have S3 discover access patterns we designed is philosophically backwards. The honest answer is that
it turns out to be worth paying, because the fact we "already have" is a fact about *classes* and the
monitoring fee buys per-*object* recency, which the class-level fact cannot express — the 5% of
`image-screen` objects that are actually hot are not identifiable from the class name.

**What §5.3.2 got right and should not be reversed:** originals stay on the explicit archive path.
I-T's Deep Archive Access tier needs 180 days of no access against §5.2's 7-day gate, and enabling it
would reintroduce exactly the silent-latency problem this recommendation avoids by leaving the async
tiers off.

---

## 6. One correction for the plan, independent of this decision

§5.3.1 attributes the $0.004/GB checksum-computation fee to Deep Archive only. The API shows
`Compute-Checksum-Processed-GIR-Bytes` at the same $0.004/GB, so **GIR transitions carry it too**.
§5.4's one-time transition figures under-count by ~$0.19 at Model B (48 GB of `image-large`) and ~$0.54 at
Model C. Immaterial to any decision, but the figure is stated as verified and isn't.
