# @starkeep/e2e-aws — Tier-3 cloud journey

The Tier-3 test of the four-tier plan (`meta-docs` doc 43, §11): the full
install → sync → use → uninstall journey driven against **real AWS** through the
same admin-installer CLIs an operator runs. It is the only suite that touches a
live account, so it is **inert unless explicitly enabled**.

```bash
STARKEEP_AWS_TESTS=1 pnpm test:aws          # from repo root (turbo) or this dir
```

Without `STARKEEP_AWS_TESTS=1` the single test file reports a skipped suite and
makes no AWS calls. `pnpm test` (the default unit suite) never runs it.

The browser steps (real Chromium) need the Playwright browser installed once:

```bash
pnpm exec playwright install chromium
```

The rendition steps boot the Photos app out of the sibling `starkeep-apps`
checkout, so its dependencies must be installed (`pnpm install` there). The
suite builds Photos' derivation worker itself — `pnpm dev` would have, and this
suite starts Next directly so it can capture the log and kill the process group.

**Stop any Photos dev server of your own first.** Next allows one dev server per
app directory, so a `pnpm dev` left running in `starkeep-apps/photos` would take
the rendition step down. The suite checks `.next/dev/lock` before its first AWS
call and refuses to start, rather than failing fifteen minutes and one Pulumi
stack later.

## What it does (`src/journey.test.ts`, ordered steps)

1. Create-if-missing the bootstrap CloudFormation stack; read its outputs.
2. Create-if-missing a Cognito admin user (per-run password) and sign in through
   the real Cognito + Identity Pool chain.
3. Install cloud-data-server via `cli-install-cloud-data-server` (real Pulumi up:
   DSQL cluster, Lambda, API Gateway).
4. Boot a local-data-server (testkit) pointed at the real cloud.
5. Install Drive, then 6. photos, via the real install CLIs.
7. Create a photo locally, `POST /sync/now`, assert the record + blob landed in
   the cloud under Drive with origin `photos`.
8. Drift a local creds file, re-run the Drive cloud install, and assert sync
   still validates — the todo-39 regression: the installer mirrors the *local
   registry* secret (what the supervisor signs with), not the drifted creds
   file, so the cloud verifier can't be left on a stale key.
9. Static handler, 10. the cloud-served `/api/local-data` proxy (list + a write
   verb — the browser-facing data path, HMAC-signed server-side from SSM, driven
   with a session cookie obtained through the app's own sign-in route),
   10a. the **negative** case — every app in the cloud registry, probed on both
   its broker mount and its proxy mount with no token, no cookie and no prior
   state, must answer `401`/`403`,
   10b. one URL that answers `200` with a session cookie and `401` without it,
   11. the **rendition ladder**, in three steps: boot the real Photos app locally
   against this run's data server and have it derive a full ladder for an
   original larger than the ladder's top rung (11a); sync, and assert every rung
   reached the cloud carrying its `photos/rendition` label *and* non-null
   width/height, that the broker resolves one variant candidate per rung, and
   that one rung's bytes round-trip through the cloud `file-url` (11b); then load
   the cloud grid in a real browser, upload nothing, and assert a tile's `src`
   settles on a synced rung's object key rather than on the original's (11c).
   Step 11b is the assertion the 2026-08-27 rendition-invisibility bug fails: a
   rung arriving without dimensions is dropped as an unorderable candidate and
   the record reports having no renditions at all.
   12. a full **browser** journey in real Chromium (Cognito sign-in → upload a
   photo through the live file input → see it in the grid), exercising the whole
   presign → S3 PUT → `POST /data/records` → metadata-write path end-to-end,
   13. `/api/resize`, 14. caption via `/app-data` — exercise the app's cloud routes.
15. Uninstall photos; assert the app plane is gone but shared records survive.

## Environment contract (`src/env.ts`)

| Var | Default | Meaning |
| --- | --- | --- |
| `STARKEEP_AWS_TESTS` | _(unset)_ | Must be `1` to run; otherwise the suite skips. |
| `STARKEEP_AWS_STACK_PREFIX` | `sktest` | Dedicated test stack prefix. **Never** point this at a live deployment's prefix. |
| `STARKEEP_AWS_REGION` | `us-east-2` | Region for a from-scratch bootstrap (an existing stack's own region always wins via its pool ID). |
| `STARKEEP_AWS_TEARDOWN` | `all` | What to tear down **after a fully passing run**: `all` (default) → `teardown-bootstrap.sh`; `apps` → `teardown-cloud-data-server.sh`; `none` → keep everything up. A run with **any failed step never tears down**, so a broken stack is left for debugging. |
| `HMAC_CACHE_TTL_MS` | `0` (in this suite) | Baked into the broker Lambda at install. The suite sets `0` so a just-rotated/revoked app secret isn't served from the broker's cache. Real installs leave it unset → broker keeps its 5-min default. |

AWS credentials come from the ambient profile/role (the default profile during
development). The runner authenticates the admin user itself and hands the
Cognito-derived temporary credentials to the CLIs via `--non-interactive`.

Turbo sanitizes the environment, so `turbo.json`'s `test:aws` task declares all
of the above (plus the AWS credential vars) under `passThroughEnv` — without
that, the gate var never reaches vitest and the suite silently skips.

## Run state (`src/run-state.ts`)

Per-prefix state lives in `e2e-aws/.run/<prefix>/` (gitignored) and doubles as
`STARKEEP_DIR` for the spawned CLIs **and** the booted LDS — they read and
rewrite `config.json` and share the registry `data.db`, so a dedicated shared
dir is what keeps a run from clobbering the operator's live `~/.starkeep`. This
one-dir layout mirrors production, where config.json and data.db both live under
`~/.starkeep`. `admin.json` (0600) holds the generated test-admin password; it
unlocks only the disposable test stack.

## Cost / time / lifecycle

- **~26 min per full run**, measured before the rendition steps landed. Those
  add a `next dev` first compile of the Photos app, one full ladder off a source
  above the ladder's top rung, and a second real-Chromium session — several
  minutes, not seconds. First run is dominated by the cloud-data-server Pulumi up
  (DSQL cluster provisioning); the photos install/uninstall add a Pulumi up +
  destroy each.
- **A passing run tears the whole stack down by default** (`STARKEEP_AWS_TEARDOWN=all`)
  so nothing stale is left behind. To iterate against a warm stack, run with
  `STARKEEP_AWS_TEARDOWN=none`: bootstrap + cloud-data-server + Drive then
  persist between runs (idle ≈ $0), and re-runs reuse the warm stack and the
  orchestrator's step ledger.
- **A failed run never tears down** — the real cloud resources are left up for
  debugging regardless of `STARKEEP_AWS_TEARDOWN`. `bail: 1` stops at the first
  failure, and the next run is idempotent against (and eventually tears down)
  the same disposable stack.
- `vitest.config.ts` runs serially with long (30-min) timeouts; `bail: 1` stops
  the first failure cheaply. Failures are resumable against the left-up stack.

## Gotchas learned bringing this green

- **App secrets rotate per run.** The ephemeral local-data-server re-mints each
  app's HMAC secret on every boot, so the cloud install must *reconcile* it to
  SSM every run (`put_app_creds_parameter` is an `alwaysRun` orchestrator step,
  not skip-if-done) and the photo content must be unique per run (the cloud
  dedupes identical content on live rows, otherwise `shipped: 0`).
- **Two auth models.** The broker's data/sync/app-data planes are HMAC-signed
  (app identity); an app's *own* routes (e.g. photos `/api/resize`) sit behind
  the gateway's Cognito JWT authorizer (user identity, `Authorization: Bearer`).
- **A locally-run app needs `dataServerUrl` in its creds file.** `cli-install-app`
  mirrors the registry secret into `app-creds/<appId>.json` but leaves the URL
  unset, and `@starkeep/app-client` then falls back to the production port 9820.
  admin-web writes the URL at local install; this suite has no admin-web, so the
  rendition step writes the file itself before booting Photos.
- **Photos' ladder and label spelling are read from the app, not copied.** See
  `src/photos-contract.ts`: the suite already spent a run discovering that
  `photos/thumbnail` had become `photos/rendition`, and a copied ladder would
  fail the same way but silently. `vitest.config.ts` widens Vite's
  `server.fs.allow` so the load is permitted.
- **`/sync/now` needs an app signature** — it is not one of the LDS's
  loopback-exempt paths.
- **IAM propagation can exceed a couple of minutes** after attaching a temp
  role policy; the AccessDenied retry budget is sized accordingly.

## Still deferred (§11 extras)

- DSQL dedup-on-live-rows pin and the explicit `dsql:DbConnect` 28000 case.
