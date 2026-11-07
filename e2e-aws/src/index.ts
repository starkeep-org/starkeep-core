/**
 * The tier-3 harness, for an app repository that wants the same cloud journey
 * run against its own application.
 *
 * Consume it the way `starkeep-apps` consumes `@starkeep/e2e` at tier 2: link
 * this package, describe the app as a `JourneyApp`, and call
 * `defineCloudJourney` from a `.test.ts` file. Pass `runStateDir` so the run's
 * cloud credentials and registry land in your checkout rather than in core's.
 */

export { defineCloudJourney, type CloudJourneyOptions } from "./journey.js";
export {
  type JourneyApp,
  type JourneyContext,
  type JourneyLabelKeys,
  type JourneyAppTable,
  type JourneyJwtRoute,
  type JourneyBrowserSurface,
} from "./journey-app.js";
export { AWS_TESTS_ENABLED, STACK_PREFIX, REGION, TEARDOWN, APP_DIR } from "./env.js";
export {
  runPaths,
  readConfig,
  writeConfig,
  type RunPaths,
  type TestStackConfig,
  type AdminCredentials,
} from "./run-state.js";
export {
  type AdminSession,
  CliFailure,
  runInstallCli,
  runTeardownScript,
  signInAdmin,
} from "./installers.js";
/**
 * The steps every cloud run starts with, for a suite that runs apart from the
 * journey against the same kept-up stack: bring the bootstrap stack up to date,
 * seed the CLI-facing config, and sign the test admin in.
 */
export {
  ensureBootstrapStack,
  stackConfigFrom,
  E2E_DEPLOYMENT_NAME,
  type BootstrapOutputs,
} from "./bootstrap-stack.js";
export { ensureAdminUser, signInTestAdmin } from "./admin-user.js";
export { cloudAppTokens, sessionCookieHeader, type CloudAppTokens } from "./cloud-app-session.js";
export { probeApp } from "./probe-app.js";
/**
 * The browser side. Imported from here rather than from `@playwright/test`
 * directly: Playwright refuses to be loaded twice in one process, and a
 * consumer resolving its own copy while the harness resolves core's is exactly
 * that.
 */
export {
  chromium,
  watchPageProblems,
  signInWithBrowser,
  type Browser,
  type Page,
  type BrowserSignInOptions,
} from "./browser.js";
