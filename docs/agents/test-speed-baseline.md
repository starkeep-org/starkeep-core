# Test and CI time: before/after waves 1–3 (AI-733)

Numbers only. Narrative, decisions and per-issue results live in epic
[AI-705](https://linear.app/comms-center/issue/AI-705).

|                  | Before                                                                                  | After                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs             | `43136519611` (main push, `edbd619`); `43136750365` (pull_request on AI-692, `be6ecd6`) | `43167816264` attempt 1 and attempt 2 (main push, `eaf0ed2`, the AI-732 merge)                                                                                             |
| Date             | 2026-11-12 01:44 UTC                                                                    | 2026-11-12 06:23 and 06:25 UTC                                                                                                                                             |
| Turbo cache      | none (`0 cached, 16 total` builds)                                                      | attempt 1 restored the previous sha's entries via `restore-keys` and saved this sha's (15/16 builds cached); attempt 2 is the first fully warm run (16/16, exact-key hits) |
| Playwright cache | none (browsers downloaded)                                                              | `playwright-Linux-1.65.0` hit in both attempts (seeded before this run)                                                                                                    |

**Method.** Only one main `push` run exists after AI-732, so the second sample is
`gh run rerun 43167816264` (no `workflow_dispatch`). Job time = `completedAt − startedAt` and step time from
`gh run view <id> --attempt <n> --json jobs`. CI wall = run `createdAt → updatedAt`.
Per-package numbers are the vitest `Duration` line in each turbo task's log group
(`gh run view <id> --attempt <n> --log`). Local numbers come from one machine:
Intel i5-10400, **cgroup-limited to 1 CPU** (`cpu.max 100000 100000`; `nproc` reports
12), 14 GiB, Node 24.22.3, pnpm 10.20.0. The baseline machine is not recorded in the
repo, so local before/after compare different hardware. Raw logs are not committed.

**VM-speed control** (`pnpm install --frozen-lockfile` step, s; exclusion threshold
~90 s). No run was excluded. PR #8 run `43140127112` attempt 1 (pnpm install 4m03s)
is the known degraded VM and is not used.

| Job                                                  | 43136519611 | 43136750365 | 43167816264 #1 | 43167816264 #2 |
| ---------------------------------------------------- | ----------: | ----------: | -------------: | -------------: |
| Tier 1 lint / Tier 1 (before: one job)               |          47 |          58 |              9 |              5 |
| Tier 1 (unit)                                        |           — |           — |             11 |              5 |
| Integration (before: one job) / Integration (PGlite) |          47 |          40 |             11 |              5 |
| Integration (processes)                              |           — |           — |              9 |              7 |
| Tier 2 (local end-to-end)                            |          61 |          53 |             10 |              7 |
| Example app (tier 2)                                 |          59 |          45 |             12 |              6 |

## Headline

| Measure                         | Before                                           | After (#1 / #2)                             |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| CI wall (run created → updated) | 4m13s / 4m13s                                    | **1m33s / 1m45s**                           |
| Critical-path job               | Integration 250 s / Tier 1 250 s (range 228–250) | **Tier 1 (unit) 89 s / Tier 2 102 s**       |
| Integration step (longest)      | 192 / 178 s                                      | **50 / 61 s** (processes; PGlite 19 / 17 s) |

## Table 1: per CI job (s)

| Job                                      | 43136519611 |    43136750365 | 43167816264 #1 | 43167816264 #2 |
| ---------------------------------------- | ----------: | -------------: | -------------: | -------------: |
| Tier 1 (format, lint, typecheck[, unit]) |         190 |            250 |             86 |             37 |
| Tier 1 (unit)                            |           — |              — |             89 |             93 |
| Integration / Integration (PGlite)       |         250 |            228 |             54 |             35 |
| Integration (processes)                  |           — |              — |             77 |             80 |
| Tier 2 (local end-to-end)                |         129 |            123 |             79 |            102 |
| Example app (tier 2)                     |         114 |             92 |             63 |             53 |
| Example app (copied out)                 |          17 |             21 |             13 |             19 |
| Plugin (validate, links, load)           |          10 | — (not in run) |             13 |             14 |

## Table 2: per step, Tier 1 and Integration (s)

| Step                                                              |   43136519611 |   43136750365 |      43167816264 #1 | 43167816264 #2 |
| ----------------------------------------------------------------- | ------------: | ------------: | ------------------: | -------------: |
| Install + postinstall build, per job (min–max)                    |         47–61 |         40–58 |                9–12 |            5–7 |
| Turbo cached builds in postinstall                                |          0/16 |          0/16 |               15/16 |          16/16 |
| `format:check`                                                    |            10 |            15 |                  10 |             16 |
| `turbo run lint typecheck` (cached/total)                         |    63 (12/51) |    86 (12/51) |          54 (12/51) |      0 (51/51) |
| `turbo run test` (unit)                                           |            54 |            74 |                  63 |             72 |
| `test:integration`, PGlite job                                    | 192 (one job) | 178 (one job) |                  19 |             17 |
| `test:integration`, processes job                                 |             — |             — |                  50 |             61 |
| Tier 2: browser download (`playwright install --with-deps`)       |            21 |            21 | skipped (cache hit) |        skipped |
| Tier 2: Playwright cache restore + `install-deps`                 |             — |             — |              6 + 14 |        10 + 19 |
| Example tier 2: browser download / cache restore + `install-deps` |            18 |            16 |              3 + 10 |         3 + 10 |
| Tier 2 `test:e2e`                                                 |            35 |            34 |                  33 |             31 |

## Table 3: integration packages

CI = vitest `Duration` (runs as above). Local = wall of
`pnpm --filter <pkg> exec vitest run --project integration --reporter=json --outputFile=<file>`
run alone on the 1-CPU machine; all four green.

| Package                   | CI before (519611 / 750365) | CI after (#1 / #2) |       Local after (wall) | Files / tests |
| ------------------------- | --------------------------: | -----------------: | -----------------------: | ------------- |
| builtin-cloud-data-server |                101.1 / 95.4 |    **14.3 / 12.5** |                     21.9 | 2 / 63 both   |
| storage-aurora-dsql       |                101.6 / 96.3 |    **14.0 / 12.2** |                     31.9 | 4 / 80 both   |
| admin-installer           |                 28.3 / 25.4 |      **3.5 / 3.1** |                     12.7 | 2 / 20 both   |
| local-data-server         |                 60.4 / 53.8 |    **39.9 / 49.3** |                    150.8 | 38 / 429 both |
| admin-web                 |                 17.6 / 15.6 |        16.0 / 16.8 | 216 (12 fail, see below) | 11 / 91 both  |
| testkit                   |                   6.7 / 8.6 |          8.3 / 8.0 |                        — | 2 / 12 both   |
| sync-engine               |                   1.0 / 1.0 |          0.8 / 1.2 |                        — | 1 / 32 both   |

## Table 4: five slowest unit packages

CI = vitest `Duration` in the `turbo run test --concurrency=2` step. Local = task
time from `.turbo/runs/*.json` of
`pnpm turbo run test --force --only --continue --concurrency=2 --summarize` (1 CPU).

| Package                   | CI before (519611 / 750365) | CI after (#1 / #2) | Local after |
| ------------------------- | --------------------------: | -----------------: | ----------: |
| admin-web                 |                 25.7 / 37.3 |        30.4 / 35.3 |       121.2 |
| admin-installer           |                 17.3 / 26.6 |        21.4 / 25.0 |       101.7 |
| sync-engine               |                  8.6 / 11.8 |        10.6 / 11.7 |        55.6 |
| builtin-cloud-data-server |                   6.3 / 7.7 |          8.3 / 7.5 |        39.6 |
| storage-sqlite            |                   2.8 / 4.3 |          4.1 / 4.0 |        20.5 |

## Local runs (1-CPU machine, `eaf0ed2`)

| Command                                                                     | Before (baseline machine)            | After                         |
| --------------------------------------------------------------------------- | ------------------------------------ | ----------------------------- |
| `pnpm test` (root script, `--concurrency=2` since AI-724)                   | 113 s, failing (default concurrency) | **203 s, green**, 21/21 tasks |
| `pnpm turbo run test --force --only --continue --concurrency=2 --summarize` | 104 s, green                         | 256 s, green                  |
| same for `test:integration`                                                 | not recorded                         | 412 s, 2 tasks failed (below) |

Integration failures, both environment-specific (CI is green on the same sha):
`admin-web` `daemon.test.ts` / `daemon-orphan.test.ts` 12 tests fail standalone too:
`src/lib/daemon-control.ts:70` calls `lsof`, absent in this container.
`local-data-server` `supervisor-lifecycle.test.ts` "waits for the round in flight"
timed out under load (8.9 s); passes when the package runs alone (429/429).

## Test counts (unchanged)

| Suite                                                     | Baseline runs (both)                      | After runs (both)      | Local after                                           |
| --------------------------------------------------------- | ----------------------------------------- | ---------------------- | ----------------------------------------------------- |
| Unit, `turbo run test --concurrency=2`                    | 20 packages, 252 files, 3845 tests passed | 252 files, 3845 passed | `pnpm test`: 252 files, 3845 passed                   |
| Integration, `turbo run test:integration --concurrency=2` | 7 packages, 60 files, 727 tests passed    | 60 files, 727 passed   | 60 files / 727 collected; 714 passed (failures above) |

## What did not move

- Unit step: 54–74 s → 63–72 s. No issue targeted it; it is now the critical path
  on attempt 1 (Tier 1 (unit) 89–93 s).
- admin-web unit 25.7–37.3 s → 30.4–35.3 s; admin-installer unit 17.3–26.6 s → 21.4–25.0 s;
  sync-engine 8.6–11.8 s → 10.6–11.7 s.
- `format:check` 10–15 s → 10–16 s.
- Tier 2 `test:e2e` 34–35 s → 31–33 s; Tier 2 job 79–102 s is now the slowest job on
  the warm attempt, from Playwright cache restore (6–10 s) + `install-deps` (14–19 s).
- local-data-server integration 60.4 s → 39.9–49.3 s (AI-732's ≤35 s target missed;
  AI-765 in Backlog). It alone sets the Integration (processes) job.
- admin-web integration 15.6–17.6 s → 16.0–16.8 s.
- Lint/typecheck on a commit that changes `pnpm-lock.yaml` or `turbo.json`: 54 s,
  12/51 cached. The `tier-1` job's fallback restore-key `turbo-Linux-tier-1-` also
  matches `turbo-Linux-tier-1-unit-…`, and attempt 1 restored the unit job's cache.

## Next issues (proposed)

- admin-web unit (30–35 s) and admin-installer unit (21–25 s) profiled and cut.
- Per-package vitest `maxWorkers`/`pool` (none set; unit step is the critical path).
- Turbo `inputs` for `test` tasks so unaffected packages can skip (needs a decision
  against `cache: false` in `turbo.json`).
- admin-web `daemon*.test.ts` (named by the baseline); they also need `lsof`
  (fail in containers without it).
- `tier-1` Turbo cache restore-key collides with `tier-1-unit` (filed: AI-767).
- Already filed: AI-764 (`install-deps` when browsers cached), AI-765 (local-data-server
  slowest files).
