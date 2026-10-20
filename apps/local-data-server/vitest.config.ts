import { configDefaults, defineConfig } from "vitest/config";

/**
 * Almost every test in this package boots one or more **real server
 * subprocesses** — that is the point of them, since the things worth checking
 * here (dotenv resolution before the data dir is read, two instances not
 * leaking into each other's root, SSE over a live connection) cannot be
 * observed in-process.
 *
 * Vitest's 5 s default is a unit-test budget and does not fit that. It held
 * only while the machine was otherwise idle: run the monorepo's tests and
 * typechecks together and a couple of these spawns cross 5 s and fail on the
 * clock rather than on an assertion — a red suite that says nothing about the
 * code. The assertions themselves are unchanged; only the patience is.
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
