# TODO: Non-Next.js local-app reference / framework-contract note

Every concrete local-app pattern in the codebase (credentials loading, HMAC
signing, `/api/local-data` proxy, data-source resolver) is written against
Next.js conventions in the Photos app. Nothing in the platform requires Next,
but there's no example or written guidance separating platform contract from
Photos-incidental shape. Build a non-Next reference app (plain Node HTTP /
Express / Bun) or write a short "framework-agnostic shape" note that pins down
the platform contract.

Source: doc id 21 (Developing a local app for Starkeep — Functional Review,
2026-06-08), Part 1 — Open questions, first bullet.

Revisit when: a second local app is being scaffolded, or when the app-client
package (see related todo on `@starkeep/app-client`) is being designed — the
non-Next reference would naturally fall out of either.

## Resolved (2026-09-13)

Both halves of the ask now exist, and the Next.js premise is gone with them.

- The non-Next reference app is `starkeep-core/test-apps/probe`. Probe is the
  smallest conforming Starkeep app — a served shell, a sign-in flow, a signing
  proxy, a browser upload, a declared label vocabulary, an app-private table
  and a JWT-gated route — and the platform e2e suite runs against it, so it
  cannot drift from the contract it demonstrates.
- The framework-contract note is `starkeep-core/authoring-an-app.md`, which
  separates what the platform requires from what any one app happens to do.

The four web apps left Next.js entirely under
`plan-nextjs-to-vite-migration-2026-09-12.md`, so no pattern in the codebase is
written against Next conventions any more.
