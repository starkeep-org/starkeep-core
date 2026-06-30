# Cloud API: no rate limiting / DoS & cost-amplification protection

The shared API Gateway has **no rate limiting, throttling, usage quota, or WAF**,
and exposes internet-reachable unauthenticated surface: `GET /health`,
`OPTIONS /{proxy+}`, and any app route declared `auth: "public"` (e.g. the Photos
`static` handler). The HMAC-gated reserved routes (`/apps/{appId}/{data,files,sync,
app-data}/*`) still do work *before* they can reject an unsigned caller — at
minimum an SSM `GetParameter` to load the per-app secret (`loadAppHmacSecret`)
plus the signature check — so even traffic that ultimately 401s is not free.

Because the data plane is fully serverless (Lambda + Aurora DSQL + S3,
pay-per-use), volumetric abuse translates **directly into the customer's AWS
bill** rather than into a clean hard outage: there is no fixed-capacity tier to
saturate, so the failure mode is cost, not (primarily) unavailability. An
attacker who can reach the gateway hostname — or a buggy/runaway app — can drive
unbounded Lambda invocations, DSQL connections, and SSM reads.

This is the most realistic internet-facing harm for any live deployment, and
it is currently undefended.

Scope / candidate mitigations (none committed):

- **API Gateway throttling.** Set route- or stage-level throttle + burst limits
  on the shared gateway. Cheapest first step; bounds the blast radius of every
  route at once.
- **Per-app / per-route quotas.** Usage plans or per-app throttles so one app (or
  one app's leaked HMAC secret) cannot exhaust the whole deployment's budget.
- **Reject unsigned callers before the SSM read where possible.** Cheap header
  presence/shape checks (`X-Starkeep-App-{Id,Sig,Ts}` present, app id well-formed)
  can 400/401 obvious junk before the per-app secret fetch, lowering the cost of
  hostile traffic on the HMAC-gated routes.
- **Billing alarm / budget guardrail.** A CloudWatch billing alarm or AWS Budgets
  action as a backstop so cost-amplification is at least *detected* quickly even
  before throttles are tuned.
- **Front the gateway with WAF** (rate-based rules) if/when the public surface
  grows — heavier; probably not needed at single-operator scale.

Note: this todo is the *availability/cost* axis only. The related **unbounded
storage growth** problem (tombstoned shared-record blobs and `parent_id` are
never reclaimed) is its own concern, tracked in the cloud-side janitor / blob-GC
todo (doc id 15) — keep them separate; the mitigations and the "safe to act"
reasoning do not overlap.

From `threat-model-cloud-data-server-cloud-apps-2026-06-30.md`, **T10 —
Availability, denial of service, and cost amplification** (posture: Partial /
pre-production gap).

Revisit when: before any internet-exposed or multi-operator deployment, or
sooner if a cost spike is observed. Tracked here rather than in production
planning because the project is pre-production today and this is not load-bearing
until the gateway is genuinely exposed — but it is the first thing to address
when it is.
