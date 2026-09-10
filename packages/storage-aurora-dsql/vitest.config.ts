import { defineConfig } from "vitest/config";

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
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
