import { configDefaults, defineConfig } from "vitest/config";

/**
 * Unit tests run in `test` (tier 1, required in CI); tests that boot a process,
 * a socket or a database engine live in `__tests__/integration/` and run in
 * `test:integration`. Both of this package's suites are integration tests: the
 * fake cloud serves HTTP on loopback, and the harness spawns the local data
 * server.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
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
