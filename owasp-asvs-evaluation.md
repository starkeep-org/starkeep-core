# Starkeep — OWASP ASVS 5.0 Evaluation

> **What this is.** A high-level, breadth-first walk through every chapter of the
> OWASP Application Security Verification Standard (ASVS) **5.0.0**, assessing how
> Starkeep's cloud posture stands against each. 
>
> **Companion document.** This sits alongside [`SECURITY.md`](SECURITY.md),
> the threat model that reasons about *concrete attack paths* (T1–T11). Where a
> chapter maps onto a threat there, this doc cites it (e.g. "see T8") rather than
> restating it. Read the threat model for the *why*; read this for *coverage
> against a standard checklist*. Design context is in
> [`system-design.md`](system-design.md) and
> [`data-roles-and-permissions.md`](data-roles-and-permissions.md).
>
> **Scope & altitude.** Cloud-side only (broker, DSQL, files bucket, API Gateway,
> Cognito + IAM bootstrap, cloud apps), matching the threat model's boundary. The
> single-account, single-tenant trust model holds throughout: the customer's own
> AWS account is the outer boundary. Assessments are drawn from the design docs,
> the threat model, and light code spot-checks — not a line-by-line audit.
>
> **Posture labels** (same vocabulary as the threat model): **Strong**,
> **Adequate**, **Partial**, **Deferred by design**, **Out of scope / N/A**.

---

## At a glance

| # | ASVS 5.0 chapter | Relevance | Posture |
|---|---|---|---|
| V1 | Encoding & Sanitization | Yes | **Adequate** |
| V2 | Validation & Business Logic | Yes | **Adequate** |
| V3 | Web Frontend Security | Yes | **Partial** — no security headers/CSP |
| V4 | API & Web Service | Yes (core) | **Adequate** (see T2/T4) |
| V5 | File Handling | Yes | **Partial** |
| V6 | Authentication | Yes (core) | **Adequate** (MFA to confirm — T7) |
| V7 | Session Management | Yes | **Adequate** (replay window — T2) |
| V8 | Authorization | Yes (core strength) | **Strong** (see T1/T3/T6) |
| V9 | Self-contained Tokens | Partial (Cognito JWT) | **Adequate** (AWS-managed) |
| V10 | OAuth & OIDC | Minimal | **Out of scope / N/A** (managed) |
| V11 | Cryptography | Yes | **Adequate** (CMK deferred — T9) |
| V12 | Secure Communication | Yes | **Adequate** (SecureTransport-deny deferred — T9) |
| V13 | Configuration | Yes | **Adequate → Strong** |
| V14 | Data Protection | Yes | **Adequate** (storage growth — T10) |
| V15 | Secure Coding & Architecture | Yes | **Partial** (supply chain — T8) |
| V16 | Security Logging & Error Handling | Yes | **Partial** — logs yes, alerting/audit no |
| V17 | WebRTC | No | **Out of scope / N/A** |

---

## V1 — Encoding & Sanitization

*Contextual output encoding at every sink to prevent injection (SQL, XSS,
command, etc.).*

- **SQL.** New and modified queries go through **Kysely**, which
  emits parameterized statements — user data never concatenated into SQL. This is
  the primary injection sink and it is handled structurally.
- **HTML/DOM.** The browser surfaces (admin-web, the Photos UI) are React,
  which escapes interpolated values by default. No raw `dangerouslySetInnerHTML`
  patterns were surfaced in spot-checks.
- **Object keys / paths.** `object-keys.ts` rejects `..` traversal and stray
  slashes in app ids before any S3 call (see T3) — sanitization at the storage
  sink.

**Adequate.** The load-bearing sinks (SQL, DOM, S3 keys) each have a structural
defense.

## V2 — Validation & Business Logic

*Input validation and enforcement of business-logic limits.*

- App manifests are **schema-validated** at install, with app-id namespace checks
  and gating of the privileged `fileAccessAll` / `brokerPower` flags (see T8).
- The **access grants** themselves are the business-logic ceiling: a request can
  only touch what the caller's grants permit, re-checked per request by the
  access-enforcer (see T1/T8).
- HMAC freshness (±5 min) is a temporal business rule on request validity (T2).

**Adequate.** Validation is concentrated at the boundaries that matter (install,
per-request authorization). Per-field request-body validation depth varies by app
handler and isn't standardized platform-wide.

## V3 — Web Frontend Security

*Browser-side protections: CSP, security headers, cookie flags, clickjacking, CORS.*

- **No security-header layer.** A spot-check found no Content-Security-Policy,
  `X-Frame-Options`/frame-ancestors, HSTS, or `X-Content-Type-Options` handling in
  either admin-web or the Photos UI — no `helmet`-style middleware anywhere.
- The **files bucket runs wildcard-origin CORS** (`allowedOrigins: ["*"]`,
  methods `GET/PUT/HEAD`) to enable browser-direct presigned uploads (see T4).
  This is **not** an access-control gap: CORS is a browser read-gate, not an
  authorization mechanism, and nothing in the design treats Origin as a trust
  boundary. Access is gated entirely at URL-mint time — the bucket carries a
  full public-access-block so every request must be SigV4-signed. 
  Non-credentialed requests mean the wildcard-origin-plus-credentials
  leak also doesn't apply.
- The genuinely cloud-served browser surface is the **Photos sample UI**, served
  to the public web over a `public` route — this is where the security-header /
  CSP gap above actually bites: responses carry no CSP, `X-Frame-Options`/
  frame-ancestors, HSTS, or `X-Content-Type-Options`, so a stored/reflected XSS
  or a clickjacking frame has no browser-side backstop. The single-operator
  deployment keeps today's blast radius small, but this is the concrete surface
  to harden before any multi-user or broader public posture.

**Partial.** This is the least-covered chapter. The concrete gap is the missing
security-header / CSP layer on the cloud-served Photos UI, worth closing before
any multi-user or public-facing posture. The wildcard-origin files-bucket CORS
is sound as designed (access lives in the presign step, not in Origin); pinning
origins is optional defense-in-depth, not a fix.

## V4 — API & Web Service

*REST/HTTP API security: authentication, method/verb handling, rate limiting.*

- Every `/apps/{appId}/*` data-plane request is **HMAC-SHA256 signed**, binding
  method, canonical path, and timestamp, with the header app-id pinned to the URL
  path (see T2). Reserved data routes carry no gateway authorizer by design — HMAC
  is the sole check and unsigned requests 401 before any work (T4).
- Human-facing routes use the Cognito JWT authorizer (`auth: "jwt"`); `public`
  routes are an explicit app opt-out.
- **Rate limiting** exists at the stage level: a request throttle plus Lambda
  reserved concurrency bound volumetric abuse (see T10). No per-app/per-route
  quota and no WAF.

**Adequate.** Identity and verb/path binding on the data plane are solid; the
named residuals (within-window replay, no per-app quota) are carried in T2/T4/T10.

## V5 — File Handling

*Safe upload, storage, and download of files.*

- Uploads/downloads use **time-bound S3 presigned URLs** so bytes bypass the
  gateway body limit. These are **bearer** credentials: anyone with the URL can use
  it within its validity window (see T4).
- Storage keys are traversal-safe and app-prefix-confined (T3); the per-app IAM
  boundary + bucket policy stop cross-app file access.
- **No server-side content inspection** — no MIME/type verification, size policy
  beyond presign constraints, or malware scanning of uploaded bytes. An app can
  store whatever its grant allows.

**Partial.** Access-control around files is strong (T3); content-level file
safety (validation, scanning, non-bearer download auth) is intentionally unaddressed.

## V6 — Authentication

*Verifying the identity of humans and services.*

- **Humans:** Cognito user pool, `ADMIN_CREATE_USER` only, exchanged for temporary
  STS creds via `AssumeRoleWithWebIdentity`. **No IAM user, no long-lived access
  key** anywhere (see T7).
- **Services (apps):** per-app HMAC secret, symmetric, stored as an SSM
  SecureString (see T2).
- **Gap:** password auth (`ALLOW_USER_PASSWORD_AUTH`) is enabled and **MFA is not
  visibly enforced** in the bootstrap template — flagged in T7 as worth
  confirming/hardening for any real deployment.

**Adequate.** The no-long-lived-key stance is a genuine strength; enforced MFA on
the admin login is the main hardening item.

## V7 — Session Management

*Lifecycle and integrity of authenticated sessions.*

- Human sessions are **Cognito/STS temporary credentials** — short-lived by
  construction, no server-side session store to fixate or steal.
- App requests are **stateless signed messages**, not sessions; there is no
  session to hijack. The temporal control is the ±5-minute HMAC freshness window,
  which permits **within-window replay** (no nonce/once-use — see T2).

**Adequate.** Statelessness removes a whole class of session bugs; the honest
residual is the replay window, already tracked in T2.

## V8 — Authorization

*Enforcing that identities can only do what they're permitted.*

This is the architecture's centre of gravity and its strongest area. Confinement
of an app to exactly its manifest is enforced in **four independent layers** — IAM
permissions boundary, DSQL IAM→PG mapping + PG GRANTs, S3 bucket policy, and the
application-layer access-enforcer (`canRead`/`canWrite`, type-granular because DSQL
has no RLS). Powerful capabilities (mint IAM roles, DB admin, provision compute)
are **isolated on ephemeral install-time identities**, and the broker holds **no
standing data-plane power** (see T1, T3, T5, T6).

Two honest caveats carried from the threat model: (a) **a grant is a grant** —
shared-data authorization is type-granular but not per-item/per-origin, so the
install-time grant decision *is* the boundary for shared data (T1); (b) the
application-layer enforcer is load-bearing precisely because DSQL has no row-level
security.

**Strong.** Least privilege is structural, not aspirational.

## V9 — Self-contained Tokens

*Integrity of stateless tokens (e.g. JWT).*

- The only self-contained token in play is the **Cognito-issued JWT**, validated
  by API Gateway's managed Cognito JWT authorizer on `jwt` routes. Issuance,
  signing, and validation are AWS-managed.
- The app HMAC signature is *not* a self-contained token (no embedded claims) — it
  belongs under V4/V11.

**Adequate.** Token integrity rides on AWS-managed Cognito + API Gateway; nothing
custom to get wrong here.

## V10 — OAuth & OIDC

*Security of OAuth2 / OIDC flows where the app acts as client or provider.*

Starkeep operates **no custom OAuth/OIDC server or client flow**. The Cognito
identity pool performs web-identity federation internally to mint STS credentials,
but that is an AWS-managed exchange, not an application-implemented OAuth flow.

**Out of scope / N/A** — nothing application-owned to verify.

## V11 — Cryptography

*Correct use of cryptographic primitives and key management.*

- **HMAC-SHA256** for app request signing, compared with `timingSafeEqual`
  (constant-time) — correct primitive, correct comparison (T2).
- **At rest:** S3 SSE-S3 (AES-256) and DSQL's managed encryption; HMAC secrets are
  KMS-encrypted SSM SecureStrings (T9/T11).
- **Deferred:** a **customer-managed KMS key (CMK)** — consciously deferred because
  it requires widening the foundational IAM boundary (T9).
- **Caveat:** the per-app secret is **symmetric and widely distributed** (cloud SSM
  + local files), no in-place rotation (T2/T11).

**Adequate.** Primitives and comparisons are right; key *ownership* (CMK) and
secret *lifecycle* (rotation) are the named, deferred residuals.

## V12 — Secure Communication

*Encryption and authentication of data in transit.*

- All external traffic is **HTTPS** (API Gateway) and S3/DSQL access is over TLS —
  transit encryption holds in practice.
- **Deferred:** no `aws:SecureTransport`-deny on the bucket policy, so plaintext is
  blocked by convention/endpoint config rather than **policy-enforced** (T9).

**Adequate.** TLS is universal in practice; the step to policy-enforced transit is
a small, tracked deferral.

## V13 — Configuration

*Secure defaults, hardened config, secret management, no secrets in code.*

- Infrastructure is **declarative IaC** (CloudFormation bootstrap + Pulumi programs)
  with **least-privilege permissions boundaries** as hard ceilings.
- The files bucket asserts **SSE-S3 + versioning + full public-access-block**, and
  DSQL carries **deletion protection**, in the install program — a hardened,
  code-asserted posture, not a reliance on defaults (T9).
- The ephemeral-e2e carve-out that relaxes this is **fail-safe by construction**
  (explicit `--ephemeral` CLI flag, never an inheritable env var), so a real
  install cannot be silently downgraded (T9).
- **Secrets stay out of code** — SSM SecureStrings, not source or plaintext config.
- Residual: the **permissive files-bucket CORS** (T4) is the one config surface
  worth a deliberate review.

**Adequate, trending Strong.** Config hygiene is a relative strength; the
fail-safe hardening design is notable.

## V14 — Data Protection

*Classification, retention, and protection of sensitive data across its lifecycle.*

- **Classification is explicit and architectural:** shared vs app-specific data,
  with different ownership and access rules (`system-design.md`), enforced by V8's
  layers.
- **At rest / in transit:** covered by V11/V12.
- **Retention gap:** storage grows **monotonically** — tombstoned shared records
  never have their S3 blobs collected and there's no repair/GC pass (T10). That is
  a data-lifecycle and cost concern (deleted data isn't fully purged).
- **Presigned bearer URLs** are a bounded exposure of object bytes (T4/V5).

**Adequate.** Classification and at-rest protection are handled; **deletion/GC of
retired data** is the honest lifecycle gap, carried in T10.

## V15 — Secure Coding & Architecture

*Secure-by-design architecture, trust-boundary documentation, dependency/supply-chain integrity.*

- **Architecture is documented and threat-modelled** — trust boundaries, least
  privilege, and defense-in-depth are written down (this doc's companions) and
  reflected in code. That is exactly what this chapter asks for.
- **Supply chain is the weak axis (T8):** app discovery is filesystem-based, there
  is **no code signing / bundle provenance / review gate**, and `pnpm bundle` runs
  **arbitrary install-time scripts on the admin workstation**. Requested grants are
  self-declared with no scoring of over-broad asks.

**Partial.** The design/architecture half is strong; the supply-chain/build-integrity
half is the weakest link for any future "install apps you didn't write" scenario,
and is named as such in T8.

## V16 — Security Logging & Error Handling

*Sufficient security event logging, tamper-resistant logs, safe error handling.*

- **Operational logging exists:** each Lambda gets a **CloudWatch log group** (via
  the Pulumi programs), and the broker surfaces failures into CloudWatch rather
  than crashing the process.
- **Error handling** is safe-by-shape at the boundary — unauthenticated/invalid
  requests 401, over-limit requests 429 (T4/T10) — without leaking internals.
- **Gaps:** there is **no security-event/audit trail** (e.g. who installed/
  uninstalled what, grant changes), **no CloudWatch alarms/metrics or alerting**,
  and no log-integrity/retention policy surfaced in spot-checks. Logging today is
  operational, not security-observability.

**Partial.** Basic operational logging and clean error responses are present;
security-specific audit logging, alerting, and monitoring are largely absent —
the clearest "known unknown" for incident detection.

## V17 — WebRTC

*Security of WebRTC media/data channels.*

Starkeep uses **no WebRTC** anywhere.

**Out of scope / N/A.**

---

## Summary

**Strengths (verify-clean).** Authorization (V8), configuration hygiene (V13), and
the authentication *stance* (V6 — no long-lived keys) are the standout areas,
consistent with the threat model's finding that least privilege is structural.
Cryptographic primitive use (V11) and transit (V12) are correct, with only
deliberate, tracked deferrals (CMK, SecureTransport-deny).

**The concrete gaps, roughly by priority.**

1. **Web frontend hardening (V3)** — no CSP/security headers anywhere, plus
   permissive files-bucket CORS. The most self-contained thing to fix.
2. **Security logging & observability (V16)** — operational logs exist, but no
   audit trail, alarms, or alerting; the main blind spot for detecting an incident.
3. **Supply-chain / build integrity (V15, ↔ T8)** — no code signing, provenance,
   or review gate; `pnpm bundle` executes untrusted scripts on the admin machine.
4. **File content safety (V5)** — access control around files is strong, but no
   content validation/scanning and download auth is bearer-token.
5. **Data retention / GC (V14, ↔ T10)** — retired (tombstoned) data is never
   purged; storage grows monotonically.

None of these contradict Starkeep's stated single-operator, trusted-app-source
stance — several are explicit deferrals of not-yet-needed work. As with the
threat model, the intent is that a reader knows exactly where the lines are drawn.