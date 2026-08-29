# @starkeep/e2e — Tier-2 platform e2e

Playwright suite per the platform test plan (meta-doc 43, §6/§7a) plus the
orchestration harness it runs on. Run with `pnpm test:e2e` (repo root or here);
it is deliberately not part of the default `pnpm test`.

`global-setup.ts` boots one real platform stack for the whole run — a
local-data-server child process (via `@starkeep/testkit`) and `next dev`
instances of admin-web and drive on ephemeral ports, isolated in throwaway temp
dirs — and tears it all down afterwards. The app under test is *not* booted by
the harness: the specs install it through the real admin-web consent flow and
start it through the real daemon route, because that orchestration is itself
platform behavior under test.

## The app this suite installs

Core's own fixture, `test-apps/probe`. Probe is the smallest conforming
Starkeep app: a served shell, a sign-in flow, a signing proxy, a browser upload,
a declared label vocabulary, an app-private table and a JWT-gated route. It
exists so this suite can assert platform behavior without core assuming any
particular application is present.

Real applications assert the same platform properties through their own UIs in
their own repositories — see `starkeep-apps/photos/e2e`. Everything in `src/` is
exported from `@starkeep/e2e` so they can consume this harness to do it.

## Preconditions

- One-time: `pnpm exec playwright install chromium`.
- No `next dev` for admin-web or drive may already be running: Next 16 allows a
  single dev server per app directory, so a leftover one makes the daemon-start
  flow fail with "Another next dev server is already running".

There is no sibling-checkout precondition. This suite runs against nothing but
this repository.

## Gotchas baked into the harness

- `startPlatformStack` requires `appParentDirs`. A default would be the harness
  acquiring an opinion about which apps a deployment has; core's suites pass
  `CORE_FIXTURE_APPS_DIR`, an app's own suite passes its checkout.
- Browser-facing URLs use `localhost`, never `127.0.0.1`: Next's dev-origin
  protection treats the bare IP as cross-origin, silently drops the turbopack
  HMR websocket, and hydration never completes (pages render their SSR shell
  and stay frozen).
- The admin daemon-status badge is a TCP probe; specs wait for a real HTTP 200
  from the app before navigating to it.
