import { defineConfig, devices } from "@playwright/test";

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
