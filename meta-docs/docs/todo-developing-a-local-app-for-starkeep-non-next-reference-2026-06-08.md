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
