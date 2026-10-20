import { configDefaults, defineConfig } from "vitest/config";

/**
 * `builtin-apps/*` are workspace packages with their own `test` task and their
 * own vitest config. Without this exclude, a bare `vitest run` here sweeps their
 * suites up too and runs them a second time under vitest's default timeouts
 * rather than the 30s their config sets for PGlite boots, where
 * `two-users-routes.test.ts` timed out on a fresh clone.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "builtin-apps/**"],
  },
});
