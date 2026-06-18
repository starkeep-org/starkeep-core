## Running tests

Three tiers:

1. `pnpm test`      — unit tests (turbo), fast, run by default
2. `pnpm test:e2e`  — local Playwright e2e (see e2e/README.md)
3. `pnpm test:aws`  — cloud e2e against real AWS; inert unless STARKEEP_AWS_TESTS=1. ~26 min, real account + cost. See e2e-aws/README.md for the full environment contract.