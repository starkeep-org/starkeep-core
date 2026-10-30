# @starkeep/e2e-aws — Tier-3 cloud journey

The Tier-3 test of the four-tier plan (`meta-docs` doc 43, §11): the full
install → sync → use → uninstall journey driven against **real AWS** through the
same admin-installer CLIs an operator runs. It is the only suite that touches a
live account, so it is **inert unless explicitly enabled**.

```bash
STARKEEP_AWS_TESTS=1 pnpm test:aws          # from repo root (turbo) or this dir
```

Without `STARKEEP_AWS_TESTS=1` the suite reports skipped and makes no AWS calls.
`pnpm test` (the default unit suite) never runs it.

The browser steps (real Chromium) need the Playwright browser installed once:

```bash
pnpm exec playwright install chromium
```

## Which app the journey runs against

The journey is app-agnostic. `src/journey.ts` exports `defineCloudJourney(app)`,
which registers only **platform** assertions; the app arrives as a `JourneyApp`
describing what differs between apps — its id, its directory, the label keys and
table its manifest declared, the route behind its JWT authorizer.

| `STARKEEP_AWS_APP_DIR` | What runs                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(unset)_              | `test-apps/probe`, the fixture core ships. Needs no other checkout on the machine.                                                                  |
| a path                 | That app. The same platform journey, against a real application — which is what proves a genuine framework app survives the bundle-and-deploy path. |

A path holding no `starkeep.manifest.json` **fails the run** rather than falling
back. Asking for a real app and silently getting the fixture would report a
green journey that never tested what was asked for.

App-level assertions — anything true of one application and not of the platform
— live in that application's own repository, which consumes this package the way
`starkeep-apps/photos` does:

```ts
import { defineCloudJourney } from "@starkeep/e2e-aws";
defineCloudJourney(myApp, { runStateDir: resolve(APP_DIR, "e2e-aws") });
```

Pass `runStateDir`: the dir holds that run's Cognito admin password and its
registry database, which must not land in a checkout you do not own.

## What it does (ordered steps)

1. Create-if-missing the bootstrap CloudFormation stack; read its outputs.
2. Create-if-missing a Cognito admin user (per-run password) and sign in through
   the real Cognito + Identity Pool chain.
3. Install cloud-data-server via `cli-install-cloud-data-server` (real Pulumi up:
   DSQL cluster, Lambda, API Gateway).
4. Boot a local-data-server (testkit) pointed at the real cloud.
5. Sign in through the LDS `/auth/tokens` handoff (real Cognito→STS exchange).
6. Install Drive via the real install CLI. Its cloud secret is read back from
   SSM and must differ from the local one: the cloud install creates its own.
7. Install the app under test in the cloud **before** any local install, and
   have the cloud app write an app-private row. Then sign the machine out,
   install the app locally (it works at once; its sync channel does not
   start), sign back in, and assert the channel starts and pulls the row down.
8. Create a record locally, `POST /sync/now`, assert the row + blob landed in the
   cloud under Drive with the app as origin.
9. Cross-app labels against real DSQL: write, hydrate, reverse query, retract.
   The keys come from the app's manifest, because the broker rejects an
   undeclared key with a 400 and an invented one would fail here rather than at
   the thing the step tests.
10. Re-run the Drive cloud install and assert the cloud secret did not rotate
    and sync still validates.
    - **Rows ahead of bytes, Drive channel.** A photograph and its 320 px
      smaller stand-in lose their local bytes before sync. Both rows must reach
      the cloud anyway, S3 must lack both files, and the cloud's bytes
      watermark must stop below the original. Once the bytes return, both
      files must reach S3 and the watermark must pass both rows. This is the
      only coverage of `_starkeep_byte_coverage` on real DSQL and of the
      cloud's walk against real S3. While a file is owed, the detail route,
      the `stand-in-urls` listing's size summary, `file-url` and the batch
      `file-urls` sign no URL for it and report it as awaiting upload, and
      `/sync/verify` counts it in `filesOwed`. Afterwards every read signs a
      URL that fetches the bytes, and `filesOwed` reads 0.
    - **A file in S3 ahead of the cloud's walk.** The bytes land through the
      cloud's own upload route while the desktop is paused, so no exchange
      moves the watermark. They land in the phone's order. Once the stand-in
      lands, the reads must find it with a real S3 HEAD and serve it while
      the original still reads as awaiting upload, and the watermark must stay
      below the original. Once the original lands, every read serves both.
    - **Rows ahead of bytes, the app's own channel.** The same property for an
      app-private file in `_starkeep_sync_records`, through the per-app
      handler and the app's own role. Skipped for an app whose manifest
      declares no private files.
11. Static handler; 12. the app root's trailing-slash spelling is gated (a
    platform limit, pinned so a change is deliberate).
12. The cloud-served `/api/local-data` proxy (list + a write verb).
13. The **negative** case: every app in the cloud registry, probed on both its
    broker mount and its proxy mount with no token, no cookie and no prior state,
    must answer `401`/`403`. It names no app — the list comes from the registry.
14. A valid app signature is not enough; the broker demands an end user too.
15. One URL that answers `200` with a session cookie and `401` without it.
16. A full **browser** journey in real Chromium (Cognito sign-in → upload through
    the live file input → see it), exercising presign → S3 PUT →
    `POST /data/records` end-to-end. This is the only coverage of S3 CORS on a
    real presigned PUT. Skipped for an app that declares no browser surface.
17. The cloud-origin browser upload syncs back **down** to the local data server.
18. The app's JWT-gated route on the gateway **and** through CloudFront (proving
    `Authorization` survives the edge).
19. An app-private row through the cloud `/app-data` plane.
20. Part A: shell + `_immutable` assets through the CloudFront distribution (edge hit).
    Part B: shared bytes via CloudFront signed URL — edge hit, tamper rejected,
    `apps/*` isolated.
21. The app's own steps (`extraSteps`), if it has any.
22. Uninstall; assert the app plane is gone but shared records survive.

## Environment contract (`src/env.ts`)

| Var                         | Default             | Meaning                                                                                                                                                                                                                                            |
| --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STARKEEP_AWS_TESTS`        | _(unset)_           | Must be `1` to run; otherwise the suite skips.                                                                                                                                                                                                     |
| `STARKEEP_AWS_APP_DIR`      | _(unset)_           | The app to run against. Unset selects `test-apps/probe`. A path with no manifest fails the run.                                                                                                                                                    |
| `STARKEEP_AWS_STACK_PREFIX` | `sktest`            | Dedicated test stack prefix. **Never** point this at a live deployment's prefix.                                                                                                                                                                   |
| `STARKEEP_AWS_REGION`       | `us-east-2`         | Region for a from-scratch bootstrap (an existing stack's own region always wins via its pool ID).                                                                                                                                                  |
| `STARKEEP_AWS_TEARDOWN`     | `all`               | What to tear down **after a fully passing run**: `all` → `teardown-bootstrap.sh`; `apps` → `teardown-cloud-data-server.sh`; `none` → keep everything up. A run with **any failed step never tears down**, so a broken stack is left for debugging. |
| `HMAC_CACHE_TTL_MS`         | `0` (in this suite) | Baked into the broker Lambda at install. The suite sets `0` so a just-rotated/revoked app secret isn't served from the broker's cache. Real installs leave it unset → broker keeps its 5-min default.                                              |

AWS credentials come from the ambient profile/role (the default profile during
development). The runner authenticates the admin user itself and hands the
Cognito-derived temporary credentials to the CLIs via `--non-interactive`.

Turbo sanitizes the environment, so `turbo.json`'s `test:aws` task declares all
of the above (plus the AWS credential vars) under `passThroughEnv` — without
that, the gate var never reaches vitest and the suite silently skips.

## Run state (`src/run-state.ts`)

Per-prefix state lives in `<runStateDir>/.run/<prefix>/` (gitignored; the
default `runStateDir` is this package) and doubles as `STARKEEP_DIR` for the
spawned CLIs **and** the booted LDS — they read and rewrite `config.json` and
share the registry `data.db`, so a dedicated shared dir is what keeps a run from
clobbering the operator's live `~/.starkeep`. This one-dir layout mirrors
production, where config.json and data.db both live under `~/.starkeep`.
`admin.json` (0600) holds the generated test-admin password; it unlocks only the
disposable test stack.

## Cost / time / lifecycle

- **~26 min per full run** against the fixture. A real app adds whatever its own
  build and boot cost — for a Next application, a cold first compile.
  First run is dominated by the cloud-data-server Pulumi up (DSQL cluster
  provisioning); the app install/uninstall add a Pulumi up + destroy each.
- **A passing run tears the whole stack down by default** (`STARKEEP_AWS_TEARDOWN=all`)
  so nothing stale is left behind. To iterate against a warm stack, run with
  `STARKEEP_AWS_TEARDOWN=none`: bootstrap + cloud-data-server + Drive then
  persist between runs (idle ≈ $0), and re-runs reuse the warm stack and the
  orchestrator's step ledger.
- **A failed run never tears down** — the real cloud resources are left up for
  debugging regardless of `STARKEEP_AWS_TEARDOWN`. `bail: 1` stops at the first
  failure, and the next run is idempotent against (and eventually tears down)
  the same disposable stack.

## Gotchas learned bringing this green

- **Two secrets per app.** The ephemeral local-data-server re-mints each app's
  local HMAC secret on every boot, and the cloud install creates a separate one
  in SSM. Steps that stand in for an app's cloud compute (`cloudApp`) sign with
  the SSM secret, read back with ambient credentials; steps against the local
  data server sign with the local one. The uploaded content must be unique per
  run (the cloud dedupes identical content on live rows, otherwise `shipped: 0`).
- **Two auth models.** The broker's data/sync/app-data planes are HMAC-signed
  (app identity); an app's _own_ routes sit behind the gateway's Cognito JWT
  authorizer (user identity, `Authorization: Bearer`).
- **A locally-run app needs its creds file.** admin-web writes
  `app-creds/<appId>.json` (the local secret and `dataServerUrl`) at local
  install; this suite has no admin-web, and the cloud install writes nothing
  locally, so a step that boots the app locally writes the file itself first.
  Without `dataServerUrl`, `@starkeep/app-client` falls back to the production
  port 9820.
- **Playwright must be loaded once.** `src/browser.ts` owns the single instance
  and exports `chromium` plus the sign-in and diagnostic helpers. A consumer
  importing `@playwright/test` out of its own `node_modules` while the harness
  imports core's fails with "Requiring @playwright/test second time".
- **An app's declared vocabulary is read, never copied.** Label keys, the
  app-private table and the JWT route arrive on the `JourneyApp` profile so they
  move with the app's manifest. This suite already spent a run discovering that
  `photos/thumbnail` had become `photos/rendition`; a copy in this repository
  would fail the same way but silently.
- **`/sync/now` needs an app signature** — it is not one of the LDS's
  loopback-exempt paths.
