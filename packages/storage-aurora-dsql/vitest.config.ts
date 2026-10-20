import { configDefaults, defineConfig } from "vitest/config";

/**
 * A longer per-test timeout than the 5s default, for one reason: every case in
 * this package's conformance suites boots a fresh PGlite, which is a WebAssembly
 * Postgres. A cold boot takes most of a second on its own, and under the full
 * monorepo run — twenty packages' suites in parallel — the first case in a file
 * has repeatedly crossed 5s and failed while passing in isolation every time.
 *
 * A test that fails only when other tests are running is reporting machine load
 * rather than a defect, and the cost of that is worse than the cost of a slow
 * test: it trains a reader to rerun rather than to look.
 *
 * The hook timeout rises with it because `two-users.test.ts` boots its PGlite in
 * `beforeEach`, where the 10s hook default applies instead, and the full run
 * crossed that too.
 *
 * Unit tests run in `test` (tier 1, required in CI). Tests that boot a process,
 * a socket or a database engine live in `__tests__/integration/` and run in
 * `test:integration`.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["__tests__/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "__tests__/integration/**"],
        },
      },
      {
        extends: true,
        test: { name: "integration", include: ["__tests__/integration/**/*.test.ts"] },
      },
    ],
  },
});
