import { defineConfig, devices } from "@playwright/test";

// Arm the platform's guard against touching real state, for this run and every
// process it spawns. Playwright sets no flag of its own the way Vitest does.
process.env.STARKEEP_TEST_GUARD = "1";

/**
 * One platform stack, booted in global-setup and shared by the spec. The spec
 * walks the page top to bottom, so it runs serially in one worker.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    actionTimeout: 20_000,
  },
});
