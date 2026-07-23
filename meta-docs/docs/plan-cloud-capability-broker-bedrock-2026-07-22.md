# Plan — Cloud capability broker (Bedrock on-demand invoke)

**Date:** 2026-07-22 (revised 2026-07-23 after review)
**Status:** Proposed (design settled in discussion; not yet implemented)
**Scope topic:** cloud-apps / roles-and-permissions / cloud-data-server

---

## 1. Problem and decision summary

Cloud apps currently reach only the **data plane** (shared records, per-app schema,
files) through the cloud-data-server (CDS) broker. They have no way to *use* AWS
service capabilities that aren't data storage — the motivating case being
**Amazon Bedrock `InvokeModel`** for on-demand model calls (captioning, tagging,
summarization on top of the user's shared content).

We worked through the design and settled on the following, which this plan implements:

- **Broker, don't grant.** On-demand Bedrock invoke is a *metered capability with no
  allocation* — nothing is provisioned per-app or centrally. Apps must **not** get
  `bedrock:InvokeModel` on their per-app role (that would widen the per-app permissions
  boundary for every app and remove the only place to enforce spend limits). Instead the
  call is **brokered**, exactly as data access is brokered today.
- **Broker lives in the CDS.** The CDS already authenticates the caller (JWT + app id
  via HMAC-signed requests), runs in the cloud, and holds a foundational boundary. Adding
  a capability route reuses all of that. A standalone broker would have to reimplement the
  request-auth machinery for no security gain, since data exfiltration already dominates
  the CDS threat model.
- **Capability power stays *borrowed*, not *standing*.** The CDS does **not** carry
  `bedrock:InvokeModel` on its own foundational boundary. Instead a dedicated
  **capability role** holds that verb, and the CDS **assumes it per capability request** —
  mirroring how the CDS assumes each app's per-app role for data operations. This preserves
  the load-bearing property that the CDS's own standing identity never carries the sensitive
  operation verb.
- **Declared in the manifest, consented by the user.** An app declares the capabilities
  it needs in its manifest (parallel to `fileAccess`). The admin app surfaces them at
  install, the user approves, and install writes capability grant rows (parallel to
  `shared_access_grants`). The broker enforces those grants on every call.
- **Cost governance is the real new security surface.** Bedrock introduces a *new risk
  class* the CDS didn't carry before — unbounded spend / cost-amplification (see
  `todo-cloud-dos-cost-amplification`). The quota / rate-limit / metering / model-allowlist
  layer at the broker chokepoint **is** the security control here and must be built and
  tested adversarially, not treated as a feature.

**In scope for this plan:** Bin 1 (metered capability, no allocation) for the single
capability `bedrock.invoke`. The broker route, grant model, and capability role are
**capability-keyed** so additional Bin-1 capabilities (Rekognition, Textract, Polly, …)
are a later increment — but only `bedrock.invoke` is wired now.

**Out of scope (deferred):**
- Bin 2 (central, provisioned, user-data-bearing — e.g. a Bedrock knowledge base / vector
  index over shared documents).
- Bin 3 (per-app provisioned resources via install-infra — DynamoDB tables, queues,
  fine-tunes, provisioned throughput).
- Any capability other than `bedrock.invoke`.
- Bedrock features that are themselves provisioned (provisioned throughput, custom models,
  guardrails, agents).
- **Non-text output modalities that write to S3 asynchronously** (image/video generation via
  `StartAsyncInvoke`) — design sketched in §3.8, **not built** in this increment. Text output
  (the captioning/tagging case) and small synchronous binary output are the wired path.

---

## 2. Alignment with `data-roles-and-permissions.md`

Per the "check the roles doc first" rule, here is how each piece lands against the stated
stance before we touch any IAM / trust-policy / boundary code:

- **Principle 1 (data stays confined):** unchanged. The capability path touches no user
  data store *under the capability identity*. Attribution of *who invoked* is by authenticated
  app id + metering ledger, not IAM principal — the same attribute-based model the Drive sync
  path already uses (`origin_app_id`) rather than sole-identity IAM proof. **Caveat introduced
  by S3-location I/O (§3.4, §3.8):** if content is passed to Bedrock by S3 URI rather than
  inline bytes, Bedrock reads that object under the *capability* role, so the capability role
  takes a **per-session, single-object** `s3:GetObject` grant. That is a deliberate, bounded
  loosening — see the risk callout and required proof-of-concept in §3.4.
- **Principle 2 (powerful permissions centralized, bounded, ephemeral):** the capability
  verb lives on **one** dedicated capability role under a **new narrow boundary**, reached
  only by assumption from the CDS — not standing on any app role, and not standing on the
  CDS's own foundational boundary. This is the same "borrow it per request" shape as the
  per-app data assume.
- **Principle 3 (layered ceilings):** capability access is gated by (a) the capability role's
  IAM ceiling (Bedrock-invoke-only — nothing else, but **all Bedrock models**, by decision),
  (b) the install-time grant rows + effective model registry, and (c) the per-request gate
  framework (provider/model/app/global limits over the dimension model in §3.5). A bug in any one
  is bounded by the next. Deliberate departure from the data plane's shape: IAM here is **not**
  the layer that cuts by model or provider — that cut lives entirely in (b)+(c), so model/provider
  policy tracks AWS's cadence, not the platform's. The compensating floor is that IAM still
  confines the role to *invoke only*, and the gate framework bounds *cost* — a dimension IAM
  cannot express.
- **Admin is not a superuser:** unchanged. The admin app *deploys* the broker and capability
  role (as it deploys the CDS and Drive) but is never on the runtime capability path and gets
  no standing capability grant.

---

## 3. Components to build

### 3.1 Manifest surface (`@starkeep/admin-manifest`)

Add an optional `infraRequirements.capabilities[]` block:

```jsonc
"capabilities": [
  {
    "name": "bedrock.invoke",
    "models": ["anthropic.claude-haiku-4-5", "amazon.nova-lite"],
    "required": false,                  // optional → app runs degraded if the user denies it
    "requestedMonthlyBudgetUsd": 20,    // user-facing consent figure; becomes a per-app cost gate on approval
    "reports": ["input:megapixels", "output:megapixels"],  // non-generic dimensions the app can measure/report
    "rationale": "Generate captions and tags for your photos."
  }
]
```

- `name` — from a **platform-owned capability registry** (hardcoded, like the type/category
  registry). Apps cannot invent capabilities. Only `bedrock.invoke` exists initially.
- `models` — the model ids the app may call. Validated at **install** time against the
  operator's *effective* model registry (platform registry ∪ operator-defined models — see
  §3.6), not at author time (author-time `validateManifest()` can only check shape, since it
  has no operator context). A referenced model that is neither platform-known nor
  operator-defined fails the install grant step until the operator defines it.
- `required` — `true` (default) means the app can't function without the capability and the
  install is blocked if denied; `false` means the app treats it as optional and **runs
  degraded** if the user denies it (mirrors `requiredPermissions` / `optionalPermissions`).
- `requestedMonthlyBudgetUsd` — the spend figure shown to the user for consent
  ("this app may use Bedrock, up to ~$X/mo"). On approval it is stored as **one per-app cost
  gate** in the gate table (§3.5) — it is *not* a special mechanism; it is the app-consent
  origin of an ordinary gate, which the operator can then tighten or supplement.
- `reports` — the **non-generic** dimensions/units (see §3.5) the app is able to measure and
  report back (e.g. input/output megapixels, pages, frames, duration). Generic dimensions
  (`requests`, `bytes`, `cost`) are CDS-measured and are never declared here. This is the
  fail-closed contract: **if the operator sets a limit on a dimension the app has not declared,
  and a matching request arrives, the request is denied** — the app can't be metered on it,
  so it can't be trusted under it.
- `rationale` — shown at install, like `fileAccess.rationale`.

Add `validateManifest()` coverage (author-time, shape only): reject unknown capability names,
malformed model ids, unknown dimension/unit strings in `reports`, and (as with `fileAccessAll` /
`brokerPower`) reserve any privileged capability names so third-party apps can't claim them.
Effective-registry membership of `models` is checked at install, not here.

### 3.2 Install / grant persistence (`@starkeep/admin-installer`, data plane)

- New table `capability_grants` (parallel to `shared_access_grants`): one row per
  `(appId, capabilityName)` with the approved `models` list and the app's declared `reports`
  set.
- On approval, also write the app's `requestedMonthlyBudgetUsd` as a per-app cost gate into
  the gate table (§3.5).
- Install step (after the manifest grants step): write the grant row (+ consent gate).
  Uninstall: delete them (and the app's metering/ledger rows — see §3.5).
- **User consent:** the admin app's install grant-approval UI lists capability requirements
  alongside file-access grants, with the rationale and the requested spend figure. No new
  consent mechanism — extend the existing approve-grants screen.
- **Degraded operation:** a denied `required: false` capability just means no grant row is
  written; the install proceeds. So the app can adapt at runtime, the app-client exposes which
  capabilities were granted (runtime-config style, like the local/cloud target resolution), and
  `invokeCapability` on an ungranted capability returns a well-defined "not granted" result the
  app branches on — never a hard failure. A denied `required: true` capability blocks the
  install with a clear message.

### 3.3 Capability role + boundary (bootstrap + deploy)

- **Bootstrap (`scripts` / CFN):** reserve a new **capability-broker permissions boundary**
  — ceiling = `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream`, plus a
  defense-in-depth deny on IAM mutation, and nothing else. Reserve it by boundary only (no
  empty-trust role), exactly like the User-Data-Owner boundary.

- **ARN scope of the boundary — all-or-nothing, by decision.** IAM is *not* the layer that
  decides which providers or models are allowed: there is nothing special about any one provider,
  and encoding a model/provider allowlist in the boundary just recreates the platform-cadence
  problem one layer down. So the invoke actions are scoped to **all Bedrock models/inference
  profiles** (`arn:aws:bedrock:*:*:*` foundation-model + inference-profile), and **all**
  provider/model restriction is enforced in the usage-limitation framework — the effective model
  registry + per-app grant `models` list + per-provider/per-model gates (§3.5). **Trade-off,
  accepted:** the capability role can invoke any Bedrock model (a compromised broker or a
  gate-bypass logic bug could reach an expensive non-Anthropic model), bounded by the global cost
  kill switch + per-provider gates, and by the fact that the role can *still only invoke Bedrock*,
  nothing else — no data, no other services. This is a deliberate loosening of layer-1 IAM on the
  model dimension in exchange for the app-layer framework being the single, cadence-free control
  point. **This is the accepted decision — not scoping IAM to the adapter/provider set — because
  keeping IAM out of provider/model policy entirely is worth more than the defense-in-depth a
  provider wildcard would add.**
  - **Note — the *adapter* set is still a deliberate multi-provider choice; that is a framework
    concern, not an IAM one.** We ship **two** provider adapters from day one (Anthropic and
    Amazon Nova — see §3.6); which providers the broker can *form valid requests for* is decided
    in code and the registry, while IAM stays all-Bedrock. Adding a third provider is adapter +
    registry work with **no boundary change** — which is the whole point of keeping IAM
    all-or-nothing.

- **Deploy (CDS Phase 2, or a small dedicated step):** mint `...-capability-broker-role`
  under that boundary, with a **trust policy naming the CDS role** as principal (single-hop
  assume, same as per-app roles). A magic-string check routes only this reserved id to the
  boundary so no third-party app can opt in.
- **CDS foundational boundary change:** add only `sts:AssumeRole` onto the capability-broker
  role. Do **not** add any `bedrock:*` verb to the CDS's own boundary.
- **S3-location I/O caveat (see §3.4 risk callout):** if the S3-location input path is adopted,
  the capability-broker boundary also permits a **session-scoped** `s3:GetObject` (and, for the
  deferred async output work in §3.8, `s3:PutObject`), narrowed per-assume to a single object
  key. The *boundary* permits it; the *standing* role holds no object access — each assume
  scopes it to exactly one already-authorized key. This is the risk area flagged for an early
  proof-of-concept.
- **Teardown:** update `scripts/teardown-bootstrap.sh` in lockstep (the capability-broker
  boundary is a non-CFN-safe / manually-tracked resource per the teardown-script rule).

### 3.4 Broker route (cloud-data-server)

- New route, capability-keyed: `POST /capabilities/:name/invoke` (only `bedrock.invoke`
  handled initially; unknown names → 404). Accepts both the browser JWT+app-id path and the
  server-to-server HMAC path (the latter is how a locally-running app's proxy reaches it —
  see §4 Data flow).
- **Content is supplied by reference only** (record id / object key of a cloud-stored item).
  The broker has **no inline-bytes path from the caller** — it never accepts caller-supplied
  content. The only way bytes reach Bedrock is a grant-checked read of an item in normal cloud
  storage that the app is authorized to read. This deliberately means content that is not in
  readable cloud storage (unsynced local items, app-specific data the reference scheme doesn't
  cover) cannot be fed to Bedrock; it must reach the cloud data plane first.
- Handler flow (reuses existing CDS auth):
  1. Authorize user (JWT or HMAC) + identify calling app (existing verifier).
  2. Look up the app's `capability_grants` row for `bedrock.invoke`; 403 if none.
  3. Validate the requested model is in the app's approved `models`; 403 otherwise.
  4. **Assume the calling app's per-app role** and confirm the referenced item is readable by
     the app (`shared/<category>/...`, or the app's own `apps/<appId>/syncable/...`) — the
     existing data path, bounded by the app's grants. 404/403 if the app can't read it or it
     isn't resident. This step stays the **source of truth for which objects the app may feed
     Bedrock**, even when bytes are later delivered to Bedrock by S3 URI (see below).
  5. **Gate chokepoint** (§3.5) — project the request against every matching gate; reject 429
     if any would be breached (reserve on `max_tokens` / input estimate for output/cost gates).
  6. **Assume `...-capability-broker-role`** (single hop) for the duration of the call. If the
     S3-location path is used, attach an **inline session policy scoped to exactly the one
     referenced object key** confirmed readable in step 4.
  7. Call Bedrock under the assumed creds (see §3.6), passing content either inline (base64) or
     by S3 URI; stream/collect the response.
  8. Reconcile the ledger with actual token/byte usage (§3.5); return the model response.
- **Two ways bytes reach Bedrock — pick per request size:**
  - **Inline base64** (small single images, the common captioning case): CDS reads the bytes
    under the app role (step 4) and inlines them. Capability role needs **no** S3 access; the
    boundary stays purely `bedrock:*`. Bounded by Bedrock's inline request-size / timeout limits.
  - **S3 location** (large or many images; avoids size/timeout limits): the Converse API accepts
    an `s3Location` source, so the CDS passes the object URI and Bedrock reads it directly.
    **Because Bedrock reads under the *invoking* (capability) principal, this requires
    `s3:GetObject` on the capability role** — mitigated to a per-assume **session policy scoped to
    the single key from step 4**, so the role holds no standing data access and each call's reach
    is exactly the one object the app was just proven able to read.
- **⚠ Risk area — session-policy downscoping.** The S3-location path shifts the "which object"
  boundary from *IAM enforcing the app role's own policy* (belt) to *correct broker logic
  computing a session policy* (suspenders). A bug that mis-computes the session-policy key could
  grant the capability role read to an object the app can't access. Mitigations: (a) keep step 4's
  app-role read as an independent confirmation of readability before minting the session policy;
  (b) **make a proof-of-concept of session-policy downscoping the first implementation step**
  (see §7) — validate that a per-assume inline session policy correctly narrows `s3:GetObject` to
  one key and denies everything else — and **revisit the whole S3-location path if the PoC fails**,
  falling back to inline-only for the initial increment.
- Keep the capability handler code-isolated from the data-path handlers (shared process, so
  the boundary is code discipline + tests, not a process boundary) so a bug in capability
  handling can't corrupt data-path auth.

### 3.5 Usage gates + cost governance (the security-critical subsystem)

This is the new load-bearing control. Build and test it as security code. **Bedrock does not
return a dollar cost** — only token counts (`X-Amzn-Bedrock-Input/Output-Token-Count`, or
`usage.input_tokens`/`output_tokens`). Cost is always *derived* from a price table and is
therefore an estimate that drifts. So enforcement is **not** a single dollar cap; it is a set
of independent gates, so the operator never has to rely on the fragile derived number if they
don't want to.

**Gate model.** A gate is `(dimension, unit, scope, window, limit)`:

- `dimension` / `unit` — an **open set** (the schema must not hardcode a fixed enum), because
  AI services bill on genuinely different well-defined units. The wired `bedrock.invoke`
  dimensions are:

  | Dimension | Unit(s) | Meaning |
  |---|---|---|
  | `requests` | `all` \| `text` \| `image` \| `audio` \| `video` | count of requests, optionally by modality class (unit = the class; `all` = every request) |
  | `input` | `tokens` \| `bytes` \| `characters` \| `pages` \| `frames` \| `megapixels` \| `tiles` \| `duration_s` \| `megapixel_seconds` | quantity of the input, in the chosen unit |
  | `output` | *same unit set as `input`* | quantity of the output, same units reused |
  | `credits` | `count` | generic model-defined credit units (some models bill this way) |
  | `cost` | `usd` | derived from usage × price table |

  Note: `images` is **not** a dimension — an image cap is `requests`/`image`. The type-specific
  quantities (`characters`, `pages`, `frames`, `megapixels`, `tiles`, `duration_s`,
  `megapixel_seconds`) are **units of `input`/`output`**, not dimensions of their own.

- `scope` — any combination of global, **per-provider**, per-model, per-app (freely combined —
  a per-app-per-model gate sets both keys). Omitting all keys = global. Per-provider matters
  because IAM does not constrain provider at all (all-Bedrock, §3.3) — provider/model policy
  lives entirely here.
- `window` — for **cumulative** caps, a **calendar** accounting period: **`week` or `month`,
  operator-configurable** (default month), aligned to a configured timezone (calendar week
  starts Monday). "Reset" is implicit: gates sum only ledger rows within the current period.
  **Burst/rate** gates use a separate short window (per-second/minute) and are orthogonal to the
  accounting period. The burst gate is also load-bearing for concurrency (see below).
- `onExceed` — **`deny` only** for this increment. A gate that would be exceeded rejects the
  request (429). (A future `notify`/soft-budget mode is deliberately *not* built now — see the
  removed open question.)
- **Semantics: every gate whose scope matches the request is evaluated; if *any* gate would be
  exceeded, reject (429).** Each gate is optional — the operator sets whichever they want and
  leaves the rest unbounded. (The install-time consent budget from §3.2 is one per-app
  `cost`/`usd` gate in this same table.)

**Two axes replace the old "certainty" field.** A dimension is characterized by *when* it can be
known and *who measures it* — these are orthogonal and together decide enforcement and how the
UI must caveat the limit:

- **Timing:** *pre-call exact* (known before invoking) vs *post-call* (only known after / during
  generation).
- **Measurement source — the security-relevant axis:**
  - **CDS-measured** — trustworthy against a *hostile* app, because the CDS measures it directly:
    `requests` (count), `input` `bytes` (S3 object size via HEAD — no download, stays
    type-agnostic), `output` `bytes` (response / S3 size), `input`/`output` `tokens` (from
    Bedrock's returned usage), and `cost` (derived from those tokens). **The load-bearing spend
    cap rests entirely on this set** — a malicious app cannot under-report any of it.
  - **App-reported** — only as trustworthy as the app, because the CDS won't parse file internals
    (it stays type-agnostic): `megapixels`, `pages`, `frames`, `characters`, `tiles`,
    `duration_s`, `megapixel_seconds`, `credits`, and the `text/image/audio/video` classification
    of a request. A compromised or buggy app can under-report to evade its own limit. These are
    **operator cost-shaping conveniences, not a boundary against a hostile app** — and the app
    must have declared it can report the dimension (`reports` in §3.1) or a matching request is
    denied (fail closed).

  | Timing × source | Examples | Enforcement | UI caveat |
  |---|---|---|---|
  | pre-call, CDS-measured | `requests`; `input` `bytes` | hard pre-deny | none (hard limit) |
  | pre-call, app-reported | `input` `megapixels`/`pages`/`duration_s`/… | pre-deny on the app's claimed value | **"app-reported"** (input values the app supplies; can under-report) |
  | estimated pre-call, exact post-call, CDS-measured | `input` `tokens` (estimated before, Bedrock returns exact) | reserve on estimate, reconcile from Bedrock | none |
  | post-call, CDS-measured | `output` `bytes`/`tokens`; `cost` | reserve on projection (`max_tokens` ceiling + input estimate), reconcile | none |
  | post-call, app-reported | `output` `megapixels`/`duration_s`/… | reserve on projection if any, reconcile on the app's post-call report | **"best-effort"** (output values we fundamentally cannot know in advance) |

  The **two UI labels are distinct**: *app-reported* = input values the app provides (knowable
  before the call, but trust-limited); *best-effort* = output values that are fundamentally
  unknowable in advance (timing-limited, and where non-generic, app-reported too). CDS-measured
  dimensions carry no caveat and are styled as hard limits.

**Concurrency — bound large overages, tolerate small ones (reserve-on-ledger).** The goal is to
prevent a *flood* of concurrent requests from blowing far past a cap, not to make every cap
exact to the last request. DSQL uses **optimistic concurrency control** (no row locks; conflicting
writers get one commit and the rest retry with a serialization error), so a single per-`(scope,
dimension,period)` **counter row** would be a contention hotspot under a burst — the worst
structure for this. Instead, reserve on the **append-only ledger itself**, where each invoke
writes its *own distinct row* and therefore never conflicts:

1. Before the call, `INSERT` a **reservation row** with the worst-case projection (output ceiling
   from `max_tokens` + input estimate → projected cost).
2. Gate check = `SUM` over the period **including reservations**; deny 429 if it breaches.
3. After the call, `UPDATE` that row to actuals (or append an adjustment row) and true up.

The only staleness is reservations *in flight but not yet committed* when a racing request reads
the `SUM` — and that staleness **is** the overage, bounded by in-flight width. Cap in-flight width
with the **burst/rate gate** (already in the model) and the worst case is provable:

> worst-case overage ≤ (burst-rate limit) × (per-call max reserve)

both operator-set — no serializable transaction, no hot counter row.

**Check every request.** The gate `SUM` is checked on every invoke; at realistic volumes (tens of
thousands of ledger rows per period is an extreme outlier) an indexed scoped `SUM` on DSQL is
sub-millisecond and dwarfed by the multi-hundred-ms Bedrock call — well under 1% of request
latency. No running-aggregate cache and no check-amortization/leasing (which would reintroduce a
hot shared-state row and trade exactness for throughput we don't need). Skipping checks is where
overage bugs hide; the append-only reserve pattern above is what makes the per-request check both
cheap and concurrency-safe.

**Overridable defaults (per model, operator-overridable — see the registry in §3.6):**
- **Price table**, keyed by `(capability, model, dimension)` → rate — drives `cost` gates and
  the ledger. (For `bedrock.invoke`: input-token and output-token $/MTok.)
- **Pre-call estimation defaults** for dimensions not exactly known pre-call — currently the
  image-token estimate per model (post-call uses Bedrock's exact count). Bytes gates need no such
  default (measured from the referenced item); app-reported dimensions are supplied by the app.

**Ledger table** (DSQL): append-only, one row per invocation with a **dimension-generic**
measurement set — `(appId, capabilityName, model, ts, status, measurements[])` where each
measurement is `(dimension, unit, quantity)`, plus `estCostUsd`, and `status` distinguishes a
live reservation from a reconciled row. So any gate dimension sums over its period without a
schema change when new dimensions are added.

**Global kill switch / platform ceiling:** a global gate on each dimension so a bug in per-app
math can't run the whole AWS account away.

Wire this to `todo-cloud-dos-cost-amplification`; this plan closes part of that item for the
capability path.

**Adversarial tests:** concurrent calls racing a gate boundary (assert overage stays within the
provable bound), huge `max_tokens`, model spoofing, app-id spoofing, grant absent, app under-
reporting an app-reported dimension (assert only CDS-measured gates hold), request on a dimension
the app didn't declare in `reports` (assert deny), gate exactly at boundary, bytes-vs-tokens unit
mixing, price/estimate override changing mid-period, image-estimate under/over-shoot vs actual,
calendar-period rollover across the configured week/month boundary and timezone, and (for the
S3-location path) a session policy that must deny every key but the referenced one.

### 3.6 Bedrock specifics (model registry, ARNs, pricing, streaming, enablement)

- **Adapters and the Converse API.** The broker speaks to models through provider **request/
  response adapters**. The Bedrock **Converse API** normalizes request/response across providers
  for the text/vision path, so the two shipped adapters (**Anthropic** and **Amazon Nova**) share
  most of that path — this is what makes the deliberate multi-provider choice (§3.3) cheap. Raw
  `InvokeModel` with provider-specific bodies is the fallback for models Converse doesn't cover;
  image/video *generation* uses `InvokeModel` / `StartAsyncInvoke` (the latter deferred, §3.8).
- **Model IDs (Bedrock):** carry a provider prefix — e.g. `anthropic.claude-haiku-4-5`,
  `anthropic.claude-sonnet-5`, `anthropic.claude-opus-4-8`, `amazon.nova-lite`, `amazon.nova-pro`.
  Default to cost-sensitive models (Haiku 4.5 / Nova Lite) for app workloads.
- **Cross-region inference profiles:** newer models often require an **inference profile** for
  on-demand throughput rather than direct foundation-model invocation. The profile id is
  region-prefixed (e.g. `us.anthropic.claude-sonnet-5`). The boundary's all-Bedrock wildcard ARN
  scope (§3.3) already covers both the `inference-profile` and `foundation-model` ARNs across
  regions, so new profiles work without a boundary change.

- **Model registry — two layered tables (supersedes the earlier flag-flip design).** So the
  operator can adopt a new AWS model on AWS's cadence rather than waiting for a platform update,
  the effective value of any field is a lookup over two tables instead of a mutable per-row struct:

  - **Platform registry** — shipped with the code, read-only, versioned:
    `{ modelId, provider, inferenceProfileId?, defaults: { pricing{…per-dimension}, estimates{ imageTokens, … } } }`.
  - **Operator overrides** — a sparse table keyed by `modelId` (and field), operator-set.
  - `effective(modelId, field) = operatorOverride[field] ?? platformDefault[field]`.

  This gives exactly the sticky-override / catch-up behavior with no state machine:
  - **Operator-defined model:** an override row for a `modelId` the platform registry doesn't (yet)
    contain, required to be complete enough to gate/meter (else fall back to a global default).
  - **Platform later ships that model:** *nothing migrates* — the platform default simply begins
    to exist; `effective()` picks it up for any field the operator didn't override; overridden
    fields keep their value. The "source" (`platform` vs `user`) is **derived** ("is there a
    platform row?"), never stored or flipped.
  - **Clearing an override** = delete that field's override row → `effective()` re-adopts the
    platform default. No special case.
  - `provider` lets per-provider gates (§3.5) target a model's provider.
  - Manifest `models` membership is validated at install against this **effective registry**
    (platform ∪ operator overrides), per §3.1.

- **Client:** call via the AWS SDK `bedrock-runtime` (Converse / `ConverseStream` for the
  text/vision path), constructed with the assumed capability-role credentials. Region required.
- **Streaming (included — table stakes):** support `ConverseStream` /
  `InvokeModelWithResponseStream` — the broker streams the response back to the caller
  (chunked / SSE). This *helps* enforcement: output/cost gates can be aborted **mid-stream** the
  moment a hard per-request output ceiling is crossed, rather than only reserving on `max_tokens`.
  Ledger reconciliation happens on stream completion (or abort). See §3.7 for the client streaming
  surface and the browser base-path caveat.
- **No cost in the response.** Bedrock returns usage counts only, never dollars — cost is
  derived (§3.5), which is why exact-unit gates exist alongside the derived `cost` gate.
- **Pricing defaults for `cost` gates + the ledger** (first-party per-MTok reference; confirm
  Bedrock's published, region-specific rates) — these seed the registry `defaults.pricing`:
  - Haiku 4.5 — $1 in / $5 out
  - Sonnet 5 — $3 in / $15 out ($2 / $10 introductory through 2026-08-31)
  - Opus 4.8 — $5 in / $25 out
  - Amazon Nova Lite / Pro — confirm current per-MTok rates at implementation.
- **Account-level enablement (one-time foundational):** Bedrock model access must be enabled per
  account + region before any invoke succeeds. One-time platform/foundational step (not per-app,
  not per-call) — document in the deploy runbook and, if scriptable, fold into the CDS
  foundational deploy. Note this gates operator-defined models too: defining a model in the
  registry doesn't enable it in the AWS account.

### 3.7 Client SDK surface (`@starkeep/app-client`)

- Add a client method, e.g. `invokeCapability("bedrock.invoke", { model, contentRef,
  reports?, ...request })` — `contentRef` names a cloud-stored item; there is no bytes
  parameter. `reports` optionally carries the app's own measured non-generic input quantities
  (e.g. `{ "input:megapixels": 12.0 }`) for dimensions the app declared. **Capabilities are always
  served by the cloud CDS** (only it holds the capability role) — so `invokeCapability` resolves a
  *cloud* endpoint + cloud auth regardless of whether the app's data target is local or cloud:
  - **Cloud target:** call the API Gateway `/capabilities/...` route with the Bearer token,
    exactly like `/data/*`.
  - **Local target:** the app's local proxy signs with the app's HMAC secret (already on disk
    at `$STARKEEP_DATA_DIR/app-creds/`) and forwards to the cloud CDS over the
    server-to-server HMAC path. The local-data-server never calls Bedrock; it only proxies.
  - **Local-only install (no cloud plane):** capability unavailable — surface a clear error.
- **Streaming variant** (`invokeCapabilityStream`) for the streaming path. Browser callers use
  `fetch`/`EventSource`, which under the cloud `/apps/<appId>` base path **must go through
  `withBasePath`** or they 404 (the same same-origin invariant Photos already follows).
- **Post-call output reporting:** for app-reported *output* dimensions, the app reports measured
  output quantities back after it receives the response (a follow-up call or a field on stream
  completion); these are reconciled into the ledger as best-effort. Missing reports leave those
  best-effort gates un-updated (they never hard-block).
- **Granted-capabilities query** so an app can run degraded: expose which capabilities were
  granted (runtime-config style), and have `invokeCapability` on an ungranted capability return
  a well-defined "not granted" result rather than throwing.
- Apps never hold Bedrock creds; they call the broker endpoint like `/data/*`.
- Document it in `authoring-an-app.md` under a new "Capabilities" subsection (parallel to the
  file-access grant note), including the `reports` contract and the app-reported vs best-effort
  distinction.

### 3.8 Non-text output modalities (design sketch — deferred, not built now)

The wired increment returns **text** (captioning/tagging), reconciled inline. Non-text output is
sketched here so the gate model and the session-policy pattern are designed to extend to it, but
**none of this is implemented in the initial stage** — revisit once the text path is working.

Output splits three ways:

- **Text** (in scope) — returned inline in the sync/stream response; CDS reconciles tokens/cost.
- **Small synchronous binary** (image/audio; e.g. Nova Canvas returns base64) — the CDS gets the
  bytes back like text. To stay type-agnostic and keep the capability role write-free, **return
  the bytes to the app and let the app write them via the normal data plane under its own role**
  (mirror of by-reference input). Large binary through the broker response hits the same
  size/timeout wall as inline input. *Buildable next, low complexity — but out of the first cut.*
- **Video / large / long-running, asynchronous** (deferred) — `StartAsyncInvoke` writes output
  **directly to an S3 URI** you supply (`outputDataConfig.s3OutputDataConfig.s3Uri`; e.g. Nova
  Reel writes `output.mp4` + `manifest.json` + `generation-status.json` under an invocation-id
  folder). This is the **mirror image** of the S3-location *input* problem: Bedrock's S3 *write*
  happens under the capability role, so it needs a **session-scoped `s3:PutObject`** to a single
  per-invocation output key (same downscoping pattern and same risk callout as §3.4), after which
  the object is **ingested as a normal starkeep record under the app role**. Async also **breaks
  the synchronous reserve→invoke→reconcile flow**: reserve on projection, kick off the job, and
  reconcile on *completion* via poll/`GetAsyncInvoke` or an EventBridge job-completion signal
  (needs `bedrock:GetAsyncInvoke`/`ListAsyncInvokes` too). That job-tracking control-flow is the
  main reason it's deferred. Output `bytes` gating works across all three modalities (response
  size, or post-completion S3 HEAD); type-specific output (image megapixels, video duration) is
  app-reported best-effort per §3.5.

---

## 4. Data flow

How a request actually moves through the system, for the motivating case: **Photos wants to
send a shared photo to Bedrock for a computer-vision prompt.**

### 4.1 Cloud-origin (Photos browser, image already in starkeep cloud)

By-reference is the only path — the app names the image, the broker reads it server-side; the
browser never sends the bytes:

1. Photos browser (Cognito JWT) → **CloudFront** → shared **API Gateway** → **CDS Lambda**,
   `POST /capabilities/bedrock.invoke` with the prompt + the image's record id / object key.
2. CDS authorizes the user (JWT), identifies the app (photos), checks the `capability_grants`
   row and that the model is approved, then runs the **gate check** (§3.5) against the ledger
   (writing a reservation row).
3. CDS **assumes `app-photos-role`** and confirms/reads the image from `shared/image/...` in
   **S3** — the *existing data path*, bounded by the app's per-app boundary + app-layer type
   filter. This is the source of truth for "which object may be fed to Bedrock."
4. CDS **assumes `capability-broker-role`** (single hop; if S3-location, with an inline session
   policy scoped to that one object key) and calls **Bedrock** via the Converse API (using the
   inference profile) with the image (inline base64, or by S3 URI) + prompt.
5. Bedrock returns text + token usage; CDS reconciles the **ledger** reservation to actuals
   (DSQL) and returns the result to the client.

**Load-bearing property:** because step 3 authorizes the read through the app's *own* per-app
role, the capability role holds only `bedrock:InvokeModel` (plus, on the S3-location path, a
single-key session-scoped `s3:GetObject`), and there is no inline-bytes path *from the caller*,
**an app can only feed Bedrock content it already has data-plane grants to read.** The two
brokered capabilities compose: data-authorization under the app's identity, invoke under the
capability identity — and the broker has no side channel that bypasses the data-authorization.

AWS pieces touched: Cognito, CloudFront (non-security edge), API Gateway, CDS Lambda, IAM (two
single-hop assumes), S3, DSQL (grants + ledger), Bedrock.

### 4.2 Local-origin (Photos running against the local-data-server)

Constraint (resolved): **only the cloud CDS ever calls Bedrock** — the local-data-server holds
no AWS credentials by design. A locally-running app still *reaches* the cloud broker: its local
proxy signs the capability call with the app's HMAC secret and **forwards the reference to the
cloud CDS over the server-to-server HMAC path** — it proxies, it does not broker, and it never
ships bytes.

Because the broker is by-reference only, the item **must already be readable in cloud storage**:

- **Synced to cloud** (Drive sync shipped it to `shared/image/...`, record Resident): works
  exactly as 4.1 — the cloud CDS reads it under `app-photos-role`. Requires the app to be
  cloud-installed (so it *has* a per-app role).
- **Only local** (not yet synced, or record Staged): the capability is **unavailable for that
  item** until it syncs. There is no inline fallback — the honest constraint of closing the
  byte-ingestion surface. The app either waits for sync or triggers it first.

**Honest edge:** a *purely local install with no cloud plane* has no CDS, no capability role,
and nothing in cloud storage — capabilities are entirely unavailable there. Capabilities are a
cloud-plane feature; `invokeCapability` errors clearly when no cloud endpoint/auth is
configured or the referenced item isn't resident in the cloud.

Components involved (local-origin): local Photos client → local proxy (HMAC-signs the
reference, forwards) → cloud API Gateway → CDS Lambda → assume per-app role, authorize the item
in cloud storage → gate check → assume capability role → Bedrock → ledger → response. The
local-data-server is a signing proxy here, never the broker, and no local bytes leave the
device through this path.

---

## 5. Testing / hookup requirements

Per `CLAUDE.md`, everything built must be fully hooked up and testable — no disconnected
modules:

- Extend an existing first-party app (Photos is the natural fit — captioning/tagging over
  images) to declare and actually call `bedrock.invoke`, so the path is exercised end to end.
- e2e (`e2e-aws`) coverage: install an app with a capability grant → invoke by-reference →
  observe a real Bedrock response → observe the ledger row → exceed a gate → observe the 429.
  Cover **both providers** in the shipped adapter set (Anthropic + Amazon Nova) so the
  multi-provider path is real, not latent.
- Cover both origins (§4): cloud-origin by-reference, and local-origin by-reference via the
  proxy (item already synced to cloud); assert that an unsynced/local-only reference is
  rejected, not byte-ingested.
- Cover the trust boundary: an app under-reporting an app-reported dimension is bounded only by
  CDS-measured gates; a request on a dimension the app didn't declare in `reports` is denied.

---

## 6. Open questions

Resolved in discussion:
1. **Local capability path** — capabilities are cloud-brokered only (the local-data-server holds
   no AWS creds); a locally-running app reaches the cloud CDS via its HMAC-signing local proxy. §4.2.
2. **Optional vs required grants** — per-capability `required` flag; `required: false` runs the
   app degraded when denied, with a granted-capabilities query and a well-defined "not granted"
   result. §3.1, §3.2, §3.7.
3. **Gate window** — calendar periods, operator-configurable **week or month** (default month),
   timezone-aligned; a closed gate is a hard 429. §3.5.
4. **Streaming** — included (table stakes); also lets output gates abort mid-stream. §3.6, §3.7.
5. **Model registry governance** — operators may define models, via **two layered tables**
   (platform registry ∪ operator overrides, `effective = override ?? default`); no flag-flip
   state machine. §3.6.
6. **By-reference vs inline** — by-reference only for *caller-supplied* content; content must be
   readable in cloud storage first. Bytes reach Bedrock either inline (base64) or by S3 URI, both
   server-side under authorized identities. §3.4, §4.
7. **Boundary ARN scope** — IAM is **all-or-nothing** for Bedrock invoke (`arn:aws:bedrock:*:*:*`):
   nothing special about any provider, and *all* provider/model restriction lives in the framework
   (registry + grant `models` + per-provider/per-model gates), not in the boundary. Considered and
   **rejected** scoping IAM to the adapter/provider set — keeping IAM out of provider/model policy
   is worth more than the defense-in-depth a provider wildcard would add. The *adapter* set is
   still a deliberate multi-provider choice (Anthropic + Amazon Nova), but that lives in code/registry,
   not IAM. §3.3.
8. **Dimension model** — `certainty` dropped; replaced by two orthogonal axes (timing;
   measurement source = CDS-measured vs app-reported). `requests` takes a modality unit
   `[all,text,image,audio,video]`; type-specific quantities are **units of `input`/`output`**;
   added generic `credits`/`count`. Apps declare reportable non-generic dimensions in the
   manifest (`reports`); an undeclared-dimension limit fails closed. §3.1, §3.5.
9. **`onExceed` modes** — deny-only (429) for this increment; the soft `notify`/budget mode and
   its delivery channel are **not** built now.

Remaining truly-open items:
10. **Session-policy downscoping (risk area)** — the S3-location I/O path (§3.4, §3.8) depends on
    per-assume inline session policies correctly narrowing S3 access to a single key. **Prove this
    out first** (§7 step 1); if it fails, fall back to inline-only for the initial increment and
    revisit. Until proven, treat the S3-location path as provisional.
11. **Other-provider request shaping (beyond the initial two)** — a third provider needs its own
    adapter (or Converse coverage) and a registry entry; **no boundary change** (IAM is
    all-Bedrock). §3.3, §3.6.

---

## 7. Sequencing

1. **Proof-of-concept: session-policy downscoping** (de-risk first). Validate that assuming the
   capability-broker role with an inline session policy narrows `s3:GetObject` to exactly one
   object key and denies all others. If it holds, the S3-location input path (and, later, the
   async S3-output path in §3.8) is viable; if not, scope the initial increment to inline-base64
   only and revisit. Gate the §3.3/§3.4 S3 decisions on this result.
2. Manifest schema + author-time validator (`capabilities[]`, `required`, `reports`) and the
   platform capability registry.
3. Capability-broker boundary in bootstrap (all-Bedrock invoke, all-or-nothing per §3.3; include
   session-scoped S3 only if step 1 passed) + teardown-script update; capability role mint at
   deploy with CDS-only trust; `sts:AssumeRole` add to CDS boundary.
4. Model registry (two layered tables: platform registry + operator overrides); `capability_grants`
   + dimension-generic gate table + append-only ledger; install/uninstall wiring (incl.
   install-time effective-registry validation of `models`, consent gate, `reports` persistence) +
   admin consent & degraded-grant UI (with the app-reported / best-effort labels).
5. Broker route in CDS: auth → grant check → by-reference data authorization (per-app role) →
   gate check (reserve-on-ledger) → assume capability role → Bedrock invoke via Converse
   (buffered) → ledger reconcile → return. Both shipped providers.
6. Gate/cost-governance subsystem (open dimension set, two-axis enforcement, calendar week/month
   windows, reserve-on-ledger concurrency with burst-bounded overage, price/estimate overrides,
   global kill switch) + adversarial tests.
7. Streaming path (`ConverseStream` / `InvokeModelWithResponseStream`, mid-stream output-gate
   abort).
8. `app-client` `invokeCapability` + `invokeCapabilityStream` (cloud endpoint resolution, local
   proxy forwarding, granted-capabilities query, `reports` in/out, base-path-safe browser
   streaming) + `authoring-an-app.md` docs.
9. Photos integration + `e2e-aws` coverage (both providers, both origins, degraded-grant path,
   trust-boundary assertions).

*(Deferred to a later increment, not built now: small synchronous binary output; async
S3-output/video via `StartAsyncInvoke` with job tracking — §3.8.)*
