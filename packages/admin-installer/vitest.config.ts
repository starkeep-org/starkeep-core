import { configDefaults, defineConfig } from "vitest/config";

/**
 * `builtin-apps/*` are workspace packages with their own `test` task and their
 * own vitest config. Without this exclude, a bare `vitest run` here sweeps their
 * suites up too and runs them a second time under vitest's default timeouts
 * rather than the 30s their config sets for PGlite boots, where
 * `two-users-routes.test.ts` timed out on a fresh clone.
 *
 * Unit tests run in `test` (tier 1, required in CI). Tests that boot a database
 * engine live in `__tests__/integration/` and run in `test:integration`.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "builtin-apps/**"],
    // PGlite boots in `beforeEach` in the integration suites, where the 10s
    // hook default applies rather than testTimeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["__tests__/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "builtin-apps/**", "__tests__/integration/**"],
        },
      },
      {
        extends: true,
        test: { name: "integration", include: ["__tests__/integration/**/*.test.ts"] },
      },
    ],
  },
});
