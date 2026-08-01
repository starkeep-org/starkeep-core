# Media storage & transfer plan — photos and video

**Status:** proposal, not yet implemented. Branch `media-storage-and-video` in both `starkeep-core` and `starkeep-apps`.
**Date:** 2026-07-31

Covers: which reduced sizes to generate, when and where they are generated, how they are stored, which sizes are served to which consumer (UIs and on-device AI), cloud and local storage policy, configuration, and the AWS/latency cost model. Adds video support and modern-format support to Photos as part of the same design, because they are the same problem.

---

## 0. Scope and premises

Established with the operator:

- **Library:** 20k–100k items, tens of GB to a few hundred GB. §5.4 models three scales — 50 GB, 500 GB (the operator, ~63k items, growing ~100 GB/yr), and 2 TB.
- **Capture:** iPhone (HEIC + Live Photos, Apple ProRAW/DNG, 4K/HDR, ProRes), Pixel (HEIC/JPEG, DNG, Motion Photos, HEVC MP4), plus 1080p short clips.
- **Append-only.** Nothing is ever deleted. Glacier minimum-duration billing is therefore a non-issue, and monotonic growth makes per-GB storage price the dominant long-run term.
- **Nodes:** the laptop runs a local-data-server; the phone runs a **sync peer** — an app implementing the sync protocol without the LDS's server surface, modelled on how Google Photos works on iOS (§7.5). **Android ships first** and is built to the iOS background-execution constraint (§7.6).
- **AI is local-first, on-device only.** The cloud never needs pixel access for tagging, faces, or similarity.
- **Viewing:** phone almost always, laptop occasionally, 4K TV rarely, print rarely. Recency-biased — recent items are viewed far more.
- **Target UI:** the Starkeep Photos UI should become the primary phone surface (aspirationally today).
- **Originals are archivable.** Confirmed as a deliberate part of the strategy.
- **Bulk re-homing** is real but **local-first only** — assume the user downloads (e.g. Google Takeout) to a machine. Server-side fetch is deferred; Takeout specifics wait until a real export is inspected. Duplicate suppression on the phone→Google→Takeout round trip is designed in §4.5.

Out of scope: the automatic-slideshow feature itself (but §7.4 constrains its design so it can never thaw an archive).

---

## 1. What is true today (verified against the code)

These are not assumptions; each was read out of the tree on this branch.

**Derived sizes**

1. There is exactly **one** derived size: 400px longest edge, JPEG q85 (WebP q76 when the source has alpha) — `photos/src/photos-lib/image-processing/resize.ts:7`.
2. It is generated **on demand**, by an explicit `POST /api/resize` call, in whichever location the caller happens to hit — `photos/infra/src/resize-handler.ts` (cloud) mirrored by `photos/app/api/resize/route.ts` (local). Nothing generates it at ingest.
3. Each thumbnail is a **full shared record** with `parent_id` set and a `photos/thumbnail` bare-flag label. It therefore syncs to every node exactly like an original, doubles the record count, and is visible to every app holding an `image` grant.
4. The cloud resize Lambda issues `GET /data/records?limit=1000&include=labels` **on every single resize** to answer two questions (`resize-handler.ts:85`). That is O(library) per thumbnail and caps out at 1000 records.
5. The grid renders a tile **only** for records carrying the `thumbnail` label; everything else draws a placeholder (`photos/src/photos-ui/components/grid/photo-thumbnail.tsx:25`). An original without a thumbnail is effectively invisible.

**Sync and residency**

6. **Blob replication is unconditional and total.** `packages/sync-engine/src/file-sync-engine.ts:40` pulls every blob for every record with no policy hook.
7. **A device cannot decline a blob.** `packages/sync-engine/src/sync-engine.ts:346-361` treats a missing blob as a *failure* and deliberately holds the watermark back so the record is re-shipped next round. There is no way to express "I have the metadata and I am intentionally not fetching the bytes." **This single behaviour blocks both a phone node and any archive tier**, and it is the first thing that has to change.
8. Transfers **buffer the whole object in memory** (`source.get()` → `destination.put()`, `file-sync-engine.ts:81-88`). No streaming, no multipart. A 2 GB ProRes clip cannot sync.
9. `/data/records` supports `type`, `limit`, `cursor`, `updated_after`, `include`, `label`, `labelValue`, `labelApps` — but **no `parentId` filter and no negated-label filter** (`cloud-data-server/src/api-handler.ts:991`). "Give me the screen rendition of record X" and "give me originals only" are both un-expressible server-side. That is why finding 4 exists.

**Bytes on the wire**

10. **CloudFront is already in place and already correct** for viewing: a `shared/*` behavior over the files bucket with OAC, signed URLs from a key group, and a path-keyed cache policy that *excludes* the signature query params from the cache key — `defaultTtl` 1 day, `maxTtl` 1 year, safe because keys are content-addressed and immutable (`packages/admin-installer/src/builtin-programs/cloud-data-server-program.ts:446-600`).
11. **Sync bypasses CloudFront** and transfers via presigned S3 URLs directly (`apps/local-data-server/http-object-storage.ts:29`). So the high-volume path pays $0.09/GB with no CDN and no free tier, while the low-volume UI path pays $0.085/GB with caching and a 1 TB/mo perpetual free tier. This is backwards.
12. **No storage-class management exists anywhere.** No `StorageClass`, no lifecycle rules. Everything is S3 Standard, forever.

**Formats**

13. **HEIC cannot be decoded.** sharp 0.34.5 / libvips 8.17.3 as resolved in this workspace reports `heif` input with `fileSuffix: [".avif"]` only — AVIF in and out, no HEVC-backed HEIF. The primary format the operator's phone produces is undecodable by the current toolchain.
14. *(JXL was surveyed here and is out of scope — see §8.3.)*
15. **RAW/DNG is absent from the type registry.** `packages/protocol-primitives/src/types/core-types.ts:203-213` has no `dng`/`cr3`/`nef`/`arw`. A `.dng` therefore falls to `other/other`, which is Drive-only and **ungrantable to installable apps** — invisible to Photos. For a ProRAW shooter this is a live bug, not a future gap.
16. Video types (`video/mp4`, `video/mov`, …) and a full video metadata column set (`duration_ms`, `frame_rate`, codecs, bitrate, GPS) **already exist in the registry**. Photos simply does not grant `video/*` in its manifest (`photos/starkeep.manifest.json`). The platform is further along on video than the app is.
17. There is no representation of a "moving picture" (Live Photo / Motion Photo) anywhere.

**AI**

18. Vision fetches **full original bytes** per record and downsizes in-process (`photos/src/vision/engine/scan-worker.ts:36`). SCRFD wants 640×640; SigLIP 2 wants ~384. Reading a 48 MP ProRAW to produce a 640px letterbox is ~50 MB of I/O for ~1 MB of useful pixels — and it is impossible once the original is archived.

**Durability**

19. **There is no way to confirm an upload was fully successful — only that an object exists.** The push path checks the S3 PUT's HTTP status but sends no checksum, so S3 stores whatever arrived and reports success (`apps/local-data-server/http-object-storage.ts`). Every subsequent check is `remoteStorage.has()`, which is `HeadObject` → `boolean` (`packages/storage-s3/src/adapter.ts:134`), discarding `ContentLength`, `ChecksumSHA256`, `StorageClass`, and `x-amz-restore`. It also cannot distinguish "the object is in Deep Archive and unreadable" from "the object is readable". **This blocks eviction**, which is the one operation in this plan that destroys data — see §7.2.1 for the fix, which is cheap because the keys are already SHA-256 digests.

---

## 2. The shape of the answer

Five decisions carry the whole plan.

1. **A rendition ladder replaces the single thumbnail** — four still sizes, plus video-specific ones.
2. **Derive once, at the first point where the bytes are resident, and never transfer an original for the purpose of deriving from it.** In the steady-state capture flow that point is the phone; for a bulk re-home it is wherever the import lands (§4.5). Zero egress, zero Lambda, zero thaw. §4.2 defines what happens when that fails.
3. **Residency becomes a policy, not an invariant.** A node declares what it keeps, per size class; declining a blob is a legitimate state, distinct from failing to fetch one.
4. **Storage class is a declared property of a record, visible to every app.** The writing app declares a retrieval *intent*; the platform maps it to an S3 class and reports the resulting availability back on the record, so no app can thaw an archive by accident (§5.1).
5. **Originals are archived as soon as the ladder is durable**, gated on verification rather than on age — with a fixed minimum hold before the transition, because the transition costs the same whenever it happens (§5.2). Everything else lives in Intelligent-Tiering, which makes the hot/cold call per object instead of per size class (§5.3.2).

---

## 3. The rendition ladder

> **All sizes and quality levels in this section are provisional pending a manual visual test.** The numbers below are reasoned from panel resolutions and cost, not from anyone having looked at the output. Nothing here should be treated as settled until a real set of the operator's photos — including hard cases: fine text, foliage, night shots, skin tones, gradients — has been encoded at each long edge and quality level and compared side by side at the size it will actually be viewed. §3.4 defines that test. The *structure* of the ladder (how many sizes, what each is for) is the decision this document makes; the specific integers are the test's output.

A **size class** (used interchangeably with "rung") is one entry in the ladder: a target long edge, a codec, and the consumers it serves. `original` is a size class like any other, which matters for §7.2 — residency and budgets are expressed per size class, and `original` is not a special case.

### 3.0 Naming: every class carries its media type

There are two ladders — one for stills, one for video — and an earlier draft named their rungs independently (`thumb`, `medium`, `screen`, `large` against `poster-thumb`, `poster-screen`, `skim`, `preview`, `hd`). That reads fine inside either table and is genuinely confusing everywhere else, because most of this document discusses the two ladders together: §5.1's intent mapping, §5.4's cost model, §7.2's budgets and §9's configuration all enumerate classes from both. A bare `thumb` in those lists does not say whether the video ladder's grid tile is included, and `poster-thumb` does not say it is the video one unless you already know.

**So every size class name is prefixed with the ladder it belongs to** — `image-` or `video-`:

| Ladder | Classes, smallest first |
|---|---|
| **Still** (§3.1) | `image-thumb`, `image-medium`, `image-screen`, `image-large` — plus `image-motion` / `image-motion-preview` for Live Photos (§8.4) |
| **Video** (§3.3) | `video-poster-thumb`, `video-poster-screen` *(stills)*; `video-skim`, `video-720p`, `video-1080p` *(motion)* |
| **Both** | `original`, `crop` — unprefixed, see rule 4 |

The two ladders are not in correspondence rung-for-rung and should not be read as a matrix: the
video ladder has two poster stills against the still ladder's four sizes, and the still ladder has
nothing analogous to `video-skim`.

Four rules make this unambiguous:

1. **The prefix names the parent record's media type, not the rendition's own.** A video's poster frames are still images but belong to the video ladder, hence `video-poster-thumb`. The converse case is §8.4's Live Photo motion clip: video bytes hanging off an *image* record, hence `image-motion`. That one reads awkwardly and is the only place the rule strains; the alternative — prefixing by the bytes — would break the far more common poster case and split the video ladder in half.
2. **`poster-` is kept rather than folded away.** `video-poster-screen` is longer than `video-screen`, but it preserves the distinction that matters inside the video ladder: `video-poster-*` are stills, `video-skim`/`video-720p`/`video-1080p` are motion. A `video-screen` that turned out to be an AVIF still would be a new instance of exactly the confusion this section removes.
3. **The video playback rungs are named by resolution, not by role.** They were `preview` and `hd`, which was the worse half of the naming problem: "preview" is used in this document for at least four unrelated things — the ThumbHash placeholder (§3.2), the DNG embedded JPEG preview (§7.6, §8.2), "print preview" in the `image-large` row, and the Live Photo playback clip (§8.4) — and "HD" does not say which HD. `video-720p` and `video-1080p` say exactly what they are and cannot collide with anything. The still classes stay role-named (`thumb`/`medium`/`screen`/`large`) because their long edges are still under test (§3.4) and pinning a pixel count into the name would make the §3.4 outputs a rename; the video playback tiers, by contrast, are standard resolutions that will not move.
4. **`original` and `crop` stay unprefixed.** They mean the same thing in both ladders and are never ambiguous. *(An earlier draft also had `native`; §3.1.1's max-size semantics removed it.)* `original` is the one class that exists in both, so where the two need distinguishing — §7.2's budgets are the only place — it is spelled out in words rather than given a prefix it would not otherwise carry.

The one surviving use of "preview" as a class name is `image-motion-preview` (§8.4), the short playable clip for a Live Photo. It keeps the name only because §8.4 has not yet fixed a resolution for it; when it does, it should become `image-motion-<res>` on rule 3.

The label values in §4.4 are these exact strings, so `photos/rendition=image-thumb` is what appears on the wire.

### 3.1 Still images

| Size class | Max long edge | Codec | Typical size | Storage class | Serves |
|---|---|---|---|---|---|
| *(ThumbHash)* | ~32 px equiv | ~25 bytes, **inline in metadata** | — | (DB row) | instant placeholder, zero requests (§3.2) |
| `image-thumb` | 400 px | AVIF q50 | ~20 KB | I-T (stays at Standard rate) | grid tiles, list rows |
| `image-medium` | 1280 px | AVIF q55 | ~110 KB | I-T (stays at Standard rate) | **all routine on-device AI**, fullscreen stage 1, low-DPI windowed viewing, share/export default |
| `image-screen` | 2560 px | AVIF q55 | ~350 KB | Intelligent-Tiering | phone fullscreen, laptop, AI re-crops of small subjects |
| `image-large` | 4272 px | AVIF q60 | ~950 KB | Intelligent-Tiering | 4K TV, laptop fullscreen retina, zoom, OCR, print preview |
| `original` | native | as captured | 3–80 MB | Glacier Deep Archive | print, export, editing, re-derivation |

Reasoning:

- **`image-thumb` at 400, not 256.** High-density displays are the constraint: a 3× Android panel needs 400 physical pixels for a ~133 pt tile. **This couples the size class to a UI decision** — 400 px only works if grid tiles stay at or below ~133 pt on a 3× display. If the mobile grid wants larger tiles, this class has to grow with it; they cannot be chosen independently.
- **`image-medium` at 1280 — the fourth size, and it earns its keep three separate times.** An earlier draft had three rungs and flagged the gap between 400 and 2560 as the one place the three-rung decision might not survive contact with a real device. It does not, for reasons that compound:
  - **AI.** Every routine model input is far below 2560 — SCRFD wants 640×640, SigLIP 2 ~384, Objects365 ~640. Downscaling 2560→640 costs 4× the bytes and 4× the decode for pixels the model throws away. 1280 is comfortably above every input size with headroom for letterboxing, so `image-medium` becomes the AI rung and `image-screen` becomes the *re-crop* rung for small subjects (§6.2). On a phone doing a catch-up scan over tens of thousands of items this is the difference between ~110 KB and ~350 KB per item of I/O and decode — a battery-level difference, not a rounding error.
  - **Progressive presentation.** 400 px upscaled onto a 2556 px phone screen is a visibly bad stage 1. 1280 upscaled to 2556 is a soft-but-honest stage 1 that arrives in a third the bytes of `image-screen` (§3.2).
  - **Sharing and export.** The overwhelmingly common "send this to someone" size is around 1–2 MP. Today that would either ship a 350 KB `image-screen` or thaw an original; `image-medium` is the right default and costs nothing extra because it already exists.
- **`image-screen` at 2560, not 1600.** An earlier draft used 1600 and was simply too small. Real panels: iPhone 15 Pro 2556×1179, Pro Max 2796×1290, MacBook Pro 14" 3024×1964, 16" 3456×2234, older 15" 2880×1800. 2560 is at or near native for phone landscape and fine windowed on a laptop; the residual upscale on a 16" fullscreen is what `image-large` is for.
- **Four, not five.** Each additional size class multiplies object count, sync volume, derivation CPU, and every code path that has to choose one. `image-medium` was added because three named consumers wanted it; nothing else has that case. The ThumbHash placeholder is deliberately *not* a size class — it costs no object and no request (§3.2).
- **`image-large` at 4272** keeps the 4K TV and zoom cases off the archive, and by §3.1.1 it is also every record's *master* — the largest instantly-readable copy, at native resolution for anything up to 4,272 px. 4272 rather than 3840 because 4272×2848 is a real and populous sensor size (12 MP Canon APS-C, Sony A700) that a 3840 ceiling would downscale for nothing. It is read rarely, and at ~950 KB it sits well above the 128 KB threshold below which Intelligent-Tiering stops managing an object — so it is the class that benefits most from I-T's idle-based demotion (§5.3.2), reaching $0.004/GB-mo with no retrieval fee and no loss of latency.
- **AVIF for renditions.** Encodes and decodes in the current sharp build and is supported by every current browser. Quality levels above are starting points for §3.4, not conclusions — AVIF q50/q55/q60 are guesses at where the perceptual knee sits at each size.
- **No separate `work` rung for AI.** `image-medium` covers it (§6.2), so there is no AI-only generation path.

#### 3.1.1 Sizes are maxima, not targets

**Every number in §3.1 and §3.3 is a *maximum*, not a fixed output size.** A rendition's long edge is
`min(original long edge, class maximum)`, so a class never upscales and never produces a file larger
than its source. An earlier draft treated the numbers as fixed targets and added a separate
applicability margin to stop near-copies; that produced worse results than the simpler rule and is
replaced by the two below.

**Rule 1 — a rendition is `min(original, class max)`.** `image-screen` on a 2,556 px screenshot is
2,556 px, not 2,560 and not absent. `image-large` on a 4,032 px capture is 4,032 px; on a 48 MP
ProRAW it is 4,272 px.

**Rule 2 — generate a class when the original is larger than the *next lower class's* maximum.** No
offset, no margin. `image-screen` (max 2560) is generated whenever the original exceeds 1280, which
is `image-medium`'s maximum. The bottom rung has no class below it and is therefore always
generated.

| Class | Maximum long edge | Generated when original exceeds |
|---|---|---|
| `image-thumb` | 400 | *(always)* |
| `image-medium` | 1280 | 400 |
| `image-screen` | 2560 | 1280 |
| `image-large` | 4272 | 2560 |

`image-large`'s maximum is **4272, raised from 3840**. 4272×2848 is the native output of the 12 MP
Canon APS-C bodies and the Sony A700, so the higher ceiling lets that whole population keep a
full-resolution instant copy instead of being downscaled for no reason.

**What this buys, and it is the point of the change:**

- **Every record's top class is at native resolution unless the original exceeds 4,272 px.** There is
  always an instantly-readable copy at `min(original, 4272)`. Under the old margin rule a 4,032 px
  12 MP capture — most phone photos — got no `image-large` at all, was nonetheless archived, and left
  2,560 px as its best instant copy, so zoom and OCR past 2560 meant a 48-hour thaw. That failure
  mode does not exist here.
- **Applicable classes remain a contiguous prefix from the bottom**, since the thresholds are
  monotonic. "Top applicable class" still fully describes the set, which is what §5.2's
  ladder-complete gate and §4.2's sweeper query rely on.
- **Every record has an `image-thumb`**, so the grid has no fallback path and no placeholder case.
- **No upscale is possible by construction** rather than by a rule that has to be remembered.

**The accepted cost: near-copies just above a boundary.** A 1,300 px original gets `image-medium` at
1,280 and `image-screen` at 1,300 — two renditions 1.5% apart. This is a deliberate trade: adding an
offset to suppress it is what produced the 4,032 px failure above, and the waste is bounded at one
extra rendition sized like the class below it, only for originals landing in a narrow band above a
maximum. Since real originals cluster at a small number of device-native sizes, the band is mostly
empty. One consequence to carry into §4.6: for those records the top class is a poor re-derivation
source for the class below it, because the downscale ratio is ~1.0 and no artifact filtering happens.

**"Ladder complete" is evaluated over applicable classes only** (§5.2), unchanged — otherwise the
archive gate never fires for small originals.

**Two rules the old scheme needed and this one deletes:**

- *"An original is archivable only if `image-screen` is applicable."* Gone. Under maxima the ladder
  always covers interactive viewing at native resolution, so no original is ever needed for viewing.
  What remains is purely economic — the **~1 MB archive floor in §5.1**, because Deep Archive's 40 KB
  per-object overhead makes archiving a small object cost more than leaving it. That floor was
  described as "the same idea reached from two directions"; only the cost direction survives, which
  makes it one rule instead of two that had to be reconciled.
- *`photos/rendition=native` on the original.* Gone. Its job was to let "best available class"
  resolve in one index when the original was a record's top rung; the original is never the top rung
  now. Restoring an original remains an explicit action for print, export, editing and zoom beyond
  4,272 px — not something the read path falls through to.

**The read path** is unchanged in shape but must read dimensions rather than infer them: a consumer
asks for a target long edge and gets the smallest applicable class at or above it, or the largest
that exists. Because sizes are now per-record, **no consumer may assume `image-screen` means 2560** —
the actual `width`/`height` come back on the record with the rest of its image metadata, so this
costs no extra request.

**Video needs the same treatment on two axes, and §3.3's numbers are maxima too.** Resolution follows
rules 1 and 2 directly — which closes the identical gap on the poster classes, where under the old
margin rule a 1080p source (1,920 px) would have got no `video-poster-screen` at all and only 4K
sources would. Bitrate is a second maximum: a transcode's bitrate is `min(source, class max)`. The
extra clause video needs and stills do not: **if both resolution and bitrate would be unchanged, do
not transcode — use the original**, since the output would be a same-size re-encode with nothing
gained. A 480p 800 kbps clip is its own `video-720p`.

### 3.2 Progressive presentation — needs more work

Flagged as **not yet settled**. Google serves several sizes plus a much lower-quality version first to buy perceived latency, and the fixed ladder above does not by itself reproduce that.

**Recommended progression:**

| Stage | Source | Cost | When |
|---|---|---|---|
| 0 | **ThumbHash**, ~25 bytes, inline in the record | **zero extra requests** | instant, on metadata arrival |
| 1 | `image-thumb` 400 px, ~20 KB | 1 cached CDN request | on scroll into view |
| 2 | `image-medium` 1280 px, ~110 KB | 1 cached CDN request | on open |
| 3 | `image-screen` 2560 px, ~350 KB | 1 cached CDN request | immediately after stage 2, on any full-size viewport |
| 4 | `image-large` (up to 4272 px) | 1 cached CDN request | only if the viewport genuinely exceeds this record's `image-screen` |

**ThumbHash is the important piece and the cheapest.** It is a ~25-byte encoding of a blurred preview (better than BlurHash — handles alpha, better fidelity) that renders client-side with no network request at all. Because it is deterministic from the bytes, it belongs in **per-category image metadata** by `system-design.md`'s own test ("Is it derivable from the bytes? If yes, it is per-category metadata"), which means it **arrives with the record list that was being fetched anyway** — the placeholder costs literally nothing on the wire. That beats what Google does: their low-quality stage still costs a round trip.

**Rejected: on-demand arbitrary sizes** (Google's `=w1024` style). It requires a resizing service in the request path — a Lambda per uncached size plus cache churn — where a fixed ladder is a static, CloudFront-cacheable object. The ladder covers the real device classes; arbitrary sizing buys pixel-exactness we cannot perceive at a cost we can measure.

**Still open, and the reason this section is flagged:**

- Whether stage transitions should be a *replace* or a CSS cross-fade, and whether decoding a 350 KB AVIF on a mid-range Android is fast enough that the earlier stages are even visible.
- Whether stage 3 is worth issuing eagerly on a phone at all, given `image-medium` at 1280 upscaled to 2556 may be indistinguishable from `image-screen` in hand at arm's length. This is a §3.4 visual-test question, and if the answer is "indistinguishable", the phone can skip `image-screen` entirely and the mobile byte budget improves by ~3×.
- AVIF decode latency vs JPEG on low-end hardware — AVIF is smaller on the wire but slower to decode, and for perceived latency the trade may not favour it at the early stages.

The first and third are measurable on the Android app (§7.6) and should be settled there. The second is settled by §3.4.

*(The earlier open question here — whether an intermediate ~1280 size earns its keep — is now answered yes; it is the `image-medium` class in §3.1.)*

### 3.3 Video

| Size class | Max spec | Typical (30 s clip) | Storage class | Serves |
|---|---|---|---|---|
| `video-poster-thumb` | 400 px still from frame ~1 s | ~20 KB | I-T (stays at Standard rate) | grid tile |
| `video-poster-screen` | 2560 px still | ~350 KB | Intelligent-Tiering | larger-thumbnail UIs, pre-roll / paused state |
| `video-skim` | ~480 px, 4 fps, 8× speed, capped at ~10 s output | ~150 KB | Intelligent-Tiering | hover / long-press identification |
| `video-720p` | 720p H.264 ~1.5 Mbps, full framerate | ~5.6 MB | Intelligent-Tiering | actual inline playback |
| `video-1080p` *(optional)* | 1080p H.264 ~4 Mbps | ~15 MB | Intelligent-Tiering | TV / large-screen playback |
| `original` | as captured | 30 MB–6 GB | Deep Archive | export, editing |

**`video-skim` and `video-720p` are two different things and both are wanted.** An earlier draft conflated them. `video-skim` answers *"which video is this?"* at a glance — the low-framerate, fast-playback strip that reads as a series of stills, the same idea as YouTube's hover preview. `video-720p` answers *"let me watch it"* at full framerate. Neither substitutes for the other.

- **`video-skim` sizing rule:** speed factor = `max(8, duration_seconds / 10)`, so output never exceeds ~10 s regardless of source length. A 30 s clip → 3.75 s at 4 fps ≈ 15 frames; a 5-minute clip → 10 s at 4 fps = 40 frames, not 150. Without the cap, long videos produce absurd skims.
- **`video-skim` is probably better as an animated image than a video.** At 15–40 frames, animated AVIF or WebP renders in a plain `<img>` — no player, autoplays, loops, trivially cacheable, no range requests. **Needs testing** (the operator's note): frame rate, speed factor, and container are all empirical, and 4 fps / 8× is a starting hypothesis rather than a known-good answer.
- **`video-720p` is mandatory for every video.** Playback from an archive tier is impossible, so a video whose preview is missing is a video you cannot watch for 48 hours. The ladder-complete gate (§5.2) enforces this.
- **§3.1.1's max-size semantics apply here on two axes**, and matter more than for stills because video transcodes are lossy in both directions. Resolution and bitrate are both maxima: a transcode is `min(source, class max)` on each. A 480p 800 kbps clip therefore yields no separate `video-720p` — both axes would be unchanged, so the output would be a same-size re-encode and the original *is* its `video-720p`, played directly. Old phone footage and screen recordings are the common cases, and there are usually a lot of them. Note this also gives a 1080p source a `video-poster-screen` at 1,920 px, where a fixed-2560 class would have produced none.

**Codec: H.264 by default, WebM/VP9 as an option — but the choice is constrained by hardware encode, not by size.** Since derivation happens on-device (§4.1), the deciding fact is what the phone can encode in hardware: iOS VideoToolbox does H.264 and HEVC and has **no VP9 or AV1 encoder**; Android MediaCodec has universal H.264, but VP9 *encode* support is patchy across devices. **H.264 is the only codec both platforms can reliably hardware-encode**, which settles the default. VP9/WebM (~30–50% smaller) makes sense as an option for laptop- or cloud-derived content, where a software encoder is acceptable — worth having as a config knob, not as the default.

- **Progressive MP4, not HLS, below ~2 minutes.** For a 30-second clip, one cacheable object beats a manifest plus dozens of segments — HLS multiplies object count, CloudFront request count, and complexity for no gain. Segment only above a configurable duration threshold, where seek latency starts to matter.
- **`video-1080p` is off by default**, on the same "rare read, instant when needed" logic as `image-large`.
- Range requests work through the existing cache policy — CloudFront caches whole objects and serves ranges from them, and `queryStringBehavior: none` does not interfere. Worth an explicit test rather than an assumption.
- **At 2 TB scale `video-720p` is the largest single derived class by volume** (§5.4, Model C — 126 GB, more than every stills class combined). Under Intelligent-Tiering (§5.3.2) it is also the class I-T handles best: few objects, so the per-object monitoring fee is negligible, and large ones, so idle demotion to $0.004/GB-mo is worth a lot. It costs ~$0.58/mo at Model C rather than the ~$2.90 it would cost in Standard. The remaining knob for a video-heavy library is `video-720p` bitrate, not its storage class.

### 3.4 The visual test — a gate, not a follow-up

Every long edge and quality level in §3.1 and §3.3 is a hypothesis. They are individually defensible and collectively unverified, and the failure mode is bad in a specific way: a quality level that is 5% too low is invisible on the sample you happened to look at and permanent across 60,000 photos, because the originals are in Deep Archive by the time anyone notices. **The sizes and quality levels are not final until this test has been run, and the ladder-derivation work (Phase 1) should not backfill the library before it has.**

What the test has to establish, in order of how expensive it is to get wrong:

1. **Quality level per size class.** Encode a fixed sample at a range of quality settings around the proposed value and find the knee — the point below which artifacts become visible at the size the class is actually viewed at. Note that the right quality is *not* constant across sizes: artifacts hide more easily at 400 px than at 4272 px, so `image-thumb` can be pushed harder than `image-large`.
2. **Whether the long edges are right**, viewed on the real devices at real distances: the phone in hand, the laptop windowed and fullscreen, and the 4K TV. Specifically whether `image-medium` upscaled is acceptable as a phone fullscreen (§3.2's second open question) and whether `image-large` at 4272 is enough for the zoom case or whether zoom genuinely means restoring the original. Note this question now only concerns originals *above* 4,272 px — below that §3.1.1 gives every record a native-resolution `image-large`, so zoom never needs the original at all.
3. **AVIF vs JPEG/WebP at equal bytes**, at each size, including decode time on a mid-range Android — because §3.2's third open question and §11's AVIF-encode-cost risk are the same trade seen from two ends.
4. **The video parameters** — `video-skim` frame rate and speed factor, `video-720p` bitrate — which are guesses to the same degree (§3.3).

The sample must include the operator's own hard cases, not a stock test set: fine text (screenshots, documents, signs), foliage and other high-frequency detail, night and high-ISO shots where noise interacts badly with modern codecs, skin tones, smooth gradients (skies), and at least one Live Photo and one 4K clip. The output of the test is a table of final integers that replaces the provisional ones in §3.1 and §3.3.

This is deliberately not automated. Metrics like SSIM and VMAF are useful for *bracketing* the search, but the decision being made is what the operator finds acceptable in a library they will keep for decades, and that is an eyeball judgement.

---

## 4. When and where renditions are generated

### 4.1 The rule

**Derive at the first point where the bytes are resident, and never transfer an original twice.** In the steady-state capture flow that point is the phone: at ingest the original is already local, so derivation costs no egress, no Lambda invocation, no S3 GET, and no archive thaw. The phone and laptop also have hardware HEIC/HEVC decoders, which is the *only* place HEIC decoding currently works at all (finding 13).

The rule is phrased about *residency* rather than *capture* deliberately, because bulk re-homing (§4.5) is a first-class flow where the bytes first land somewhere else entirely.

**Sync renditions before originals.** The `image-thumb` and `image-medium` classes total ~130 KB against a 3 MB HEIC. Pushing them first means the library is browsable on every other device within seconds of capture, while the original uploads in the background. This is a scheduling change in the sync supervisor, not a protocol change.

### 4.2 What happens when a node can't or doesn't derive

**Dropping `needs-derivation`.** An earlier draft marked the record and left the question of who acts on the mark unanswered, which is the wrong shape twice over. First, a shared mutable "somebody please fix this" flag on a record is an invitation to duplicate work: two nodes that both see it and both derive produce *two* child records, because AVIF encoders are not bit-identical across platforms and the results are therefore different content-addressed keys. Deduplicating that after the fact is much harder than never creating it. Second, the flag is redundant — a missing size class is not a hidden state, it is the absence of a child record with `photos/rendition=<class>`, which is exactly the query the `parentId` filter (§4.4) makes cheap. **Derivation state is a query, not a field.**

What actually needs deciding is *who is responsible*, and the answer is a fixed two-step ownership rule with no coordination protocol, no lease, and no marker.

**1. The originating node owns derivation, indefinitely.** The node that ingested the original is recorded on the record and is the only node that derives from it, for as long as it exists. If it cannot right now — low battery, thermal throttling, offline, no codec for the format, or simply not scheduled yet — it retries later, from a node-local work queue. Nothing else in the system needs to know or do anything. This is the overwhelmingly common case and it self-heals with no cross-node state.

Two existing rules keep this safe rather than merely hopeful: a locally-captured original may not be released until it is confirmed durable elsewhere (§7.2.1), and — extending that — **may not be evicted while it still owes applicable size classes**, since evicting it would destroy the only input. A phone that is behind on derivation holds bytes; that is visible in the residency inspector (§7.6) and counts against its budget (§7.2).

**2. The cloud is the fallback, and it is a singleton.** If a record's ladder is still incomplete after a timeout (default 24 hours) and the original is in the cloud, a scheduled sweeper hands it to the derivation Lambda. Because the fallback is one actor, there is no contention and therefore no lease. The sweeper's query — "records whose applicable size classes are not all present" — is the same query the ladder-complete gate already needs (§5.2), so this is one mechanism serving two purposes rather than new machinery.

**The cloud fallback is guaranteed to be *possible*, which is the point.** The archive transition is gated on ladder completeness (§5.2), so an original with a missing size class is by construction still in S3 Standard. The fallback therefore never needs a thaw — it pays one S3 GET and one Lambda invocation. The gate and the fallback close a loop: the thing that would make the fallback expensive is the thing the fallback is a precondition for.

**Explicitly rejected: peer catch-up by pulling the original down.** An earlier draft had another node fetch the original and derive it. That is the one option that violates §4.1's rule — it transfers an original specifically in order to derive from it, paying full egress and full device storage to save a Lambda invocation that costs a fraction of a cent. **A node may only derive from bytes it already holds.** In practice that collapses "peer catch-up" into case 1: a laptop that derives is a laptop that ingested, which is the backfill flow (§4.3), not a separate mechanism.

**Two cases where the fallback cannot reach, and what happens instead:**

- **`no-cloud` records** (§7.2.2) have no cloud original by construction, so responsibility can never leave the local nodes. Such a record simply stays ladder-incomplete until its originating node catches up, is never archived (there is nothing to archive to), and is never evictable. This should be surfaced, not silent: a `no-cloud` record with an incomplete ladder and one replica is the highest-risk state in the system and belongs in the residency inspector.
- **Formats the cloud cannot decode.** Until the custom libvips build exists (§8.1), the cloud fallback covers JPEG, PNG, WebP and AVIF only — not HEIC, and not raw. For those, ownership stays with the originating device permanently and the 24-hour sweeper will find the same records every day. Two consequences worth stating plainly: the sweeper must not retry a format it cannot handle in a loop (record the attempt outcome per record), and **the cloud fallback is not a real fallback for the operator's primary capture format until §8.1 lands**. That upgrades the custom libvips build from "deferrable" to "the thing that makes §4.2 true".

### 4.3 Backfill

The existing library is a one-time batch job on the laptop, reading originals from local object storage (which are symlinks to the watched files — `packages/sdk/src/sdk.ts:213`, so no byte duplication) and writing renditions. It should be resumable, rate-limited, and it should push renditions to the cloud as it goes so the archive transition can begin on the oldest material immediately.

For video backfill, on-device ffmpeg with VideoToolbox is free and fast. If cloud transcode is wanted instead, MediaConvert basic-tier 720p runs roughly $0.0075/min — ~$11 one-time for 25 hours of source. Not a reason to build cloud transcode, but not a blocker either.

### 4.4 Where renditions live in the data model

**Decided: renditions are shared image records** (as thumbnails are today), with three fixes. This is no longer a fork to confirm.

The reasoning is about what Photos is rather than about record hygiene. Photos is the flagship app; a user keeping their photos on Starkeep is expected to be using it and to have opted into its storage model. Under that premise the renditions are not Photos' private cache — they are *the accessible form of the library*, and after §5 they are the only instantly-readable form, because the originals are in Deep Archive. An app that could see originals but not renditions would hold a grant it cannot usefully exercise. Any other app that works with photos will therefore want the renditions, and gets them by the same mechanism Photos uses: `photos/rendition=<class>` is an ordinary label, readable by anything with an `image` grant, and an app that wants originals only, or `image-thumb` only, filters on it.

This also preserves the settled position that derived image bytes are app-written shared records rather than a platform concern. The rejected alternative — moving renditions into Photos' app-specific filespace (`apps/photos/syncable/...`) — would keep `shared.records` smaller and make renditions die on uninstall, but it forfeits exactly the cross-app property above and does not solve the sync-volume problem anyway (§7.2 does that, by making residency per size class).

Two consequences to accept rather than paper over. Renditions **outlive Photos' uninstall**, like any other shared data — correct under the premise above, since they remain the readable form of the library for whatever app comes next, but it does mean uninstalling Photos does not reclaim their space. And the label namespace is `photos/`, which is a little odd for data other apps are expected to consume; that is a naming question for whenever a second image app actually exists, not a reason to change the storage model now.

The three fixes:

1. **Replace the `thumbnail` bare flag with `photos/rendition=<class>`** — a single-valued label written through `POST /data/labels/values` (the set-valued write that upserts and tombstones the rest, per `system-design.md`). Values: `image-thumb`, `image-medium`, `image-screen`, `image-large`, `video-poster-thumb`, `video-poster-screen`, `video-skim`, `video-720p`, `video-1080p` and `image-motion`. There is no `native` value — §3.1.1 removed it, because under max-size semantics an original is never a record's top rung. `crop` stays as it is — it is a user artifact, not a rendition.
2. **Add a `parentId` filter to `/data/records`**, combinable with `label`/`labelValue`. "The screen rendition of X" becomes one indexed query. This deletes finding 4's O(library) scan outright, and is also what makes derivation state a cheap query rather than a stored flag (§4.2).
3. **Add a negated-label filter** (or an `originals-only` flag) so the grid can page originals server-side. Without it, a 60k-photo library becomes 300k+ records and the grid's paging is meaningless.

---

### 4.5 Bulk re-homing — local-first only, deliberately under-designed

Migrating an existing library from another service is a distinct flow from capture, and for most users it is the *first* thing that happens. It changes less of this plan than it might appear: the ladder, the residency policy, the archive gate, and the storage-class mapping are all untouched. Only **who runs the deriver** changes, which is why §4.1 is phrased about residency rather than capture.

**Decision: assume the user downloads to a local machine, and stop there.** Server-side fetch of a remote library (Takeout hosted on Drive, Dropbox, a generic URL) was analysed and **deferred**. The reasoning is short: the marginal AWS cost of cloud-first is a few dollars on a one-time operation, so the only thing it buys is wall-clock time by taking home upstream off the critical path — and it costs a custom libvips build (HEIC is undecodable in the cloud without it, §8.1), cloud-side OAuth custody, and streaming archive extraction. Not worth it before we know the shape of the problem.

**And we do not yet know that shape.** The right next step is to run the app against a real phone library (§7.6) and only then look at what Google Takeout actually produces. Designing the Takeout parser now would be designing against a guess. What is worth recording now is only what is already known:

- **`GoogleImportPanel` is dead code** (`photos/src/photos-ui/components/google/google-import-panel.tsx`). It calls `/api/google/albums`, `/api/google/list`, `/api/google/import`; `app/api/google/` does not exist. It is exported from `photos-ui/index.ts` but nothing renders it, and it targets the Photos Library API, whose general read scopes Google withdrew in March 2025. Delete it rather than treat it as a starting point.
- **Takeout is known to be awkward** — per-item `.json` sidecars carrying metadata the API strips (GPS especially), mangled filenames, Live Photos split into `.HEIC`/`.MOV` pairs, Motion Photos as single files. Enumerate the real damage against a real export, not from memory.
- **Import must be resumable** — per-item, content-hash keyed, restartable, with its own tracking table in the shape of the watcher's `watch_files`. A monolithic multi-hour import that dies at 80% is the likeliest bad outcome and the one worth engineering against.

#### Deduplication — the round-trip problem

A specific and very likely case: a photo is captured on the phone and syncs to Starkeep; the same photo also lands in Google Photos; later a Takeout import brings it back. **Starkeep must not end up with two records for one photo.**

Content hashing alone does not solve this. It catches the byte-identical case, but Google re-encodes under "Storage saver", may transcode HEIC to JPEG on export, and rewrites metadata — so the returning file frequently has different bytes for the same picture. Three tiers, cheapest and most certain first:

| Tier | Signal | Catches | Cost |
|---|---|---|---|
| 1 | **SHA-256 content hash** | byte-identical re-import | free — keys are already content-addressed |
| 2 | **Capture fingerprint** — EXIF `DateTimeOriginal` (to the second) + `ImageUniqueID` where present, else camera make/model + native dimensions | metadata-rewritten but un-re-encoded copies | free — every input is already an image-metadata column |
| 3 | **Perceptual hash** of the `image-thumb` class | re-encodes, quality changes, resizes | one cheap computation during derivation |

Tier 1 gives blob-level dedup for free today, but **record-level dedup is separate and does not exist** — nothing stops two records pointing at one object key. That gap has to be closed regardless of import.

Tiers 2 and 3 are both **deterministic from the file**, so by `system-design.md`'s own test they belong in **per-category image metadata**, not in labels or app-specific data. That means two new columns in `IMAGE_METADATA_COLUMNS` (`perceptual_hash`, and the ThumbHash from §3.2) — a one-file edit in `core-types.ts`, and they become available to every image-granted app rather than just Photos.

**Resolution policy, given an append-only user who never deletes:**

- Tier 1 match → silently skip. Certain.
- Tier 2 or 3 match → **skip the import and keep the existing record**, because the phone-synced original is essentially always the better copy — Takeout returns a re-encoded descendant, not the source. Log it to a reviewable "skipped as duplicate" list rather than discarding silently.
- No match → new record.

The one thing not to do is auto-*delete* anything. Skipping an import is reversible; deleting a record the user already has is not.

**All three tiers need manual testing before they are trusted, and tier 3 needs it most.** The thresholds here are unvalidated in both directions and the two failure modes are asymmetric:

- A **false positive** — two genuinely different photos judged the same — silently discards a photo the user wanted. Burst sequences are the obvious hazard: ten frames a second apart, near-identical composition, identical `DateTimeOriginal` to the second, and perceptual hashes within a hair of each other. That is tier 2 and tier 3 both firing on photos that are all wanted. The resolution policy's "skip and log" makes this recoverable rather than destructive, which is precisely why it is written that way, but a reviewable list nobody reviews is not much better than a deletion.
- A **false negative** just leaves a duplicate, which is annoying and fixable later.

So the test is: run a real Takeout export against a library that already contains the same photos synced from the phone, and measure both rates directly. Specifically — bursts and panorama sequences (false-positive risk), Live Photo pairs split by the export, HEIC re-encoded to JPEG by Storage Saver, edited versions alongside their originals (which *should* be treated as distinct), and screenshots, which are numerous, visually repetitive, and lack most EXIF. The perceptual-hash distance threshold in particular should be chosen from the measured distribution on the operator's own library, not from a published default.

Until that has been done, the safe default is to run tiers 2 and 3 in **report-only** mode — log what they would have skipped, import everything — so the first real import produces the calibration data instead of consuming it.

## 5. Storage: cloud

### 5.1 Storage class: declared as intent, applied at PUT, reported per record

Storage class needs three separate things, and an earlier draft conflated them into one:

1. a way for the *writing* app to say what a blob is for,
2. a mechanism that gets S3 to act on that, and
3. a way for every *reading* app to find out what state a blob is actually in — which is the part that was missing, and the part that keeps an app from thawing the archive by accident.

#### The write side: apps declare intent, not S3 classes

Content-addressed keys (`shared/<category>/<shard>/<hash>`) carry no size-class information, and splitting the key space would break both the `shared/*` CloudFront behavior and the shared-data invariant.

**The app declares an intent at PUT time**, from a small platform-defined vocabulary that says nothing about AWS:

| Intent | Meaning to the app | Maps to |
|---|---|---|
| `instant` *(default)* | must be readable now, at normal latency, whenever it is read | S3 Intelligent-Tiering, automatic tiers only |
| `archive` | may be unavailable for up to 48 hours when read | S3 Glacier Deep Archive |

Photos maps its size classes onto that: **every rendition class → `instant`**; `original` → `archive` (subject to the gate in §5.2 and the floors below). Another app storing images can express "this must be readable" or "this is a cold master" without knowing what Glacier is, and the platform can change the AWS mapping — or an installation can override it — without touching any app.

**Two intents, not three.** An earlier draft had `hot` (→ Standard) and `cool` (→ Glacier IR) as separate declarations, and required each app to decide per blob which of its data was which. §5.3.2 replaces both with Intelligent-Tiering, which makes that decision per *object* and per *month* rather than per class and once, so the distinction the app was being asked to draw no longer buys anything. Deleting `cool` removes a decision from every app that stores bytes, and it removes the ladder's most fragile coupling: under the old scheme, if §3.4's visual test moved `image-medium` from 110 KB to 140 KB the right intent for that class would flip, and under this one nothing changes.

**Mechanically it is a storage class on the PUT for `instant`, and a tag for `archive`.**

- `instant` → the presigned PUT carries `x-amz-storage-class: INTELLIGENT_TIERING`. The object lands in I-T directly. **No tag, no lifecycle rule, no transition request, and nothing to reconcile** — this is the cheap path and it is the one almost every object takes.
- `archive` → the presigned PUT carries `x-amz-tagging` with `starkeep:intent=archive`; a lifecycle rule transitions objects carrying that tag **and** `starkeep:ladder=complete` to Deep Archive, subject to the §5.2 minimum hold.

Two platform changes are needed on the presign path: allow the `x-amz-storage-class` header, and allow the `x-amz-tagging` header. Both ride alongside the `x-amz-checksum-sha256` change §7.2.1 already requires.

**The bucket's I-T configuration must leave the asynchronous archive tiers off.** That is the AWS default — Archive Access and Deep Archive Access are opt-in via an `IntelligentTieringConfiguration` — so the requirement is that we never add one. It is load-bearing rather than incidental: with only the automatic tiers (Frequent Access → Infrequent Access at 30 days idle → Archive Instant Access at 90 days idle), every tier is millisecond-latency, so `availability` (§5.1.1) is `instant` for every rendition at all times, no rendition can ever require a restore, and §7.4's slideshow constraint cannot be violated by a storage transition. Enabling the async tiers would reintroduce exactly the hazard the rest of §5.1 exists to prevent.

**Tags are not free, which is now mostly moot.** The Price List API gives object tagging at **$0.00000065 per tag-month** — $0.0065 per 10,000 tags per month, an ongoing charge rather than one-time. Under the two-intent scheme **only originals are tagged**, which is roughly one object in five once the ladder exists: ~$0.12/mo at the 2 TB model against ~$0.23 under the earlier scheme and ~$0.55 if everything were tagged. The reason to care is no longer the money but that a tag is state which can disagree with reality; having renditions carry none removes them from §5.1.1's reconcile entirely.

**Two floors, both meaning "do not archive it".** Do not archive originals below ~1 MB — Glacier Flexible and Deep Archive add 40 KB of billable overhead per object, so a 200 KB original costs more archived than it does left alone. And do not archive an original that is functionally the top of its own ladder (§3.1.1). Where the two disagree, the stricter wins. An original that fails either floor is written `instant` like a rendition, and I-T then manages it on the same idle schedule as everything else — which is a better outcome than the earlier scheme's "stays in Standard forever".

#### 5.1.1 The read side: availability is a field on the record

A declared intent is invisible: it lives on the S3 object as a storage class or a tag, is not returned by any current API, and in any case describes what was *asked for*, not what is true now — a `RestoreObject` in flight, a lifecycle transition that has not fired yet, and a `no-cloud` record are all states the tag does not describe. Meanwhile the concrete hazard is real and cheap to hit: a photo-adjacent app iterating a library and fetching bytes per record can trigger tens of thousands of restores and a four-figure bill, having done nothing wrong except read records the platform handed it.

**So availability is a first-class field on the record, returned by `/data/records` alongside everything else** — no extra request, no separate endpoint, nothing to opt into:

| Value | Meaning |
|---|---|
| `instant` | readable now, at normal latency |
| `restoring` | a restore is in flight; includes an estimated ready-at |
| `archived` | requires an explicit restore; includes the tier and its expected latency |
| `absent` | this node does not hold the bytes (an `Elided` record, §7.1) |

Three properties make this work rather than merely exist:

- **It is reported by whichever data server you asked**, about *its own* storage. The same record is `instant` on the laptop and `archived` in the cloud, which is correct and is the same shape as residency (§7.1) — availability and residency are the same question asked of different nodes.
- **Reads of an archived object fail loudly and never restore implicitly.** A presign or GET against an `archived` key returns `409` with the tier and expected latency, never a silent `RestoreObject`. Restores happen only through an explicit `POST /data/records/{id}/restore`, which returns the estimated cost and time before doing anything, and which is rate- and volume-limited per app. This is the actual guardrail; the field is what lets a well-behaved app avoid hitting it in the first place.
- **It is maintained, not computed on read.** Per-record `HeadObject` is O(library) per listing and would repeat finding 4's mistake. Instead the cloud data server stores it and updates it from two sources: **S3 Event Notifications** (`LifecycleTransition`, `ObjectRestore:Completed`, `ObjectRestore:Delete`) for prompt changes, and a **daily S3 Inventory** report as the reconciling backstop. Inventory prices at $0.0025 per million objects listed — a daily report over the operator's ~315k objects is about **$0.02/mo**, which makes correctness-by-reconciliation affordable enough not to argue about.

For Photos specifically this mostly disappears into the ladder: every rendition class is `instant` by construction and, because §5.3.2 leaves I-T's async tiers off, provably stays that way for its whole life — no rendition can ever report anything but `instant`. The field matters at the edges — the restore flow (§5.3), the residency inspector (§7.6), and any app that was not written with this ladder in mind, which is the case actually worth defending against.

**This is also the mechanism §7.4 needs.** A slideshow generator that reads `availability` cannot accidentally thaw 500 originals; without it, "don't do that" is a comment in a design document.

### 5.2 The archive gate: verified, not aged

The operator's instinct is to archive originals immediately, and the economics agree — but "immediately" needs a precise trigger, because archiving an original whose renditions are incomplete means a 48-hour thaw to finish the job.

**Gate on durability, not on age.** When every *applicable* size class for a record (§3.1.1) is confirmed present in the cloud, tag the original `starkeep:ladder=complete`. A lifecycle rule transitions tagged originals to Deep Archive. Until it fires the original sits in Intelligent-Tiering like everything else, so a ladder-incomplete original is always instantly readable — which is what makes §4.2's cloud derivation fallback free of thaws.

**And hold for a minimum of 7 days before transitioning, regardless.** This was worth checking rather than assuming, because it hinges on whether waiting costs anything:

**Does the transition itself cost money? Yes — but the cost is fixed and does not depend on how long you waited.** Two charges, both verified against the Price List API for us-east-1, both one-time and per-object:

- **Lifecycle transition request to Deep Archive: $0.05 per 1,000 objects** (`Requests-Tier3` / `S3-GDATransition`). For comparison: $0.03/1,000 to Glacier Flexible, $0.02/1,000 to Glacier IR, $0.01/1,000 to Standard-IA.
- **Deep Archive checksum-computation fee: $0.004/GB** on bytes transitioned (`Compute-Checksum-Processed-GDA-Bytes`).

For the operator's 500 GB / ~63k originals that is $3.15 + $2.00 = **$5.15, once**. Waiting a week changes neither number. The only cost of delay is holding those bytes in Intelligent-Tiering meanwhile, and on an append-only library that is a *rolling window* rather than the whole library. Objects newer than 30 days sit in I-T's Frequent Access tier at the Standard rate, so the delay is priced at $0.023/GB-mo: at ~100 GB/yr, a 7-day window is ~1.9 GB, or about **$0.04/month**. A 30-day window is ~8.2 GB, about **$0.19/month**.

So the answer to "should we always hold for at least a week" is yes, unambiguously — it buys a week to catch a derivation bug before the input is behind a 48-hour thaw, and it costs four cents a month. **Default 7 days, configurable, and 30 is a defensible setting for anyone who wants more margin.** One thing the delay does *not* protect against is the 180-day minimum storage duration once an object has transitioned: an object archived and then re-transitioned or deleted inside 180 days is billed pro-rata for the remainder. Append-only makes that moot, which is another reason the hold is the right place to put the caution.

Gating on durability is strictly better than a fixed 30- or 90-day rule: with the floor it archives at the earliest safe moment and never before, rather than at an arbitrary one. And note the loop it closes with §4.2 — because incomplete-ladder originals stay in Standard, the cloud derivation fallback never needs a thaw.

### 5.3 Which archive tier

All prices in this section and §5.4 were pulled from the **AWS Price List API for us-east-1** (`aws pricing get-products --service-code AmazonS3`) rather than recalled, and several earlier figures in this document were wrong as a result. Corrections are called out below.

| | $/GB-mo | Retrieval (bytes) | Retrieval (requests) | Latency | 500 GB/mo |
|---|---|---|---|---|---|
| Standard | $0.023 (first 50 TB) | — | — | ms | $11.50 |
| Standard-IA | $0.0125 | $0.01/GB | — | ms | $6.25 |
| Glacier IR | $0.004 | $0.03/GB | — | ms | $2.00 |
| Glacier Flexible | $0.0036 | bulk **$0.00**, std $0.01, exp $0.03 | bulk **free**, std $0.05/1k, exp $0.01 **each** | 5–12 h | $1.80 |
| Deep Archive | $0.00099 | bulk $0.0025, std $0.02 | bulk **free**, std $0.05/1k | 12–48 h | $0.50 |

**Recommendation: Deep Archive, unchanged.** The ladder covers every interactive path, so the archive is only touched for print, export, and editing — rare, and none of them latency-sensitive in a way 48 hours breaks. The gap to Flexible is only $1.30/mo at 500 GB but scales linearly on an append-only library. Glacier Flexible remains the sensible middle setting for someone unwilling to wait two days.

**The restore flow needs to be a real feature, not an error path:** request → `RestoreObject` → poll → notify → serve, with the restored copy held for a configurable window (7 days) so a print session doesn't re-thaw.

### 5.3.1 Reference: what Deep Archive retrieval actually costs

Reference material, not a plan change.

**Retrieval tiers.** Deep Archive offers two; there is no Expedited tier (that is Glacier Flexible only):

| Tier | Latency | Data | Restore requests |
|---|---|---|---|
| Standard | within 12 h | $0.02/GB | $0.05 per 1,000 |
| Bulk | within 48 h | $0.0025/GB | **free** |

> **Corrections to earlier drafts.** Bulk restore requests are **free**, not $0.025/1,000; Standard restore requests are **$0.05/1,000**, not $0.10. Lifecycle transitions are **$0.05/1,000** to Deep Archive, **$0.03/1,000** to Glacier Flexible, **$0.02/1,000** to Glacier IR, and $0.01/1,000 to IA — an earlier draft flattened these.

**Mechanics that are easy to miss.**

- `RestoreObject` does not move the object — it creates a **temporary readable copy**. During the window **you pay for both**: the Deep Archive copy at $0.00099/GB-mo *and* the restored copy, billed as **Glacier staging storage at $0.021/GB-mo** (a distinct line item, not S3 Standard).
- The restored copy is read with ordinary GETs — for Deep Archive, $0.004 per 10,000 — plus egress.
- **CloudFront cannot serve an unrestored object.** The origin fetch returns `InvalidObjectState`. This is precisely why §3's full ladder sits in front of the archive.
- Deep Archive charges a **checksum-computation fee of $0.004/GB** on bytes processed — one-time on transition, and not trivial: $2 per 500 GB.
- Each archived object carries 40 KB of billable overhead (8 KB at Standard rates, 32 KB at the archive rate). Irrelevant for 3–80 MB originals; it is why §5.1 sets a ~1 MB archive floor.
- Minimum storage duration is 180 days, pro-rata on early deletion. Moot for an append-only library.
- Bulk restores of many objects are better issued through S3 Batch Operations ($0.25/job + $1.00 per million operations).

**Worked examples:**

| Scenario | Bulk (48 h) | Standard (12 h) |
|---|---|---|
| One 30 MB ProRAW, for printing | $0.000075 | $0.00065 |
| One year of originals — 100 GB / ~12k objects | $0.25 + $0 = **$0.25** | $2.00 + $0.60 = **$2.60** |
| The entire library — 500 GB / ~63k objects | $1.25 + $0 = **$1.25** | $10.00 + $3.15 = **$13.15** |

Add staging storage for the retention window (100 GB for 7 days ≈ $0.49; 500 GB ≈ $2.45), plus egress if the bytes leave AWS.

**Two observations worth carrying around** — the third from an earlier draft was wrong and is withdrawn:

1. **For single-item restores, use Standard, not Bulk.** The difference is six hundredths of a cent and it saves 36 hours. The "always bulk" instinct is wrong at small scale.
2. **Getting everything back out is dominated by egress, not by Glacier.** A full 500 GB extraction is $1.25 of retrieval against ~$45 of data transfer out. If the lock-in question is ever asked, the honest answer is about $46 and two days, and almost none of it is the archive tier's fault.

> ~~*Request cost dominates for many small objects.*~~ **Withdrawn.** This was based on a wrong restore-request price. Bulk restore requests are free, and at Standard they are ~23% of the bill, not the majority. The ~1 MB archive floor still stands, but on the 40 KB per-object overhead alone.

### 5.3.2 Intelligent-Tiering — chosen for every rendition class

**Decided: all renditions are written to Intelligent-Tiering with the asynchronous archive tiers left off. Originals stay on the explicit Deep Archive path (§5.2), unchanged.** This reverses an earlier draft of this section, which priced I-T and rejected it. The reversal is worth explaining, because the earlier arithmetic was not wrong — it was answering a different question.

All figures below are from the Price List API for us-east-1.

| I-T tier | $/GB-mo | Reached after | Retrieval fee | Latency |
|---|---|---|---|---|
| Frequent Access | $0.023 | (default) | — | ms |
| Infrequent Access | $0.0125 | 30 days idle | **none** | ms |
| Archive Instant Access | $0.004 | 90 days idle | **none** | ms |
| Archive Access *(opt-in — **we do not enable this**)* | $0.0036 | 90+ days idle | none | 3–5 h |
| Deep Archive Access *(opt-in — **we do not enable this**)* | $0.00099 | 180+ days idle | none | 12 h |

Plus **$0.0025 per 1,000 objects per month** in monitoring and automation (`Monitoring-Automation-INT`).

#### What the earlier rejection got wrong

It modelled I-T **with both opt-in archive tiers enabled**, and two of its three objections were objections to *those tiers specifically*:

- *"An object's retrieval latency changes silently, on a schedule we do not control."* True of Archive Access and Deep Archive Access. **Not true of the automatic tiers**, which are all millisecond. With the async tiers off, every rendition is `instant` in §5.1.1's sense at every moment of its life, and no rendition can ever need a restore.
- *"I-T cannot reach Deep Archive economics for six months."* True, and irrelevant — we are not asking it to. Originals go to Deep Archive through §5.2's explicit gate at 7 days. I-T is being asked to manage the renditions, whose floor is Archive Instant Access at $0.004/GB-mo, reached at 90 days idle.

The third objection — paying per object per month to have S3 discover access patterns we designed — is real and survives. It is answered below rather than dismissed.

It also missed a price. **GIR charges $0.01 per 1,000 GET requests; I-T charges $0.0004 per 1,000, identical to Standard** (`Requests-GIR-Tier2` vs `Requests-INT-Tier2`). For a ladder whose defining access pattern is many small objects fetched by a scrolling grid, a 25× request surcharge is not a rounding difference: one cold pass over 60k `image-thumb` objects costs $0.58 in GIR request charges alone.

#### Why it fits this ladder specifically

**I-T applies the 128 KB boundary itself.** Objects under 128 KB are neither monitored nor transitioned, are **not charged the monitoring fee**, and stay at the Frequent Access rate, which is the Standard rate. So `image-thumb` (20 KB), `image-medium` (110 KB) and `video-poster-thumb` (20 KB) cost exactly what they cost today and are simply left alone.

That is the property that decides this. Every archive tier bills small objects punitively — Glacier IR bills a 128 KB minimum, so `image-thumb` at 20 KB costs *more* in GIR than in Standard, and `image-medium` at 110 KB saves $0.12/mo before retrieval charges. Under an explicit-class policy, avoiding that means a per-class judgement about which rungs are big enough and cold enough to demote, revisited every time the ladder changes. Under I-T the question does not have to be asked: **write everything to I-T and AWS applies the boundary per object.**

#### The comparison, at Model B

| Class | Standard | Glacier IR | Intelligent-Tiering |
|---|---|---|---|
| `image-thumb` | $0.026 | $0.068 | **$0.026** |
| `image-medium` | $0.145 | $0.068 | $0.145 |
| `image-screen` | $0.461 | $0.119 | $0.239 |
| `image-large` | $1.053 | $0.222 | $0.353 |
| `video-poster-thumb` | $0.001 | $0.003 | $0.001 |
| `video-poster-screen` | $0.023 | $0.006 | $0.012 |
| `video-skim` | $0.010 | $0.004 | $0.009 |
| `video-720p` | $0.368 | $0.066 | $0.078 |
| **Total** | **$2.09** | **$0.56** | **$0.86** |

GIR columns include the intent tag; I-T columns include the monitoring fee and assume ~95% of an append-only library is past the 90-day idle mark. **GIR is $0.31/mo cheaper at Model B — but only at zero reads.** Solving for the read volume at which I-T becomes cheaper, given GIR's $0.03/GB retrieval plus its request surcharge:

| Class | I-T beats GIR above |
|---|---|
| `video-720p` | **33 plays/month** |
| `video-poster-screen` | 283 reads/mo |
| `video-skim` | 400 reads/mo |
| `image-large` | ~3,400 reads/mo (~114/day) |
| `image-screen` | ~5,700 reads/mo (~189/day) |

**The video classes are not close.** Thirty-three video plays a month is a bar any real library clears, and the reason is structural: video classes have few objects (so per-object monitoring is nearly free) and large ones (so per-GB retrieval is expensive). The two big stills classes are a genuine judgement call about browsing volume, and at Model C the bar rises to ~534 `image-screen` reads a day because monitoring scales with object count while retrieval scales with bytes read.

#### Why take I-T anyway, given GIR is cheaper on paper

Four reasons, each worth more than $0.31/mo:

1. **It removes the decision instead of making it.** No per-class size analysis, no `cool` intent to assign, no per-class lifecycle rule — and nothing to redo when §3.4 replaces the provisional byte sizes with measured ones. If `image-medium` comes out of the visual test at 140 KB rather than 110 KB, the correct Glacier answer for that class flips and the I-T answer does not change at all. Given that §3.4 has not been run, adopting a policy whose correctness depends on unmeasured byte sizes is adopting a policy we cannot yet know is right.
2. **I-T's cost is a ceiling; Glacier's is a floor.** The GIR bill responds to browsing, to a new device syncing its rendition set, to an AI catch-up scan (§6.2 reads `image-medium` for every item), and to the future slideshow (§7.4). §5.1.1 exists precisely so that reads do not surprise the bill; putting the interactive classes on a retrieval-metered tier reintroduces a milder version of the thing that section defends against.
3. **The one-way trap disappears.** A lifecycle transition to Glacier is permanent — an album that becomes interesting again, or a face the user starts searching for, stays retrieval-metered forever. I-T promotes an object back to Frequent Access on access, free.
4. **Renditions stop carrying tags at all**, which removes them from §5.1.1's reconcile and removes a class of state that can disagree with reality.

**The surviving objection, answered honestly.** Paying per object per month to have S3 discover access patterns we designed is philosophically backwards, and the monitoring fee is a real line — $0.32/mo at Model B, $0.96/mo at Model C, the second-largest item in the bill. The answer is that the fact we "already have" is a fact about *classes*, and what monitoring buys is per-*object* recency, which no class name can express. The ladder knows that `image-screen` is read less often than `image-thumb`; it cannot know which 5% of `image-screen` objects are the ones actually being read this month, and that is precisely the distinction worth $0.019/GB-mo.

**Where this should be re-examined.** Model C's monitoring fee is 19% of the bill and grows with item count rather than bytes, so a library with very many very small items is the case where an explicit policy could win. §10's CUR work is what settles it against a real bill; the `cool` → Glacier IR mapping is retained as a per-installation override for exactly that case, even though no intent maps to it by default.

### 5.4 Cost model — three library sizes

Modelled at three scales, since the right answer differs by size. **Prices are API-verified us-east-1 list; the derived byte sizes per class are estimates and are the weakest input here — §3.4's visual test is what replaces them with measurements.**

| | **A — light** | **B — the operator** | **C — heavy** |
|---|---|---|---|
| Originals | 50 GB | 500 GB | 2 TB |
| Stills | 7,000 | 60,000 | 170,000 |
| Video clips | 1,000 (~30 s) | 3,000 (~30 s) | 15,000 (~45 s, 4K-heavy) |

**Derived volume** (`image-thumb` 20 KB, `image-medium` 110 KB, `image-screen` 350 KB, `image-large` 950 KB, `video-poster-thumb` 20 KB, `video-poster-screen` 350 KB, `video-skim` 150 KB, `video-720p` 5.6 MB per 30 s):

| Size class | I-T behaviour | A | B | C |
|---|---|---|---|---|
| `image-thumb` | under 128 KB — unmanaged, Standard rate | 0.14 GB | 1.2 GB | 3.4 GB |
| `image-medium` | under 128 KB — unmanaged, Standard rate | 0.77 GB | 6.6 GB | 18.7 GB |
| `video-poster-thumb` | under 128 KB — unmanaged, Standard rate | 0.02 GB | 0.06 GB | 0.29 GB |
| `image-screen` | monitored, drifts to AIA | 2.5 GB | 21 GB | 60 GB |
| `image-large` | monitored, drifts to AIA | 6.7 GB | 57 GB | 162 GB |
| `video-poster-screen` | monitored, drifts to AIA | 0.33 GB | 1.0 GB | 5.0 GB |
| `video-skim` | monitored, drifts to AIA | 0.2 GB | 0.5 GB | 2.3 GB |
| `video-720p` | monitored, drifts to AIA | 5.6 GB | 17 GB | 126 GB |

**Monthly cost.** Monitored classes are priced at a blended **$0.0046/GB-mo** — the mix of Frequent Access (0–30 days), Infrequent Access (30–90) and Archive Instant Access (90+) that an append-only library growing ~100 GB/yr settles into, which is roughly 95% AIA. Unmanaged classes are priced at the Standard rate because that is literally what I-T charges them.

| | A | B | C |
|---|---|---|---|
| Under-128 KB classes (Standard rate, unmanaged) | $0.02 | $0.18 | $0.51 |
| Monitored classes (I-T, blended) | $0.07 | $0.44 | $1.63 |
| I-T monitoring fee | $0.04 | $0.32 | $0.96 |
| Originals (Deep Archive) | $0.05 | $0.50 | $2.03 |
| Object tags (originals only) | $0.01 | $0.04 | $0.12 |
| Inventory (§5.1.1) | $0.00 | $0.02 | $0.06 |
| **Proposed total** | **$0.19** | **$1.51** | **$5.32** |
| **Today (all Standard)** | **$1.15** | **$11.50** | **$47.10** |
| **Reduction** | **6.1×** | **7.6×** | **8.9×** |

*(For reference, the earlier all-Standard-plus-GIR-for-`image-large` policy came to $0.30 / $1.88 / $7.83. Adopting I-T saves a further ~$0.11 / $0.37 / $2.51 per month and deletes the `cool` intent. `image-large` is priced at 950 KB rather than 800 KB because §3.1.1 raised its maximum to 4272 and made it native-resolution for anything below that; the ~$0.04–0.12/mo this adds is the entire cost of closing the 12 MP master gap.)*

One-time transition cost — Deep Archive lifecycle requests plus its $0.004/GB checksum fee, on originals only: **A ≈ $0.60, B ≈ $5.15, C ≈ $17.** Renditions are written directly into I-T, so they incur **no** transition request and no transition checksum fee; this is $1.20 / $3.66 / $10 cheaper than a lifecycle-based scheme at the three scales.

**What the three scales actually teach:**

1. **Below ~100 GB, none of this matters financially.** Model A saves about a dollar a month. The archive machinery is justified at small scale only by the *latency* and *device-storage* benefits, not the bill — which is an argument for the ladder and residency work being independently valuable, and for archive tiering being a knob rather than a default at that size. I-T is the exception: it costs nothing to adopt and needs no per-class configuration, so it is the one part of §5 worth turning on even at Model A.
2. **At 2 TB `video-720p` is still the largest derived class by volume** — 126 GB, more than every stills class combined — but it is no longer the largest cost line, because it is exactly the shape I-T handles best: few objects, large ones. It costs ~$0.58/mo under I-T against ~$2.90 in Standard. The remaining lever for a video-heavy library is `video-720p` bitrate, not its storage class.
3. **The reduction now improves with scale rather than plateauing** — 6.4× → 7.8× → 9.1×, where the earlier policy sat flat around 6×. The reason is that I-T's benefit tracks *bytes* (which scale with library size) while its cost tracks *objects*, and the large classes are where the bytes are.
4. **The `image-medium` class costs about $0.15/mo at Model B** — a 10% increase on the total bill, in exchange for a 3× reduction in AI scan I/O, a usable fullscreen stage 1, and a correct share/export size. It is the cheapest thing in this document per problem solved. Note that it is unmanaged under I-T at 110 KB, so if §3.4 pushes it above 128 KB it becomes cheaper, not more expensive.
5. **The monitoring fee is now the item to watch, not the tag bill.** Tags fell to $0.04/$0.12 once only originals carry them; monitoring rose to $0.32/$0.96. Monitoring scales with object *count*, so it is the line that a library of very many very small items would stress — the case flagged for re-examination in §5.3.2 and measurable via §10's CUR work.


### 5.5 Route sync bytes through CloudFront

Finding 11 is a small change with a large payoff: sync downloads should request **CloudFront signed URLs** for `shared/*` instead of S3 presigned URLs. Same content-addressed keys, same signing infrastructure that already exists, same `shared/*` behavior. Benefits: lower per-GB price, a 1 TB/mo free tier that likely covers the operator entirely, edge caching that makes a second device's sync of the same object nearly free at origin, and one fewer credential path.

Uploads stay on presigned S3 PUT — CloudFront is not the write path.

### 5.6 Durability — an honest caveat

Deep Archive plus append-only plus "no device holds originals" means **the cloud bucket is the only copy of every original**. S3 Deep Archive is 11-nines durable against media failure, but it is one bucket in one account, and account-level loss, a credential compromise, or an errant lifecycle rule are not durability events S3 insures against. For an irreplaceable photo library that deserves naming: either one device keeps retaining originals (§7.2), or a second copy lives in another region or another provider. It costs money and it is the operator's call — but the plan should not quietly assume the risk away.

**Decided: S3 Object Lock in compliance mode plus versioning. Everything else is deferred.** An append-only library gives up nothing by taking a retention lock, it adds no storage cost, and it covers the two most probable failures — an errant lifecycle rule and a credential compromise. The other mitigations analysed here (replication to a second AWS account at ~$0.50/mo plus a one-time per-object charge; a second provider; keeping one device holding every original) are real answers to account-level loss, but they are separate decisions with recurring cost and none of them is a prerequisite for anything else in this plan. Revisit once the lock is in place.

Five implementation facts, because this one has sharp edges and the first is a hard sequencing constraint:

- **Object Lock can only be enabled when a bucket is created.** Turning it on for an existing bucket requires an AWS Support request. The files bucket is `aws.s3.BucketV2` in `cloud-data-server-program.ts:127`, so this is a one-line `objectLockEnabled: true` — but only for installs that have not happened yet. **It must land before anyone has a bucket worth protecting**, which is an argument for doing it early rather than with the rest of Phase 3.
- **Versioning is already on** for non-ephemeral installs (`cloud-data-server-program.ts:151`), and Object Lock requires it. That half is done.
- **It must ride `!ctx.ephemeral`, exactly like versioning does.** Compliance mode means objects cannot be deleted by anyone, including the account root, until retention expires — so an e2e bucket with compliance lock is a bucket that can never be torn down, and `forceDestroy` would fail permanently. The existing ephemeral guard is the right place and the right shape.
- **Compliance mode does not interfere with the lifecycle plan.** Object Lock blocks deletion and overwrite of a version; it does not block *transitions*, so originals still move to Deep Archive normally. It does block lifecycle *expiration*, which we do not use. Content-addressed keys also mean a re-PUT is semantically a no-op rather than an overwrite, so the append-only premise holds at the object layer too.
- **The retention period is the one real cost, and it should be finite.** Compliance retention cannot be shortened or removed by anyone, so anything written by mistake — a 6 GB accidental screen recording, or a photo the user later wants gone for privacy reasons — is undeletable and billable until it expires. The threat model here (an errant lifecycle rule, a compromised credential) is detected in days to weeks, not years, so **1 year is the recommended default** rather than the decade the append-only framing might suggest. Retention can always be extended; it can never be reduced. Note the honest consequence: "nothing is ever deleted" stops being a policy and becomes a fact enforced against the user as well as against an attacker.

**`no-cloud` records invert this caveat rather than escaping it** — there the device is the only copy. See §7.2.2 for the replica-count minimum that has to accompany the control.

---

## 6. Which sizes are served to whom

### 6.1 UIs

| Consumer | Size class | Notes |
|---|---|---|
| Grid tile | `image-thumb` | CloudFront-cached, ~20 KB (400 px) |
| Phone fullscreen | `image-medium` → `image-screen` | ~110 KB opens immediately; `image-screen` follows. Whether `image-screen` is worth issuing at all on a phone is a §3.4 question |
| Laptop windowed | `image-medium` or `image-screen` | by actual viewport size |
| Laptop fullscreen / retina | `image-large` | |
| 4K TV | `image-large` | 3840 native is within this class's 4272 maximum |
| Share / export ("send this to someone") | `image-medium` | the common case, and it must not restore an original |
| Zoom beyond `image-large` | restore original | async, notified |
| Print / export at full fidelity / edit | restore original | async, notified |

**Progressive presentation:** open `image-medium` immediately, follow with `image-screen` on a full-size viewport, and upgrade to `image-large` only if the viewport actually exceeds `image-screen`. Do not preload `image-large` speculatively — under I-T a read promotes the object back to Frequent Access for a further 30 days, so speculative reads quietly undo the tiering that makes this class cheap.

### 6.2 On-device AI

All of it reads renditions, never originals — and the routine path reads **`image-medium`**, not `image-screen`. Concretely, against what is in the tree today:

| Task | Model input | Reads | Rationale |
|---|---|---|---|
| Face detection (SCRFD) | 640×640 letterbox | `image-medium` | 1280 → 640 is a 2× downscale; faces below ~25 px in the source were never going to survive detection anyway |
| Face embedding (ArcFace) | 112×112 aligned crop | `image-medium` | crops taken from the 1280 px rendition |
| Small/distant faces | 112×112 | `image-screen` | re-crop when the detected box is < ~60 px in `image-medium` |
| Semantic embedding (SigLIP 2) | ~384×384 | `image-medium` | 1280 → 384 with room to spare |
| Object detection (Objects365) | ~640×640 | `image-medium` | |
| OCR (future) | text-resolution | `image-large` | the one task that genuinely needs the pixels |

**Why `image-medium` and not `image-screen`.** Every routine input is 640 px or below, so `image-screen` at 2560 ships and decodes 4× the pixels the model consumes. On a full catch-up scan of 60k items that is the difference between ~7 GB and ~21 GB of transfer and decode, and on a phone the decode half of that is battery. `image-screen` remains the right source for the one case that genuinely needs more resolution — re-cropping a face that came out small — which is a small fraction of items rather than all of them.

This replaces finding 18's full-original reads. Three consequences worth stating: AI stops being blocked by the archive tier entirely; per-image I/O drops from tens of MB to ~110 KB; and **at capture time on the phone, AI should read the original directly** — it is already local and free, and gives the best possible input. The rendition path is for *catch-up* processing on devices that never held the original.

### 6.3 The signed-URL round trip

Today the viewport batches signed-URL requests through a Lambda hop (`photos/src/lib/url-batch-loader.ts`), adding ~150–300 ms before the first byte. Since keys are content-addressed and immutable and the cache policy already excludes the signature from the cache key, signed URLs can be **long-lived and returned inline with the record list**. One request instead of two, and the URL arrives with the metadata that needed fetching anyway.

---

## 7. Storage: local and on-device

### 7.1 Residency policy — the platform change that unblocks everything

Finding 7 is the blocker. `residencyOf` currently derives four states (Absent, Staged, Resident, Tombstoned) and treats blob-absent as Staged, which stalls the watermark by design so the record is retried forever.

**Add a fifth state, `Elided`: metadata present, blob deliberately absent, watermark advances.**

The mechanism is a residency *decision* consulted before the transfer:

```
decideResidency(record, nodePolicy, localOverrides) → "fetch" | "elide"
```

- `"elide"` → apply the metadata row, skip the blob, **advance the watermark**. The node knows where the bytes are and can fetch them on demand later.
- `"fetch"` that then fails → unchanged from today: hold the watermark, retry next round.

The three inputs resolve in a fixed order, and the order matters because two of them pull in opposite directions (§7.2.2):

1. **Record constraints** — carried on the record itself, honoured identically by every node. **Restrictive wins**; nothing below may override.
2. **Local pin** — this node's per-record override.
3. **The node's retention rule for this record's size class** (§7.2), then that class's **budget**.

The distinction between *declined* and *failed* is the entire change. Everything else in this plan — phone nodes, archived originals, bounded device caches — depends on it.

But this is a *fetch-time* decision only, and it bounds new arrivals rather than existing ones. A device that is already full stays full. The other half — removing bytes that are already resident — is §7.2.1, and it is the larger piece of work.

### 7.2 Per-device retention — expressed per size class, with no residency classes

An earlier draft introduced named residency classes (`Full` / `Library` / `Browse`) as the model, then walked it back to "presets over four dials" while continuing to use the names as the primitive everywhere else in the document — including in places where they actively obscured what was happening (§7.2.1's eviction cases were written as "the user switches to `Library`", which describes a UI gesture rather than a condition the system can evaluate).

**Residency classes are removed from this plan entirely.** They are a fixed grouping laid over a set of dimensions that are already granular, and the grouping buys nothing the dimensions do not: the size classes exist, they are individually meaningful, and a node can simply say what it wants of each. Something like `Full`/`Library`/`Browse` may well be the right *UI* — three buttons are friendlier than a matrix — but it should be a set of presets that write the underlying settings, invented when the UI is designed and revisable without touching the data model. Nothing below stores a residency class, and no behaviour is conditioned on one.

**The primitive: a retention rule per size class.** A node's residency policy is a table with one row per size class in §3.1 and §3.3, including `original`:

| Setting | Meaning |
|---|---|
| **keep** | all / recent-only / on-demand-only / never |
| **recency window** | for *recent-only*: how far back, plus "anything opened in the last N days" |
| **byte budget** | a cap on this row (see below) |

So the operator's laptop is "`original`: never; everything else: all". The phone is "`image-thumb`: all; `image-medium`: last 90 days; `image-screen`: on demand; `image-large`, `original`: never". A NAS that wants renditions plus originals from 2024 onward is "`original`: recent-only, 2 years" — a row edit, not a new class that had to be anticipated.

**Budgets are granular, and that is the point.** A single device-wide byte cap is not a useful control here, because the size classes have wildly different value-per-byte and the user has clear opinions about the trade. **The budget is set per size class** — one row per class, defaulted, with a total shown. Because the class names carry their media type (§3.0), this is a flat list rather than the photo × class matrix an earlier draft used:

| Size class | Default budget |
|---|---|
| `image-thumb` | 1 GB |
| `image-medium` | 4 GB |
| `image-screen` | 2 GB |
| `image-large` | 0 |
| `video-poster-thumb` | 0.2 GB |
| `video-poster-screen` | 0.3 GB |
| `video-skim` | 0.5 GB |
| `video-720p` | 4 GB |
| `video-1080p` | 0 |
| `original` (photo) | 0 |
| `original` (video) | 0 |

The photo/video split matters more than it looks: one 4K clip is worth hundreds of `image-medium` stills in bytes, and a user who wants offline video and a user who wants their whole still library at `image-medium` are asking for opposite allocations. Under a single pooled budget one silently starves the other, and which one loses depends on ingest order — which is not a behaviour anyone can predict or debug. Separate budgets make it a stated preference. The prefixed names give that for free everywhere except `original`, which is the one class that exists in both ladders and therefore still needs the split spelled out.

A device-wide total remains as a display and as an optional ceiling, but the per-row budgets are what eviction actually enforces (§7.2.1). Rows with a budget of 0 are simply "never" restated, and the UI should present them as the same thing.

**Recency, not pure LRU.** The operator's stated pattern is that recent items dominate views. "Everything at `image-thumb`, last 90 days at `image-medium`, plus anything opened in the last 30 days" is both a better fit and far easier to explain than an opaque cache eviction policy. It also produces a predictable, quotable disk figure: 60k × 20 KB + ~4k recent × 110 KB ≈ 1.6 GB — and because it is per size class, that figure is computable *per row* and can be shown next to each budget as "this setting will use about X".

Plus, on every device and independent of all of the above: **originals captured *here* are retained until confirmed durable elsewhere**, and until every applicable size class has been derived from them (§4.2). Then they become evictable — see §7.2.1, where "confirmed durable" and "evictable" are given actual mechanisms. That is what makes the phone a safe origin node rather than a single point of loss.

### 7.2.1 Eviction — what "devices stop keeping originals" actually means

The phrase is doing a lot of work throughout this plan, and it hides three separate mechanisms. §7.1 specifies only the first.

1. **Decline** — never fetch the blob. Fetch-time, `decideResidency` → `"elide"`. Bounds what arrives from now on.
2. **Evict** — delete a blob that is *already resident*. Needed in three distinct situations, all of which are now stateable as conditions rather than as UI gestures: **the user reduced the budget for a size class and what is already held no longer fits** (the operator's laptop setting `original` to 0 is just the extreme case of this, not a special "migration"); a capture node releasing an original once it is durable elsewhere and fully derived; and ordinary budget pressure as an append-only library grows past a fixed device.
3. **Backpressure** — what happens when eviction cannot free enough because everything remaining is pinned or not-yet-durable.

**Nothing enforces any of this today**, and that was verified rather than assumed. `getFilesToPull` (`sync-engine/src/file-sync-engine.ts:41`) pulls every blob it is handed that is not already local, with no policy input. There is no eviction path in the sync engine at all — the only `storage.delete` is the HTTP server's DELETE handler (`transports/http-server.ts:86`), and `sync-engine.ts:578` explicitly parks the question: "delete is a GC concern, not a sync concern." The honest description of current behaviour is that every device tries to hold everything and eventually fills the disk.

Eviction needs three things that do not exist.

**A resident-set index with sizes, keyed by size class.** `size_bytes` is already on `FileRecordRow` (`sync-engine/src/types.ts:115`), so sizes are free. Residency, however, is *derived*, not stored — `residencyOf` calls `localStorage.has()` per record (`residency.ts:37`), and the header comment states the absence of a persisted `sync_status` column as a deliberate design decision. Answering "how many bytes am I holding" is therefore one storage probe per record — 63k of them on the operator's library, and now 300k+ once renditions exist. A budget that cannot be evaluated cheaply is not a budget, and per-size-class budgets (§7.2) mean the index must be groupable by size class and media type, not just totalled. This requires a persisted resident set, which amends a stated invariant of the sync engine and should be adopted deliberately rather than arrived at as a side effect.

**A blob-level durability predicate.** This is the subtle one and the only item here that destroys data if it is got wrong.

*Do we have one today? No — and the gap is larger than "we have not written the check yet."* What exists:

- The push path PUTs to a presigned S3 URL and checks the HTTP status (`http-object-storage.ts`, `s3Res.ok`). That proves S3 accepted the request. It does not verify the body: no checksum header is sent, so S3 stores whatever arrived and reports success.
- `getFilesToPush` and `transferFile` gate on `remoteStorage.has(key)` (`file-sync-engine.ts:23`, `:77`), and record registration re-checks `storage.has()` before inserting (`api-handler.ts:1348`). That is an existence check.
- `has()` is `HeadObject` → boolean (`storage-s3/src/adapter.ts:134`). It discards `ContentLength`, `ChecksumSHA256`, `StorageClass`, and `x-amz-restore`, and it returns `false` on 403 as well as 404, deliberately, because the per-app boundary withholds `ListBucket`.

So today the strongest available statement is **"an object exists at that key"** — which is not the same as "the bytes are correct", and not the same as "the bytes are readable". A HeadObject against a Deep Archive object succeeds, so `has()` returns `true` for an object that cannot currently be retrieved at all. Building eviction on `has()` as it stands would mean deleting a local original on the strength of an existence check that cannot tell a complete upload from a truncated one, or a live object from a frozen one.

*Making it a real predicate is cheap, and content-addressing does most of the work.* The key already **is** the SHA-256 of the bytes, so S3 can be made to verify the upload itself: send `x-amz-checksum-sha256` (the same digest, base64) on the presigned PUT, and S3 rejects any body that does not match rather than storing it. That turns "S3 returned 200" into "S3 confirmed these bytes are the bytes this key names" — end-to-end verification with no extra request and no trust in the uploader. Three follow-ons:

- The presign path must include the checksum header in the signed headers, alongside the `x-amz-storage-class` and `x-amz-tagging` changes §5.1 already needs.
- **Multipart is not covered by the same mechanism.** Multipart uploads compute a *composite* checksum over part checksums, not a whole-object SHA-256, so the streaming/multipart transfer in §7.3 needs an explicit decision — verify per part, or use one of the full-object checksum algorithms S3 supports for multipart. Worth confirming against current S3 documentation rather than assuming, and it matters exactly for the largest and least replaceable objects.
- **`has()` should stop returning a boolean.** Widen it to return the object facts `HeadObject` already fetched — size, checksum, storage class, restore state — which is the same call at the same cost and is also what §5.1.1's availability field wants. The current boolean throws away the answer to three separate questions in this plan.

*What may not stand in for it.* The coverage watermark cannot: watermarks are *metadata* coverage — they establish that a peer has seen the record, not that it holds the bytes. `Elided` makes that gap structural rather than incidental, because the entire point of the state is that a peer advances its watermark past a record *precisely because it declined the blob*. Evicting on watermark evidence would mean deleting a last copy on the word of a node that does not have it either. The gate must be an explicit blob-level signal — a verified remote `has()`, or a per-blob replica count — and nothing else. §7.2.2 tightens this to a replica count for `no-cloud` records, where a cloud `has()` can never return true.

**A trigger with hysteresis, evaluated per size class.** Not per-item. High- and low-water marks (evict down to 80% on crossing 95%), so ingest does not drag an eviction pass behind it. Because budgets are per size class and media type (§7.2), the marks are too — a full `video-720p` budget evicts old video previews and does not touch stills, which is both the intuitive behaviour and the one the user configured.

**Pins count against the budget of their size class, and pins win.** A pinned record (§7.2.2) is unevictable by definition, so it must be *counted* — otherwise someone pins 200 GB of originals into a zero `original` budget and either the pin silently fails or eviction thrashes forever trying to reach a floor it cannot reach. Pins override the budget, the resulting overage is shown per row in the residency inspector rather than swallowed, and the eviction pass must treat the pinned set as fixed rather than as candidates it keeps re-examining. A pin is per record, so it lands in whichever size-class row that record belongs to; pinning "this album, at full quality" is a pin across several rows and should be shown that way.

**The overage order is a choice, and it should be made here.** When pins plus unconfirmed-durable captures exceed a budget, something gives. **Capture never blocks** — a photo app that stops taking photos because a cache is full is broken. The device goes into overage, the residency inspector (§7.6) surfaces which row is over, and load is shed in a fixed order: stop fetching other nodes' renditions for that class, then stop prefetching its recency window, then prompt to raise that budget or unpin. Originals captured here and not yet confirmed durable — or not yet fully derived from (§4.2) — are evictable *never*, by construction. Because budgets are per class, overage is contained: a phone over budget on `video-720p` keeps browsing stills normally, which a single pooled budget would not have given us.

**Lowering a budget is a destructive action and must be presented as one.** There is no separate "migration" concept — reducing the `original` budget on the operator's laptop from unbounded to zero is the same operation as any other budget reduction, just at the largest scale it can have. What it needs is what any destructive action needs: before applying, compute what would be evicted, show the count and byte total, and require confirmation. Two rules that fall out of the durability predicate above:

- **Anything not confirmed durable elsewhere is excluded from the eviction set, and reported separately.** The user is told "12,431 originals will be removed; 47 will be kept because they are not yet confirmed elsewhere", and the setting still applies — the 47 leave later, when they qualify.
- **Until the durability predicate actually exists, a reduction that would evict originals must refuse rather than proceed.** Renditions can be re-derived; an original cannot. Refusing is the correct behaviour for a control whose only safety check is not implemented yet, and it should say so rather than silently doing nothing.

### 7.2.2 Per-record overrides — two axes, not one

Users will want per-item control, and the obvious list of controls — *never sync to cloud*, *always sync to cloud*, *always keep locally*, *keep locally if the budget allows* — looks like one feature. It is two, with opposite storage requirements, and conflating them is the expensive mistake available here.

**Cloud exclusion is a property of the record.** Every node must honour it identically: a node that has not heard about the exclusion will happily upload the blob. So it has to travel *with* the record, which in this system means a label — `starkeep/no-cloud`, alongside `photos/rendition=<class>`. It is a negative constraint, and it is the "restrictive wins" tier of the §7.1 resolution order: no node policy, profile, or manual action may override it.

**Local retention is a property of the node.** A pin is one device's business — the laptop pinning an album says nothing about the phone. Pins must therefore *not* be shared labels, or one device's preference silently rewrites every other device's cache policy. They live in node-local state alongside the resident-set index (§7.2.1).

**Enforce cloud exclusion server-side, not only in the peer.** The cloud data server should refuse blob writes for records carrying `no-cloud`. One check, and it converts the guarantee from advisory — trusting every present and future peer implementation to have got it right — into something actually enforced.

**No new residency state is required.** `Elided` already covers both: a `no-cloud` record on the cloud node is permanently `Elided` (declined by policy, watermark advances, metadata everywhere and bytes nowhere), and so is an unpinned record over budget on a phone. This is a large part of why the feature is cheap — it is new inputs to an existing decision, not new machinery.

**Per-record is the mechanism; labels are the interface.** Nobody sets 63,000 checkboxes. Expose the control through selections and rules over labels — "this album never leaves the phone" is a rule over a label, and the label machinery already exists. One primitive, bulk ergonomics for free.

**`no-cloud` inverts §5.6, and needs the same answer.** §5.6 worries that Deep Archive plus the ladder leaves the cloud holding the only copy of every original. A `no-cloud` record has *no* cloud copy by construction, so the risk moves to the device — and devices are dropped in toilets considerably more often than S3 loses objects. Two consequences. The §7.2.1 retention rule ("captured here, retained until confirmed durable elsewhere") can never release a `no-cloud` original to the cloud, so "elsewhere" must be able to mean another *local* node. And the durability predicate must therefore be a **replica count across nodes**, not merely a cloud `has()` — with a configured minimum, and a visible warning wherever the control is exposed while the count sits at one. A per-file switch whose main observable effect is losing photos is not a feature.

### 7.3 Streaming transfers

Finding 8 has to be fixed for video regardless of everything else: replace the buffered `get()`/`put()` with a streamed transfer and multipart upload above a threshold (~8 MB). Without it, a ProRes clip OOMs the process; with the current 4K/ProRes capture mix that is not hypothetical.

### 7.4 Constraint on the future slideshow feature

Since it was raised: design the automatic-slideshow generator to read **`image-medium` for candidate selection and `image-large` for the final render, and never originals**. A background job that thaws 500 originals from Deep Archive is the one way this cost model breaks badly, and it is far easier to prevent by construction now than to notice on a bill later.

This is no longer only a convention, which is what makes it worth stating here. §5.1.1 gives every record an `availability` field and makes archived reads return 409 instead of restoring implicitly, so the slideshow generator cannot thaw the archive by accident even if someone forgets this paragraph. The paragraph is the intent; §5.1.1 is the enforcement.

---

### 7.5 The phone is a sync *peer*, not a local-data-server

An earlier draft assumed a full local-data-server would run on the phone, and flagged that as the plan's biggest risk. Modelling the phone on **how Google Photos actually works on iOS** dissolves most of that risk, and is the model to follow.

#### What Google Photos does on iOS

It is a native app, and it **does not run a server**. The mechanism is:

- **PhotoKit as the watcher.** It reads the system photo library through `PHAsset` / `PHAssetResource` / `PHImageManager` under `NSPhotoLibraryUsageDescription`, and learns about new captures via **`PHPhotoLibraryChangeObserver`** — an OS push notification on library change, not a filesystem poll.
- **It does not own the bytes.** The system photo library remains the storage; Google Photos observes and copies out of it.
- **`URLSession` background configuration for uploads.** Transfers are handed to the OS `nsurlsessiond` daemon and continue while the app is suspended or even terminated; the app is relaunched via `handleEventsForBackgroundURLSession` to handle completion. This is the only genuinely persistent background work available on iOS.
- **BackgroundTasks for CPU.** `BGProcessingTaskRequest` for longer opportunistic windows (typically overnight, on charger, on WiFi), `BGAppRefreshTaskRequest` for short ones, plus silent push to wake the app.

**No iOS app can run a persistent background daemon.** Backgrounding gives roughly 30 seconds, extendable to a few minutes via `beginBackgroundTask`, then suspension. This is why the standing user complaint about Google Photos is "it won't back up unless I open the app" — even Google cannot do continuous background sync on iOS. Android is materially more permissive (foreground services, WorkManager), so Pixel is the easier target.

#### What this means here

**The phone implements the sync protocol; it does not implement the LDS.** That distinction is what makes it tractable, because most of the local-data-server's weight is in *being a server* — the HTTP surface, per-app HMAC auth, grant filtering, the Cognito broker, the multi-app sync supervisor, the filesystem watcher. A phone has no other local apps to serve, so it needs none of that.

**Verified: the sync engine is already portable.** `@starkeep/sync-engine` and `@starkeep/protocol-primitives` have **zero runtime Node dependencies** — the only two `node:` imports in the engine (`node:sqlite` in `sync-state-sqlite.ts`, `node:http` in `transports/http-server.ts`) are `import type` and erase at compile time, and the one file with real Node runtime usage is the *server* transport a phone peer would not use. The engine already talks to `DatabaseAdapter` and `ObjectStorageAdapter` interfaces, which is exactly the seam a second peer needs.

That makes **React Native / Expo the pragmatic runtime**: Hermes is AOT bytecode with no JIT, so the App Store constraint that made a Node runtime risky does not apply, and the existing TypeScript sync engine runs as-is. The work is two adapter implementations (SQLite via op-sqlite/expo-sqlite; object storage via expo-file-system) plus native modules for the media work below. Native Swift remains an option — the protocol is small — but re-implements what already compiles.

#### What iOS gives us for free

This is a stronger confirmation of §4.1 than the original reasoning: on iOS, deriving on-device is not merely the cheapest place, it is **the only place the codecs exist**.

- `PHImageManager.requestImage(for:targetSize:…)` does hardware HEIC decode and resize. The `image-thumb` / `image-medium` / `image-screen` / `image-large` classes come from system APIs — **no libvips on the phone at all** (§8.1).
- `AVAssetExportSession` / VideoToolbox gives hardware H.264/HEVC for the `video-720p` class (§3.3).
- ProRAW/DNG decode is native via ImageIO and `PHAssetResource` — **the libraw problem in §8.2 does not exist on-device**.
- `PHAsset.mediaSubtypes.contains(.photoLive)` plus `PHAssetResource` hand over the Live Photo pair directly, so **§8.4's content-identifier parsing is only needed for imported files, never for capture**.

#### What stays genuinely hard

- **Background CPU is opportunistic, not continuous.** Derivation happens in foreground moments and in `BGProcessingTask` windows. For ~20 captures a day that is ample; for a 40k-item backlog it is hopeless — which is consistent with §4.5 already making bulk import a laptop job.
- **The renditions-before-originals ordering (§4.1) may not hold on iOS.** Background `URLSession` can ship an original while the app has had no CPU time to derive. Acceptable — the ladder-complete gate (§5.2) means the original simply waits in Standard until the renditions land, which is the behaviour we already want. It is not a correctness problem, only a latency one.
- **Disk pressure.** The budgeted rendition cache must live under Application Support, not Caches, or iOS will purge it.

### 7.6 The Android app — first mobile target, built to the iOS constraint

**Android ships first**, for three reasons: sideloading a dev build is trivial where iOS requires provisioning and review, it is the operator's primary phone, and — the one that matters most technically — **the phone peer is the only honest consumer of the `Elided` residency state**. Residency policy (§7.1) is the riskiest change in this plan and there is no way to genuinely test it on a laptop, where every blob fits. A real handset carrying a 60k-item library against an 8 GB budget is the test harness.

#### The discipline: build as if iOS-constrained

**Assume no persistent background execution, on either platform.** Android is materially more permissive — foreground services, unrestricted WorkManager — and we deliberately do not use that headroom in the first build. Android-specific optimizations come later, as optimizations, on top of a design that is already correct without them.

This is cheap discipline rather than self-imposed hardship, for two reasons. It is the same discipline that makes bulk import resumable (§4.5) and the watermark model safe. And modern Android defers aggressively anyway — Doze and App Standby buckets mean an infrequently-opened app gets treated roughly the way iOS treats everything.

Stated as rules the implementation must honour:

1. **No sync round may be assumed to complete.** Every unit of work is checkpointed at item granularity and resumes from the watermark.
2. **No work item may assume more than a few seconds of runtime.** Derivation is per-item, not per-batch.
3. **Byte transfer is delegated to an OS-managed mechanism** that survives app suspension and death, not to an in-process loop.
4. **Nothing is scheduled that depends on the app being open.** Foreground time is a bonus, never a requirement.

#### Mechanism mapping — build to the intersection

| Need | iOS | Android | Build to |
|---|---|---|---|
| Library change notification | `PHPhotoLibraryChangeObserver` | `MediaStore` + `ContentObserver` | An observer callback; push, never poll |
| Read media | PhotoKit | `MediaStore` / `ContentResolver` | An abstract media-source interface |
| Transfers surviving app death | background `URLSession` | `WorkManager` (**without** a foreground service) | OS-delegated transfer queue |
| Deferred CPU windows | `BGProcessingTask` | `WorkManager` with charging/unmetered constraints | Constraint-gated deferred jobs |
| Decode + resize | ImageIO / `PHImageManager` | `ImageDecoder` | Native module per platform |
| Video transcode | VideoToolbox | `MediaCodec` | Native module per platform |

Permissions differ and both need handling: `NSPhotoLibraryUsageDescription` on iOS; `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` on Android 13+, with Android 14's partial-access `READ_MEDIA_VISUAL_USER_SELECTED` as a case the UI must survive.

#### Porting assessment (verified, not estimated)

Better than expected. On top of §7.5's finding that the sync engine is runtime-Node-free:

- **The SQLite driver surface is three methods.** `packages/storage-sqlite/src/adapter.ts` funnels everything through `runStmt` / `getRow` / `allRows`, i.e. `prepare().run()`, `.get()`, `.all()`. Swapping `node:sqlite` for op-sqlite is a shim, not a rewrite.
- **Query building is already driver-agnostic.** `query-builder.ts` runs Kysely with `DummyDriver` + `SqliteQueryCompiler` — it compiles to SQL strings and parameters and never executes anything.
- **`transports/http-transport.ts` imports nothing platform-specific** — types and a local error class, over global `fetch`, which React Native provides.

The one real leak is `getRawDatabase(): DatabaseSync`, which hands the concrete Node type to the sync state store and change log. That needs narrowing to an interface before a second driver can exist.

**Recommended runtime: React Native / Expo with a dev client** (not Expo Go — native modules are required). Hermes is AOT bytecode with no JIT, so the existing TypeScript sync engine runs unmodified on both platforms and the iOS App Store constraint never arises. The work is two adapter implementations plus native modules for media access and derivation.

**Do not plan on reusing `photos-ui`.** Those components are React DOM with inline CSS strings; they do not port to React Native. The mobile UI is new code.

#### What the app needs to contain to be a useful test vehicle

Deliberately small — this is an instrument before it is a product:

- A grid backed by the `image-thumb` class and a viewer backed by `image-medium` then `image-screen`, enough to prove the ladder and its progressive stages end to end.
- A **residency inspector**: what is resident, what is `Elided`, current budget usage, eviction history. This is the actual point of the exercise and should be a first-class screen, not a debug menu.
- Capture observation via `MediaStore`, on-device derivation, and upload through `WorkManager`.
- Settings for the per-size-class retention rules and the per-class / per-media-type byte budget matrix (§7.2), plus whatever presets the UI decides to offer over them.

#### Where Android is *harder* than iOS

Two places, and the first corrects something §7.5 said:

- **Motion Photos are not free the way Live Photos are.** iOS hands over the Live Photo pair directly via `PHAsset.mediaSubtypes`. Google's Motion Photos are a single JPEG/HEIC with an appended MP4, located through XMP (`GCamera:MicroVideoOffset`, or the newer `Container:Directory` schema). So **§8.4's XMP parsing is needed for Android capture, not only for imports** — it moves out of the import path and into the core mobile build.
- **DNG decode is uneven.** `ImageDecoder` DNG support varies by device. Useful mitigation, and it generalizes: **DNG files embed a full-resolution JPEG preview**, so the rendition ladder can be derived from the preview without any raw decoder at all. Both Apple ProRAW and Pixel raws carry large previews. This partly dissolves the libraw problem in §8.2 on every platform including the cloud — worth verifying against real files before relying on it, since preview dimensions vary by camera.

#### Explicitly deferred

Android-specific work that is *not* in the first build, to be added later as optimization: foreground services for uninterrupted bulk derivation, unrestricted WorkManager scheduling, direct filesystem access where scoped storage permits it, and `MediaCodec` batch transcode pipelines.

## 8. Formats

### 8.1 HEIC — the urgent one

sharp/libvips as built cannot decode HEIC (finding 13), and HEIC is what the operator's phone produces. Two paths:

- **Primary: decode on-device.** iOS/macOS ImageIO and Android MediaCodec have hardware HEIC decoders. Since §4.1 already puts derivation at capture, this is the path that was going to be taken anyway — HEIC decoding largely stops being the cloud's problem.
- **Fallback: a custom libvips with libheif + libde265** for the cloud Lambda and for laptop backfill of already-imported HEIC. libde265 is decode-only, which avoids the HEVC *encode* patent question that keeps HEIC out of the stock build. This means a custom sharp build and a Lambda layer — real work, but bounded.

**§4.2 raises the stakes on the fallback.** Now that the cloud is the *only* fallback deriver — peer catch-up having been rejected because it would transfer an original to derive from it — "the cloud cannot decode HEIC" means there is no fallback at all for the operator's primary capture format. A phone that never catches up leaves those records ladder-incomplete, un-archivable, and holding their originals locally forever. That is a survivable state, and it is visible in the residency inspector rather than silent, but it means the custom libvips build is the thing that makes §4.2's second step true rather than an optimization of it.

Note that `image/heic` and `image/heif` are already registered types and already in Photos' grant list. The registry is fine; the codec is not.

### 8.2 RAW / DNG — a live bug

`.dng` is absent from the registry, so ProRAW files land in `other/other`, which is **ungrantable to installable apps**. Photos cannot see them at all. Add `image/dng` plus the common camera raws (`cr2`, `cr3`, `nef`, `arw`, `raf`, `orf`, `rw2`) as `image/*` types. libvips has no raw decoder; decoding needs libraw, or — again preferably — the on-device path, since macOS and iOS decode DNG natively.

### 8.3 JXL — out of scope

**Dropped from the plan.** sharp reports `jxl` with input and output both `false`, so nothing in the current toolchain can read or write it; it is not a rendition format (AVIF is); and no device in the operator's capture set produces it. Registering the type would buy a file extension mapping and nothing else, at the cost of implying support that does not exist. Revisit only if a real JXL file shows up.

### 8.4 Moving pictures (Live Photos and Motion Photos)

Two incompatible conventions, one representation.

- **Apple Live Photo:** a HEIC still and a separate `.MOV`, linked by a content identifier (`kCGImagePropertyMakerAppleDictionary` key 17 in the still, `com.apple.quicktime.content.identifier` in the movie). Both files are genuine user originals.
- **Google Motion Photo (Pixel):** a *single* JPEG/HEIC with an MP4 appended, located via XMP (`GCamera:MicroVideoOffset` on older devices, the `Container:Directory` / `MotionPhoto` schema on newer ones). One file is the original.

**Representation:** the motion clip is a child record of the still, labelled `photos/rendition=image-motion`, exactly like any other rendition edge. The name follows §3.0's rule — the prefix names the *parent* record's media type, and the parent here is a still — so `image-motion` denotes video bytes hanging off an image record. This is the one place the naming rule reads oddly; a third `live-` namespace was considered and rejected as not worth introducing for two classes.

The only difference between the two conventions is storage class of the child:

- Apple: the `.MOV` is an original in its own right → Deep Archive, and a small `image-motion-preview` rendition (~3 s H.264, ~300 KB, Standard) is what actually plays.
- Google: the ingestor **keeps the source file byte-intact as the archived original** (never destroy the source) and *additionally* extracts the embedded MP4 as a derived record → Standard, no separate archive copy needed.

Read-side, one code path: "does this still have a `image-motion` child?" Playback uses the `image-motion-preview` class on hover/long-press.

The pairing has to happen at **ingest**, where the sibling files arrive together. Retro-pairing a library from content identifiers is possible but is a separate backfill job.

---

## 9. Configuration

Two dropdowns and a slider for the common case; everything else has a default, and the per-record controls are opt-in — nobody should have to touch them to get a working library.

**Library profile** (one per library, in Photos settings or admin-web):

- **Cost-first** — originals to Deep Archive as soon as renditions are durable; `image-large` class off; video `video-720p` only.
- **Balanced** *(default)* — originals to Deep Archive on the same gate; full ladder in Intelligent-Tiering; `video-1080p` for sources above 1080p.
- **Everything instant** — originals stay in Intelligent-Tiering rather than transitioning to Deep Archive, so nothing in the library is ever more than milliseconds away. For people who edit originals routinely or are not comfortable with a thaw delay. Costs roughly $1.90/mo more than Balanced at Model B — 500 GB of originals at the blended I-T rate plus monitoring ($2.46) instead of Deep Archive plus tags ($0.54) — which is the honest price of never waiting.
- **Local-first** — the cloud holds renditions only; originals never leave the local nodes, i.e. `starkeep/no-cloud` (§7.2.2) applied by default to originals. A coherent privacy-motivated pattern that is otherwise only reachable by tagging every file by hand, so it deserves naming. It opts out of the cost model in §5.4 and requires a NAS or desktop retaining originals indefinitely; the replica-count minimum (§7.2.2) is what keeps it from being a data-loss feature.

**Device retention** (one per node): the per-size-class table from §7.2 — for each size class, keep all / recent-only / on-demand / never, a recency window where that applies, and a byte budget, split photo vs video. Each row shows its projected disk use next to its budget, and the page shows the total. Presets ("laptop", "phone", "archive box") may front this once the UI is designed, but they write these settings rather than being stored.

**Per-record overrides** (§7.2.2), set on a selection and expressed as rules over labels rather than per-file checkboxes:

- *Never sync to cloud* / *always sync to cloud* — travels with the record, binding on every node.
- *Always keep on this device* / *keep if the budget allows* — node-local, counted against the budget, and pins win over it.

**Advanced**, all defaulted: size-class long edges and quality levels (post-§3.4), rendition codec (AVIF / WebP / JPEG — the fallback matters for slow devices, since AVIF encode is 3–10× JPEG's CPU and that is battery on a phone), video preview bitrate and HLS duration threshold, archive tier, archive delay floor, restored-copy retention window, eviction high/low-water marks, minimum replica count before an original becomes evictable.

The operator's own configuration under this scheme: **Balanced**; phone keeping `image-thumb` for everything, `image-medium` for 90 days, `image-screen` on demand, nothing else, at ~8 GB across the matrix; laptop keeping every rendition class and no originals; `video-1080p` off until the TV becomes a real pattern.

---

## 10. Work breakdown

**Phase 0a — the one thing that cannot be done later.**

0. **`objectLockEnabled: true` on the files bucket** (`cloud-data-server-program.ts:127`), ephemeral installs excluded, with a 1-year default retention. Object Lock can only be set at bucket creation; every install that happens before this lands can never get it without an AWS Support request. Trivial code, hard deadline — see §5.6.

**Phase 0 — platform unblockers** (`starkeep-core`). Nothing else can land without these.

1. Residency policy + `Elided` state; separate *declined* from *failed* in watermark advance (`sync-engine.ts`, `residency.ts`). This is the fetch-time decision only. Retention is expressed per size class (§7.2) — there is no residency-class enum in the data model.
1b. **Eviction, byte accounting, and the durability predicate** (§7.2.1) — persisted resident set grouped by size class and media type, per-class high/low-water trigger, defined overage order. Larger than item 1, and the part the Android app actually exercises.
1b-i. **Make upload success verifiable** — send `x-amz-checksum-sha256` on the presigned PUT so S3 validates the body against the content-addressed key, and widen `ObjectStorageAdapter.has()` from a boolean to the object facts `HeadObject` already returns (size, checksum, storage class, restore state). This is the prerequisite for eviction, for §5.1.1's availability field, and for trusting any of it; today the strongest available signal is "an object exists at that key" (§7.2.1). Decide the multipart checksum story alongside item 2.
1c. **Per-record overrides** (§7.2.2) — `starkeep/no-cloud` as a record label honoured by `decideResidency`'s restrictive tier; node-local pin state; **cloud data server refuses blob writes for `no-cloud` records**, so the constraint is enforced rather than trusted to peers.
2. Streaming / multipart blob transfer (`file-sync-engine.ts`).
3. `parentId` filter and negated-label filter on `/data/records`; delete the O(library) scan in the resize handler.
4. Route sync downloads through CloudFront signed URLs.
5. Allow `x-amz-storage-class`, `x-amz-tagging` and the checksum header through the presign path.
5b. **Retrieval intent + availability** (§5.1) — `instant`/`archive` accepted at write and mapped to `x-amz-storage-class: INTELLIGENT_TIERING` / the `archive` tag respectively; `availability` returned on every record by `/data/records`; archived reads return 409 rather than restoring implicitly; explicit rate-limited restore endpoint.

**Phase 1 — the ladder** (`starkeep-apps/photos`, small core changes).

6. Ladder definition — four still classes incl. `image-medium`, with **§3.1.1's max-size semantics** (`min(original, class max)`, generated when the original exceeds the next lower maximum). `photos/rendition=<class>` label replacing the `thumbnail` flag; manifest update. No `native` value.
7. On-device derivation at ingest; renditions-before-originals sync ordering.
8. Backfill job for the existing library.
9. Grid and viewer serve from the ladder; remove the "only labelled thumbnails render" behaviour.
9b. **Run the §3.4 visual test and replace the provisional sizes and quality levels with measured ones.** This gates item 8 — backfilling 60k items at a quality level nobody has looked at is the expensive mistake in this phase, because by the time it is noticed the inputs are in Deep Archive.

**Phase 2 — the Android app** (§7.6). Depends on Phases 0 and 1; **it is also how Phase 0's residency work gets validated**, so it should not be deferred behind the cloud-side items.

10. Narrow `getRawDatabase(): DatabaseSync` to an interface so a second driver can exist.
11. Adapter implementations: `DatabaseAdapter` over op-sqlite, `ObjectStorageAdapter` over expo-file-system.
12. RN/Expo dev-client shell; Cognito auth; sync peer running the existing engine.
13. Native modules: `MediaStore` observation, `ImageDecoder` derivation, `MediaCodec` transcode.
14. `WorkManager` job graph built to the constrained execution model — no foreground service.
15. Grid + viewer + **residency inspector** + the per-size-class retention and budget matrix (§7.2).
16. Motion Photo XMP extraction (needed at capture on Android, unlike iOS — §7.6).

**Phase 3 — storage classes.**

17. Declared intent at PUT — `instant` writes `x-amz-storage-class: INTELLIGENT_TIERING`, `archive` writes the tag; ladder-complete gate over *applicable* classes only (§3.1.1); 7-day minimum hold before the Deep Archive transition.
18. **One** lifecycle rule: tag-filtered Deep Archive for `archive`-intent objects above the ~1 MB floor. Renditions need none — they are PUT directly into Intelligent-Tiering (§5.3.2). Assert in the installer that no `IntelligentTieringConfiguration` enabling the async archive tiers is ever created; that omission is what makes every rendition permanently `instant`.
19. Restore flow — request, poll, notify, serve, retain.
19b. **Availability maintenance** (§5.1.1) — S3 Event Notifications for transitions and restores, plus a daily S3 Inventory reconcile (~$0.02/mo) that also reports objects whose actual storage class disagrees with their declared intent.
19c. Compliance-mode retention configuration and the confirmation UX around it (§5.6). The bucket flag itself is item 0.

**Phase 4 — dedup and local import** (§4.5). Depends on Phase 1. Deliberately scoped small — the Takeout specifics wait until a real export has been inspected.

20. **Record-level dedup** — content-hash match must not produce two records for one object key. Needed regardless of import.
21. `perceptual_hash` and `thumb_hash` columns in `IMAGE_METADATA_COLUMNS`; both computed during derivation.
22. Three-tier duplicate resolution (hash → capture fingerprint → perceptual hash) with a reviewable "skipped as duplicate" list. **Ships in report-only mode for tiers 2 and 3** until calibrated against a real export (§4.5) — bursts, panoramas, screenshots, and Storage Saver re-encodes are the cases that decide the thresholds.
23. Delete `GoogleImportPanel` — a dead shell against a withdrawn API.
24. Resumable, per-item, content-hash-keyed local folder import with its own tracking table; batch or skip the per-object `has()` probe.
25. *(Deferred until a real Takeout export exists: sidecar parsing, filename de-mangling, pair reassembly.)*

**Phase 5 — video.**

26. `video/*` grant in the Photos manifest; video metadata extraction into the existing columns.
27. Poster + `video-skim` + `video-720p` transcode, on-device first. **`video-skim` parameters (4 fps / 8× / container) are a hypothesis — measure before fixing them.**
28. Player with range requests; conditional HLS above the ~2 minute threshold.

**Phase 6 — formats and moving pictures.**

29. `image/dng` + camera raw types in the registry (fixes the invisible-ProRAW bug).
30. Derive from the DNG's embedded full-res JPEG preview rather than decoding raw (§7.6) — verify against real ProRAW and Pixel files first.
31. Live Photo pairing at ingest (iOS capture gets it free; imports do not).
32. Custom libvips (libheif + libde265) — the cloud/backfill decode fallback for HEIC. Only needed where on-device decoding cannot reach; no JXL.

**Phase 7 — iOS, configuration, measurement.**

33. iOS target: PhotoKit + `URLSession` background + `BGProcessingTask` behind the same interfaces (§7.6).
34. Profile UI — library profile (including **Local-first**), the per-size-class retention and budget matrix (§7.2) with projected disk use per row, and the per-record override controls expressed as rules over labels (§7.2.2) rather than per-file checkboxes.
35. Per-prefix cost breakdown off the already-bootstrapped CUR, so the model in §5.4 can be checked against a real bill rather than trusted.

**Not planned.** Server-side fetch of a remote library (Drive-hosted Takeout, Dropbox/OneDrive, generic URL) and streaming archive extraction — analysed and deferred in §4.5. Revisit only if home-upstream wall clock turns out to be a real problem in practice.

---

## 11. Risks and open questions

1. ~~**Is a phone LDS actually feasible?**~~ **Largely resolved — see §7.5, §7.6.** The risk was framed around shipping a Node runtime on iOS. Following the Google Photos model removes the premise: the phone is a sync *peer*, not a local-data-server, and the sync engine is verified runtime-Node-free, so React Native/Hermes runs the existing TypeScript with no JIT and no App Store problem. Android ships first and is built to the iOS constraint, so the harder platform is designed for from day one rather than retrofitted. What remains is scoping, not feasibility: two adapter implementations plus native media modules, and the acceptance that background sync is opportunistic — the same limitation Google Photos visibly has.
1b. **Unquantified: on-device derivation throughput.** The whole ladder economics assume a phone can derive `image-thumb`/`image-medium`/`image-screen`/`image-large` fast enough within opportunistic windows. Unmeasured. The Android app (Phase 2) answers this before anything depends on the answer, which is a further argument for not deferring it.
2. ~~**Renditions as shared records vs. app-specific data.**~~ **Settled — shared records** (§4.4). Photos is the flagship app and after §5 the renditions are the only instantly-readable form of the library, so any other photo-adjacent app will want them; they are reachable by label like any other shared data. The accepted costs are that renditions outlive a Photos uninstall and that the label namespace stays `photos/`.
3. **Deep Archive means one copy of every original** (§5.6). Partly answered: Object Lock in compliance mode plus versioning is decided and covers an errant lifecycle rule and a credential compromise. Account-level loss is still uncovered — cross-account replication and a second provider are deferred, deliberately and knowingly. The residual risk is real and named rather than mitigated.
4. **AVIF encode cost on-device** — 3–10× JPEG CPU. Needs measurement on a real phone before AVIF becomes the default rendition codec rather than a setting.
5. **The custom libvips build** is the least pleasant item here. Deferrable as long as on-device decoding covers the real cases — but **cloud-first import is not one of those cases**, and choosing to build it (Phase 6) makes libvips-with-libheif a prerequisite rather than a fallback. DNG stays out of reach in the cloud regardless without libraw.
6. **The Google migration path is externally fragile.** Google withdrew the Library API read scopes in March 2025, which is what left `GoogleImportPanel` dead. Verify the current state of the Picker API, the Library API scopes, and Takeout-to-Drive before building anything against them — and prefer designs that degrade to "the user hands us a folder", which no vendor can take away.
7. **Takeout-to-Drive costs the user money to leave Google.** 300 GB of Takeout needs 300 GB of Drive quota. This may make the cleanest cloud-first path unusable in practice for exactly the people with the largest libraries.
8. ~~**Prices are from memory.**~~ **Done** — all S3 prices in §5.3/§5.3.1/§5.4 now come from the AWS Price List API for us-east-1, and three figures changed as a result (bulk restore requests are free; standard restore requests are $0.05/1k not $0.10; lifecycle transition costs differ per target class). Object tagging at $0.0065/10k tags/month was not previously accounted for at all. **Still unverified:** CloudFront and S3 data-transfer-out rates, which did not surface cleanly from the API — and the derived-rung *byte sizes* in §5.4, which are estimates and are now the weakest input in the model. Check both against the operator's own CUR once real data lands.
9. ~~**The three-rung ladder may not survive a real device.**~~ **Resolved by adding `image-medium` at 1280** (§3.1), which was wanted independently by AI, by progressive presentation, and by share/export. What remains is the opposite question: whether `image-screen` at 2560 is worth fetching on a phone at all once `image-medium` exists (§3.2), which §3.4's visual test answers.
9b. **Every size and quality level is unverified** (§3.4). This is now the largest open item in the document. The numbers are reasoned, not measured, and the failure mode is quiet and permanent — a quality level a little too low is invisible on a small sample and irreversible across 60k photos once the originals are in Deep Archive. The visual test gates the backfill.
11. **Deduplication thresholds are unvalidated in the false-positive direction** (§4.5). Bursts, panorama sequences, and screenshots are the cases where tiers 2 and 3 may judge distinct photos identical. Mitigated by "skip and log, never delete" and by shipping report-only, but the calibration has to happen against a real Takeout export before those tiers are trusted.
12. ~~**Intelligent-Tiering was priced and rejected.**~~ **Reversed — I-T is now the policy for every rendition class** (§5.3.2). The original rejection modelled I-T with the opt-in async archive tiers enabled, which is what produced both the "latency changes silently" objection and the "cannot reach Deep Archive economics" objection; with those tiers off, neither applies, and I-T additionally applies the 128 KB small-object boundary itself rather than requiring a per-class judgement that §3.4 could invalidate. **What remains open is the monitoring fee**, at $0.32/mo (B) and $0.96/mo (C) — it scales with object count rather than bytes, so a library of very many very small items is where an explicit Glacier policy could still win. That is a measurement for item 35's CUR work, and the `cool` → Glacier IR mapping is retained as a per-installation override so acting on the measurement is a config change rather than a redesign.
10. **`video-skim` parameters are a guess.** 4 fps / 8× speed / animated-image container is a starting hypothesis, not a known-good answer. Needs testing against real clips of varying length.
