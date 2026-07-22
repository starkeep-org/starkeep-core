# Plan — Cloud capability broker (Bedrock on-demand invoke)

**Date:** 2026-07-22
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
  **capability role** holds that verb (on an allowlist of model ARNs), and the CDS
  **assumes it per capability request** — mirroring how the CDS assumes each app's per-app
  role for data operations. This preserves the load-bearing property that the CDS's own
  standing identity never carries the sensitive operation verb.
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

---

## 2. Alignment with `data-roles-and-permissions.md`

Per the "check the roles doc first" rule, here is how each piece lands against the stated
stance before we touch any IAM / trust-policy / boundary code:

- **Principle 1 (data stays confined):** unchanged. The capability path touches no user
  data store. Attribution of *who invoked* is by authenticated app id + metering ledger,
  not IAM principal — the same attribute-based model the Drive sync path already uses
  (`origin_app_id`) rather than sole-identity IAM proof.
- **Principle 2 (powerful permissions centralized, bounded, ephemeral):** the capability
  verb lives on **one** dedicated capability role under a **new narrow boundary**, reached
  only by assumption from the CDS — not standing on any app role, and not standing on the
  CDS's own foundational boundary. This is the same "borrow it per request" shape as the
  per-app data assume.
- **Principle 3 (layered ceilings):** capability access is gated by (a) the capability role's
  IAM ceiling (Bedrock-invoke-only — nothing else, but **all Bedrock models**, by decision), (b)
  the install-time grant rows + effective model registry, and (c) the per-request gate framework
  (provider/model/app/global limits on an open set of dimensions). A bug in any one is bounded by
  the next. Deliberate departure from the data plane's shape: IAM here is **not** the layer that
  cuts by model/provider — that cut lives entirely in (b)+(c), so model policy tracks AWS's
  cadence, not the platform's. The compensating floor is that IAM still confines the role to
  *invoke only*, and the gate framework bounds *cost* — a dimension IAM cannot express.
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
    "models": ["anthropic.claude-haiku-4-5", "anthropic.claude-sonnet-5"],
    "required": false,                  // optional → app runs degraded if the user denies it
    "requestedMonthlyBudgetUsd": 20,    // user-facing consent figure; becomes a per-app cost gate on approval
    "rationale": "Generate captions and tags for your photos."
  }
]
```

- `name` — from a **platform-owned capability registry** (hardcoded, like the type/category
  registry). Apps cannot invent capabilities. Only `bedrock.invoke` exists initially.
- `models` — the model ids the app may call. Validated at **install** time against the
  operator's *effective* model registry (platform registry ∪ operator-defined models — see
  3.6), not at author time (author-time `validateManifest()` can only check shape, since it has
  no operator context). A referenced model that is neither platform-known nor operator-defined
  fails the install grant step until the operator defines it.
- `required` — `true` (default) means the app can't function without the capability and the
  install is blocked if denied; `false` means the app treats it as optional and **runs
  degraded** if the user denies it (mirrors `requiredPermissions` / `optionalPermissions`).
- `requestedMonthlyBudgetUsd` — the spend figure shown to the user for consent
  ("this app may use Bedrock, up to ~$X/mo"). On approval it is stored as **one per-app cost
  gate** in the gate table (3.5) — it is *not* a special mechanism; it is the app-consent
  origin of an ordinary gate, which the operator can then tighten or supplement.
- `rationale` — shown at install, like `fileAccess.rationale`.

Add `validateManifest()` coverage (author-time, shape only): reject unknown capability names,
malformed model ids, and (as with `fileAccessAll` / `brokerPower`) reserve any privileged
capability names so third-party apps can't claim them. Effective-registry membership of
`models` is checked at install, not here.

### 3.2 Install / grant persistence (`@starkeep/admin-installer`, data plane)

- New table `capability_grants` (parallel to `shared_access_grants`): one row per
  `(appId, capabilityName)` with the approved `models` list.
- On approval, also write the app's `requestedMonthlyBudgetUsd` as a per-app cost gate into
  the gate table (3.5).
- Install step (after the manifest grants step): write the grant row (+ consent gate).
  Uninstall: delete them (and the app's metering/ledger rows — see 3.5).
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
  registry + per-app grant `models` list + per-provider/per-model gates (3.5). **Trade-off,
  accepted:** the capability role can invoke any Bedrock model (a compromised broker could reach
  an expensive non-Anthropic model), bounded by the global cost kill switch and per-provider
  gates, and by the fact that the role can *still only invoke Bedrock*, nothing else — no data,
  no other services. This is a deliberate loosening of layer-1 IAM on the model dimension in
  exchange for the app-layer framework being the single, cadence-free control point.
  (Note: the *wired* `bedrock.invoke` implementation initially handles Anthropic Messages-shaped
  request/response only; other-provider request shaping is a later framework/adapter addition —
  but it will *not* require a boundary change, which is the point.)
- **Deploy (CDS Phase 2, or a small dedicated step):** mint `...-capability-broker-role`
  under that boundary, with a **trust policy naming the CDS role** as principal (single-hop
  assume, same as per-app roles). A magic-string check routes only this reserved id to the
  boundary so no third-party app can opt in.
- **CDS foundational boundary change:** add only `sts:AssumeRole` onto the capability-broker
  role. Do **not** add any `bedrock:*` verb to the CDS's own boundary.
- **Teardown:** update `scripts/teardown-bootstrap.sh` in lockstep (the capability-broker
  boundary is a non-CFN-safe / manually-tracked resource per the teardown-script rule).

### 3.4 Broker route (cloud-data-server)

- New route, capability-keyed: `POST /capabilities/:name/invoke` (only `bedrock.invoke`
  handled initially; unknown names → 404). Accepts both the browser JWT+app-id path and the
  server-to-server HMAC path (the latter is how a locally-running app's proxy reaches it —
  see §4 Data flow).
- **Content is supplied by reference only** (record id / object key of a cloud-stored item).
  The broker has **no inline-bytes path** — it never accepts caller-supplied content. The only
  way bytes reach Bedrock is a grant-checked read from normal cloud storage under the app's own
  role. This deliberately means content that is not in readable cloud storage (unsynced local
  items, app-specific data the reference scheme doesn't cover) cannot be fed to Bedrock; it must
  reach the cloud data plane first.
- Handler flow (reuses existing CDS auth):
  1. Authorize user (JWT or HMAC) + identify calling app (existing verifier).
  2. Look up the app's `capability_grants` row for `bedrock.invoke`; 403 if none.
  3. Validate the requested model is in the app's approved `models`; 403 otherwise.
  4. **Assume the calling app's per-app role** and read the referenced item from cloud storage
     (`shared/<category>/...`, or the app's own `apps/<appId>/syncable/...`) — the existing data
     path, bounded by the app's grants. 404/403 if the app can't read it or it isn't resident.
  5. **Gate chokepoint** (3.5) — project the request against every matching gate; reject 429 if
     any would be breached (reserve on `max_tokens` / input estimate for output/cost gates).
  6. **Assume `...-capability-broker-role`** (single hop) for the duration of the call.
  7. Call Bedrock under the assumed creds (see 3.6), stream/collect the response.
  8. Reconcile the ledger with actual token/byte usage (3.5); return the model response.
- Keep the capability handler code-isolated from the data-path handlers (shared process, so
  the boundary is code discipline + tests, not a process boundary) so a bug in capability
  handling can't corrupt data-path auth.

### 3.5 Usage gates + cost governance (the security-critical subsystem)

This is the new load-bearing control. Build and test it as security code. **Bedrock does not
return a dollar cost** — only token counts (`X-Amzn-Bedrock-Input/Output-Token-Count`, or
`usage.input_tokens`/`output_tokens`). Cost is always *derived* from a price table and is
therefore an estimate that drifts. So enforcement is **not** a single dollar cap; it is a set
of independent gates ordered by how certain the measured quantity is, so the operator never
has to rely on the fragile derived number if they don't want to.

**Gate model.** A gate is `(dimension, unit, scope, window, limit)`:

- `dimension` — an **open set**, not a fixed enum, because AI services bill on genuinely
  different well-defined units. The schema must not hardcode four dimensions; a dimension is
  `(name, unit, certainty)` declared by each capability's spec. Anticipated dimensions (design
  the schema to hold all of them; only the `bedrock.invoke` ones are *wired* now):

  | Dimension | Unit(s) | Typical service |
  |---|---|---|
  | `requests` | count | all |
  | `input` | tokens \| bytes | LLM / embeddings / vision (**wired**) |
  | `output` | tokens \| bytes | LLM (**wired**) |
  | `images` | count | vision input, image-gen output |
  | `megapixels` | megapixels | image resolution |
  | `duration` | seconds | audio transcription/TTS, video analysis/generation |
  | `characters` | count | TTS (Polly per-char), Translate, Comprehend |
  | `pages` | count | document AI (Textract) |
  | `frames` | count | video analysis |
  | `cost` | usd | all (derived) |

- `unit` — a dimension may allow more than one (e.g. `input` as `tokens` **or** `bytes`; bytes
  are exact and tokenizer-free, tokens track billing closer but need estimation for images).
- `scope` — any combination of global, **per-provider**, per-model, per-app (freely combined —
  a per-app-per-model gate sets both keys). Omitting all keys = global. Per-provider matters
  because IAM no longer constrains provider/model (3.3) — provider/model policy lives entirely
  here.
- `window` — for **cumulative** caps, a **calendar** accounting period: **`week` or `month`,
  operator-configurable** (default month), aligned to a configured timezone (calendar week
  starts Monday). "Reset" is implicit: gates sum only ledger rows within the current period.
  **Burst/rate** gates use a separate short window (per-second/minute) and are orthogonal to the
  accounting period.
- `onExceed` — **`deny` (default) or `notify`**, per gate. `deny` rejects the over-limit request
  (429). `notify` lets the request proceed but fires an alert to the operator (channel TBD —
  admin-web surface / notification hook) and logs the crossing, turning that gate into a soft
  budget/warning rather than a hard cap. Operators pick per gate.
- **Semantics: every gate whose scope matches the request is evaluated; if *any* `deny` gate
  would be exceeded, reject (429); `notify` gates that are exceeded fire an alert but don't
  block.** Each gate is optional — the operator sets whichever they want and leaves the rest
  unbounded. (The install-time consent budget from 3.2 is one per-app `cost`/`usd` gate in this
  same table, defaulting to `deny`.)

**Certainty tiers and when each is enforced.** Each dimension declares a certainty tier that
decides pre- vs post-call handling:

| Tier | Examples | Enforcement |
|---|---|---|
| exact pre-call | `requests` (count); `input` bytes (size of the referenced object); `characters`, `pages`, `duration`, `megapixels`, `images` of the *input* (all derivable from the referenced item) | pre-call hard-deny |
| estimated pre-call, exact post-call | `input` tokens (Bedrock's returned `input_tokens` includes image tokens; estimated before) | reserve on estimate, reconcile post-call |
| exact post-call only | `output` (all units) — not known until generation finishes | reserve using `max_tokens` / a per-dimension output ceiling, reconcile post-call |
| derived | `cost` = usage × price table | reserve on the ceiling projection, reconcile post-call |

Pre-call gates deny up front. Post-call/derived gates **reserve-then-reconcile**: project the
worst case (output ceiling + input estimate), deny if the projection would breach any gate,
then write actual usage to the ledger and true up.

**Overridable defaults (per model, operator-overridable — see the registry in 3.6).** Because
the uncertain quantities change and errors are easy:
- **Price table**, keyed by `(capability, model, dimension)` → rate — drives `cost` gates and
  the ledger. (For `bedrock.invoke`: input-token and output-token $/MTok. A future
  transcription capability would add $/audio-minute, TTS $/1M-characters, video-gen $/second.)
- **Pre-call estimation defaults** for dimensions not exactly known pre-call — currently the
  image-token estimate per model (post-call uses Bedrock's exact count). Bytes/duration/pages
  gates need no such default; they're measured from the referenced item.

**Ledger table** (DSQL): append-only, one row per invocation with a **dimension-generic**
measurement set — `(appId, capabilityName, model, ts, measurements[])` where each measurement
is `(dimension, unit, quantity)`, plus `estCostUsd`. So any gate dimension sums over its
period without a schema change when new dimensions are added.

**Global kill switch / platform ceiling:** a global gate on each dimension so a bug in per-app
math can't run the whole AWS account away.

Wire this to `todo-cloud-dos-cost-amplification`; this plan closes part of that item for the
capability path.

**Adversarial tests:** concurrent calls racing a gate boundary, huge `max_tokens`, model
spoofing, app-id spoofing, grant absent, gate exactly at boundary, bytes-vs-tokens unit
mixing, price/estimate override changing mid-period, image-estimate under/over-shoot vs actual,
calendar-period rollover across the configured week/month boundary and timezone.

### 3.6 Bedrock specifics (model registry, ARNs, pricing, streaming, enablement)

- **Model IDs (Bedrock):** carry an `anthropic.` prefix — `anthropic.claude-haiku-4-5`,
  `anthropic.claude-sonnet-5`, `anthropic.claude-opus-4-8`. Default to Haiku 4.5 / Sonnet 5 for
  cost-sensitive app workloads.
- **Cross-region inference profiles:** newer models often require an **inference profile** for
  on-demand throughput rather than direct foundation-model invocation. The profile id is
  region-prefixed (e.g. `us.anthropic.claude-sonnet-5`). The boundary's wildcard ARN scope
  (3.3) already covers both the `inference-profile` and `foundation-model` ARNs across regions,
  so new profiles work without a boundary change.

- **Model registry with defaults vs overrides (supports operator-defined models).** So the
  operator can adopt a new AWS model on AWS's cadence rather than waiting for a platform update,
  each registry entry layers two sources:

  ```
  { modelId, provider, inferenceProfileId?, source: "platform" | "user",
    defaults: { pricing{...per-dimension}, estimates{ imageTokens, ... } } | null,  // platform-provided
    overrides: { ...same shape, sparse } }                                          // operator-set, sticky
  effective(field) = overrides[field] ?? defaults[field]
  ```

  `provider` lets per-provider gates (3.5) target a model's provider — the framework, not IAM,
  is where provider policy lives.

  - **Operator-defined model:** `source: "user"`, `defaults: null`, `overrides` = the values the
    operator entered (must be complete enough to gate/meter, else fall back to a global default).
  - **Platform later adds the same model:** `source` flips to `"platform"`, `defaults` get
    populated, **`overrides` are untouched.** Fields the operator overrode keep their value;
    fields they didn't now pick up the platform default (instead of being unset). This is exactly
    the reconciliation we want — the only change the operator sees is the flag flipping and
    previously-unset fields gaining platform defaults.
  - **Clearing an override** re-adopts the platform default (needed so a value entered only to
    fill a gap doesn't permanently shadow the platform's corrected number).
  - Manifest `models` membership is validated at install against this **effective registry**
    (platform ∪ user), per 3.1.

- **Client:** call via the AWS SDK `bedrock-runtime`, or the Anthropic Bedrock **Mantle** client
  (`@anthropic-ai/bedrock-sdk` → `AnthropicBedrockMantle({ awsRegion })`), constructed with the
  assumed capability-role credentials. Region required.
- **Streaming (included):** support `InvokeModelWithResponseStream` — the broker streams the
  response back to the caller (chunked / SSE). This *helps* enforcement: output/cost gates can
  be aborted **mid-stream** the moment a hard per-request output ceiling is crossed, rather than
  only reserving on `max_tokens`. Ledger reconciliation happens on stream completion (or abort).
  See §3.7 for the client streaming surface and the browser base-path caveat.
- **No cost in the response.** Bedrock returns usage counts only, never dollars — cost is
  derived (3.5), which is why exact-unit gates exist alongside the derived `cost` gate.
- **Pricing defaults for `cost` gates + the ledger** (first-party per-MTok reference; confirm
  Bedrock's published, region-specific rates) — these seed the registry `defaults.pricing`:
  - Haiku 4.5 — $1 in / $5 out
  - Sonnet 5 — $3 in / $15 out ($2 / $10 introductory through 2026-08-31)
  - Opus 4.8 — $5 in / $25 out
- **Account-level enablement (one-time foundational):** Bedrock model access must be enabled per
  account + region before any invoke succeeds. One-time platform/foundational step (not per-app,
  not per-call) — document in the deploy runbook and, if scriptable, fold into the CDS
  foundational deploy. Note this gates operator-defined models too: defining a model in the
  registry doesn't enable it in the AWS account.

### 3.7 Client SDK surface (`@starkeep/app-client`)

- Add a client method, e.g. `invokeCapability("bedrock.invoke", { model, contentRef,
  ...request })` — `contentRef` names a cloud-stored item; there is no bytes parameter.
  **Capabilities are always served by the cloud CDS** (only it holds the capability role) — so
  `invokeCapability` resolves a *cloud* endpoint + cloud auth regardless of whether the app's
  data target is local or cloud:
  - **Cloud target:** call the API Gateway `/capabilities/...` route with the Bearer token,
    exactly like `/data/*`.
  - **Local target:** the app's local proxy signs with the app's HMAC secret (already on disk
    at `$STARKEEP_DATA_DIR/app-creds/`) and forwards to the cloud CDS over the
    server-to-server HMAC path. The local-data-server never calls Bedrock; it only proxies.
  - **Local-only install (no cloud plane):** capability unavailable — surface a clear error.
- **Streaming variant** (`invokeCapabilityStream`) for `InvokeModelWithResponseStream`. Browser
  callers use `fetch`/`EventSource`, which under the cloud `/apps/<appId>` base path **must go
  through `withBasePath`** or they 404 (the same same-origin invariant Photos already follows).
- **Granted-capabilities query** so an app can run degraded: expose which capabilities were
  granted (runtime-config style), and have `invokeCapability` on an ungranted capability return
  a well-defined "not granted" result rather than throwing.
- Apps never hold Bedrock creds; they call the broker endpoint like `/data/*`.
- Document it in `authoring-an-app.md` under a new "Capabilities" subsection (parallel to the
  file-access grant note).

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
   row and that the model is approved, then runs the **gate check** (3.5) against the ledger.
3. CDS **assumes `app-photos-role`** and reads the image from `shared/image/...` in **S3** —
   the *existing data path*, bounded by the app's per-app boundary + app-layer type filter.
4. CDS **assumes `capability-broker-role`** and calls **Bedrock** `InvokeModel` (via the
   inference profile) with the image + prompt.
5. Bedrock returns text + token usage; CDS reconciles the **ledger** (DSQL) and returns the
   result to the client.

**Load-bearing property:** because step 3 goes through the app's *own* per-app role, the
capability role holds only `bedrock:InvokeModel` (no S3), and there is no inline-bytes path,
**an app can only feed Bedrock content it already has data-plane grants to read.** The two
brokered capabilities compose: data-read under the app's identity, invoke under the capability
identity — and the broker has no side channel that bypasses the data-read.

AWS pieces touched: Cognito, CloudFront (non-security edge), API Gateway, CDS Lambda, IAM (two
single-hop assumes), S3, DSQL (grants + ledger), Bedrock.

### 4.2 Local-origin (Photos running against the local-data-server)

Constraint (open question #1, resolved): **only the cloud CDS ever calls Bedrock** — the
local-data-server holds no AWS credentials by design. A locally-running app still *reaches* the
cloud broker: its local proxy signs the capability call with the app's HMAC secret and
**forwards the reference to the cloud CDS over the server-to-server HMAC path** — it proxies, it
does not broker, and it never ships bytes.

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
reference, forwards) → cloud API Gateway → CDS Lambda → assume per-app role, read the item from
cloud storage → gate check → assume capability role → Bedrock → ledger → response. The
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
- Cover both origins (§4): cloud-origin by-reference, and local-origin by-reference via the
  proxy (item already synced to cloud); assert that an unsynced/local-only reference is
  rejected, not byte-ingested.

---

## 6. Open questions

1. ~~**Local capability path.**~~ **Resolved:** capabilities are cloud-brokered only (the
   local-data-server holds no AWS creds); a locally-running app reaches the cloud CDS via its
   HMAC-signing local proxy. See §4.2.
2. ~~**Optional vs required grants.**~~ **Resolved:** yes — per-capability `required` flag;
   `required: false` runs the app degraded when denied, with a granted-capabilities query and a
   well-defined "not granted" result. See §3.1, §3.2, §3.7.
3. ~~**Gate window.**~~ **Resolved:** calendar periods, operator-configurable **week or month**
   (default month), timezone-aligned; a closed gate is a hard 429. See §3.5.
4. ~~**Streaming.**~~ **Resolved:** include `InvokeModelWithResponseStream`; also lets output
   gates abort mid-stream. See §3.6, §3.7.
5. ~~**Model registry governance.**~~ **Resolved:** operators may define models (not just the
   platform), with defaults-vs-overrides reconciliation on platform catch-up. See §3.6.
6. ~~**By-reference vs inline.**~~ **Resolved:** by-reference only — the broker has no
   inline-bytes path, so content must be readable in cloud storage first (see §3.4, §4).
7. ~~**Boundary ARN scope.**~~ **Resolved:** IAM is all-or-nothing for Bedrock invoke — nothing
   special about any provider — and *all* provider/model restriction lives in the
   usage-limitation framework (registry + grant `models` + per-provider/per-model gates), not in
   the boundary. See §3.3.

Remaining truly-open items:
8. **`onExceed: notify` delivery channel:** where the alert goes (admin-web surface, a
   notification hook, a log-only signal) — mechanism TBD.
9. **Other-provider request shaping:** the `bedrock.invoke` implementation handles Anthropic
   Messages-shaped requests initially; non-Anthropic Bedrock models need per-provider request
   adapters before they're actually invokable (no boundary change needed — framework only).

---

## 7. Sequencing

1. Manifest schema + author-time validator (`capabilities[]`, `required` flag) and the
   platform capability registry.
2. Capability-broker boundary in bootstrap (all-Bedrock invoke, all-or-nothing per §3.3) +
   teardown-script update; capability role mint at deploy with CDS-only trust; `sts:AssumeRole`
   add to CDS boundary.
3. Model registry (defaults vs overrides, operator-defined + platform-catch-up reconciliation);
   `capability_grants` + dimension-generic gate table + ledger; install/uninstall wiring
   (incl. install-time effective-registry validation of `models`, consent gate) + admin consent
   & degraded-grant UI.
4. Broker route in CDS: auth → grant check → by-reference data read (per-app role) → gate check
   → assume capability role → Bedrock invoke (buffered) → ledger reconcile → return.
5. Gate/cost-governance subsystem (open dimension set, calendar week/month windows,
   reserve-then-reconcile, price/estimate overrides, global kill switch) + adversarial tests.
6. Streaming path (`InvokeModelWithResponseStream`, mid-stream output-gate abort).
7. `app-client` `invokeCapability` + `invokeCapabilityStream` (cloud endpoint resolution, local
   proxy forwarding, granted-capabilities query, base-path-safe browser streaming) +
   `authoring-an-app.md` docs.
8. Photos integration + `e2e-aws` coverage (both origins, degraded-grant path).
