import { configDefaults, defineConfig } from "vitest/config";

/**
 * A longer per-test timeout than the 5s default. Each integration file boots
 * PGlite, a WebAssembly Postgres, once per file (the conformance files keep a
 * pool of up to two, for `peer()`) and resets it between cases. A cold boot
 * takes most of a second on its own, and under the full monorepo run — twenty
 * packages' suites in parallel — the case or hook that pays it has crossed the
 * 5s and 10s defaults while passing in isolation every time.
 *
 * A test that fails only when other tests are running is reporting machine load
 * rather than a defect, and the cost of that is worse than the cost of a slow
 * test: it trains a reader to rerun rather than to look.
 *
 * The hook timeout rises with it because `node-watermarks.test.ts` and
 * `two-users.test.ts` boot their PGlite in `beforeAll`, where the 10s hook
 * default applies instead.
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
