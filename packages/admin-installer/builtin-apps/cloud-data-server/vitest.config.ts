import { configDefaults, defineConfig } from "vitest/config";

/**
 * Unit tests run in `test` (tier 1, required in CI). Tests that boot a process,
 * a socket or a database engine live in `__tests__/integration/` and run in
 * `test:integration`.
 */
export default defineConfig({
  test: {
    environment: "node",
    // Each integration file boots one PGlite in `beforeAll`, where the 10s hook
    // default applies rather than testTimeout; CI runners crossed it. Each
    // `beforeEach` then drops the user schemas and re-runs the seed.
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
