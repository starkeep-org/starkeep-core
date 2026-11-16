/**
 * Tier-3 env contract. The suite is inert unless STARKEEP_AWS_TESTS=1 —
 * `pnpm test:aws` without it reports a skipped suite, never touches AWS.
 *
 *   STARKEEP_AWS_TESTS=1            enable (required)
 *   STARKEEP_AWS_STACK_PREFIX       dedicated test prefix (default "sktest";
 *                                   must never be the live deployment's prefix)
 *   STARKEEP_AWS_REGION             the region of the test stack (required,
 *                                   no default; see region.ts). A region that
 *                                   a live deployment uses prints a warning
 *                                   and the run goes on.
 *   STARKEEP_AWS_APP_DIR            the app to run the journey against, as an
 *                                   absolute or repo-relative path to its
 *                                   source directory. Unset selects the Probe
 *                                   fixture in `test-apps/`, which is what core
 *                                   ships and needs no other checkout. A path
 *                                   that holds no manifest fails the run rather
 *                                   than skipping it — asking for an app and
 *                                   silently getting a different one is the
 *                                   failure this option exists to prevent.
 *   STARKEEP_AWS_TEARDOWN           what to tear down after a SUCCESSFUL run:
 *                                   "all" (default) → teardown-bootstrap.sh,
 *                                   "apps" → teardown-cloud-data-server.sh,
 *                                   "none" → keep everything up. A run with any
 *                                   failed step never tears down, regardless of
 *                                   this value, so the stack is left for
 *                                   debugging.
 *
 * The repository's .env and .env.local are loaded first, so the region can
 * live there. An exported variable wins over both.
 */
import "@starkeep/app-client/load-env";
import { liveDeployments, testRegion } from "./region.js";

export const AWS_TESTS_ENABLED = process.env.STARKEEP_AWS_TESTS === "1";

/**
 * Broker HMAC secret-cache lifetime baked into the cloud-data-server Lambda at
 * install (forwarded by the pulumi program when set). The suite installs and
 * uninstalls apps and then immediately makes signed cloud calls, so it sets
 * this to "0" (no caching) to avoid the broker serving a rotated/revoked
 * secret out of its default 5-min cache. Real installs leave it unset.
 */
export const HMAC_CACHE_TTL_MS = process.env.HMAC_CACHE_TTL_MS ?? "0";
export const STACK_PREFIX = process.env.STARKEEP_AWS_STACK_PREFIX ?? "sktest";

/**
 * Checked only when the suites run. A skipped suite needs no region, so it
 * neither throws nor warns.
 */
function resolveRegion(): string {
  const requested = process.env.STARKEEP_AWS_REGION;
  if (!AWS_TESTS_ENABLED) return requested?.trim() ?? "";
  const { region, warning } = testRegion(requested, liveDeployments());
  // Straight to stderr: vitest hides console output from passing and skipped
  // tests, and this warning must show on a green run.
  if (warning) process.stderr.write(`\n${warning}\n\n`);
  return region;
}
export const REGION = resolveRegion();
export type TeardownMode = "all" | "apps" | "none";

/**
 * Post-run teardown, applied only when the journey fully passes. Defaults to
 * "all" so a green run leaves nothing behind — the test stack is disposable and
 * stale cloud resources cost money and confuse the next run. Set "none" to keep
 * the stack up (e.g. to iterate against a warm stack); "apps" tears down the
 * cloud-data-server + app plane but keeps the bootstrap layer.
 */
export const TEARDOWN: TeardownMode =
  (process.env.STARKEEP_AWS_TEARDOWN as TeardownMode | undefined) ?? "all";

/**
 * The app directory the journey runs against, or undefined for core's fixture.
 *
 * Configured rather than detected. A suite that probed for a sibling checkout
 * would run different coverage on two machines and say so nowhere; naming the
 * app makes the choice deliberate, reproducible and visible in the command that
 * started the run.
 */
export const APP_DIR = process.env.STARKEEP_AWS_APP_DIR;
