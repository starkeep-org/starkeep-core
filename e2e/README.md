# @starkeep/e2e — Tier-2 platform e2e

Playwright suite per the platform test plan (meta-doc 43, §6/§7a) plus the
orchestration harness it runs on. Run with `pnpm test:e2e` (repo root or
here); it is deliberately not part of the default `pnpm test`.

`global-setup.ts` boots one real platform stack for the whole run — a
local-data-server child process (via `@starkeep/testkit`) and `next dev`
instances of admin-web and drive on ephemeral ports, isolated in throwaway
temp dirs — and tears it all down afterwards. Photos is *not* booted by the
harness: the specs install it through the real admin-web consent flow and
start it through the real daemon route, because that orchestration is itself
platform behavior under test.

Everything in `src/` is exported from `@starkeep/e2e` so
`starkeep-apps/photos` can consume the same harness for its app-functionality
e2e (plan case 7b) via the sibling-checkout layout.

## Preconditions

- One-time: `pnpm exec playwright install chromium`.
- The sibling `starkeep-apps/` checkout must exist with photos' dependencies
  installed (`pnpm install` there) — photos is the installed-app fixture.
- No `next dev` for photos (or admin-web/drive) may already be running:
  Next 16 allows a single dev server per app directory, so a leftover dev
  server makes the daemon-start flow fail with "Another next dev server is
  already running".

## Gotchas baked into the harness

- Browser-facing URLs use `localhost`, never `127.0.0.1`: Next's dev-origin
  protection treats the bare IP as cross-origin, silently drops the turbopack
  HMR websocket, and hydration never completes (pages render their SSR shell
  and stay frozen).
- The admin daemon-status badge is a TCP probe; specs wait for a real HTTP
  200 from the app before navigating to it.
