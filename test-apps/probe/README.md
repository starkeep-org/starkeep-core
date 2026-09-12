# Probe — the platform's fixture app

Probe is a conforming Starkeep app that exists so the platform's test suites
have something to install, run, serve, sign in to, sync and uninstall without
depending on any particular real application.

## Why it exists

Starkeep core must not assume any specific app is present. Photos is a canonical
exemplar rather than a component of the platform, and a deployment can
legitimately have no Photos in it — so core's suites install Probe instead, and
Photos' own suites (in the `starkeep-apps` checkout) cover what is true of Photos.

## What it covers

Probe is deliberately the smallest app that touches every surface the platform
offers an app:

- a served shell and an immutable asset under `_immutable/`, the platform's
  reserved prefix for content-addressed output and the one path CloudFront
  caches forever;
- a sign-in page and the `/api/session/*` routes, taken from
  `@starkeep/app-client` rather than reimplemented;
- an `/api/local-data/*` signing proxy, the browser's only route to the data
  plane;
- a browser upload that presigns, PUTs to S3 and registers a shared record;
- a declared label vocabulary (`variant` as a size class, `flag` valueless,
  `tag` valued) and an app-private `probe_notes` table;
- a JWT-gated `POST /api/echo` compute route.

## How it runs

One Hono app in `src/app.ts`, with two adapters. `src/serve.ts` runs it under
`@hono/node-server` and bundles to `serve.mjs` for a local install (what the
manifest's `localRun` starts). `src/static-handler.ts` hands it to
`createWebAppHandler` through `honoUpstream` and, with `src/api-handler.ts`,
bundles into `dist.zip` for a cloud install (what `cli-install-app` builds
through `pnpm bundle`).

Both surfaces run the same app code, so a divergence between them is the
platform's rather than the fixture's. Every route in `src/app.ts` is written
app-relative — `honoUpstream` strips the `/apps/probe` mount before Hono routes
— which is the shape `authoring-an-app.md` asks every app to take.
