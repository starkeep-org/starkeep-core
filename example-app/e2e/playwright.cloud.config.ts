import { defineConfig } from "@playwright/test";
import local from "./playwright.config";

/**
 * The same spec, against the cloud test stack. Opt-in: `pnpm test:e2e:cloud`
 * with `STARKEEP_AWS_TESTS=1`. Run it after each core release and on demand.
 *
 * Every request crosses CloudFront, API Gateway and a Lambda that may start
 * cold, so the timeouts are longer than the local project's.
 */
export default defineConfig({
  ...local,
  globalSetup: "./cloud-setup.ts",
  reporter: [["list"], ["./cloud-finish-reporter.ts"]],
  timeout: 600_000,
  expect: { timeout: 60_000 },
  use: { ...local.use, actionTimeout: 60_000 },
});
