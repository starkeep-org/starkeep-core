import { defineConfig, devices } from "@playwright/test";

// Arm the real-state guard in starkeepDir() for this run and every process it
// spawns (the LDS, next dev, app daemons all inherit ...process.env). Vitest
// sets VITEST itself; Playwright has no equivalent, so we set the flag here.
process.env.STARKEEP_TEST_GUARD = "1";

/**
 * Tier-2 config. One platform stack is booted in global-setup and shared by
 * every spec, so tests run serially in a single worker — the flows mutate
 * shared platform state (install/uninstall, daemon start/stop).
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
});
