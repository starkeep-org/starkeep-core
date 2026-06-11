# Bind HMAC signature to method, path, and a timestamp window

The per-app HMAC signature in `packages/app-client/src/sign.ts` covers
only `${appId}:` ++ raw body bytes. It does not bind the HTTP method,
the URL path, or a timestamp. Two practical consequences:

1. A signed body from one POST is replayable against any other POST
   endpoint that accepts the same body shape under the same app.
2. Any captured request can be replayed indefinitely — there is no
   nonce or freshness window.

The risk today is bounded: the secret is internal to the platform, the
blast radius is one app's data, and HTTPS prevents passive capture. The
prior posture (Cognito JWTs with short expiries) had both protections
by construction; the HMAC migration silently dropped them.

## Fix shape

Include method + path + an `X-Starkeep-App-Ts` header in the signed
input on both sides. Reject signatures on the verifier whose timestamp
is more than ~5 min stale.

Apply on:

- `packages/app-client/src/sign.ts` — `signRequest` adds method/path/ts
  to the HMAC input and emits `X-Starkeep-App-Ts`.
- `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`
  — `validateAppHmac` reads the same three values, recomputes, and
  enforces the freshness window.
- `apps/local-data-server/sync-supervisor.ts` — picks up the change
  via the `signRequest` import; no per-call adjustment needed.

## Source

From doc id 18 (`functional-doc-cloud-apps-2026-06-05.md`), Part 2 —
Potential gaps, and doc id 14
(`functional-doc-cloud-data-server-2026-06-05.md`), Part 2 — Behavioral
bugs. Deferred by `plan-cloud-auth-foundational-fixes-2026-06-11.md`.

## Revisit when

Any new outward-facing route is added that would broaden the replay
surface, or before any external app developer joins.
