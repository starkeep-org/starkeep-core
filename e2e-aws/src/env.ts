/**
 * Tier-3 env contract. The suite is inert unless STARKEEP_AWS_TESTS=1 —
 * `pnpm test:aws` without it reports a skipped suite, never touches AWS.
 *
 *   STARKEEP_AWS_TESTS=1            enable (required)
 *   STARKEEP_AWS_STACK_PREFIX       dedicated test prefix (default "sktest";
 *                                   must never be the live deployment's prefix)
 *   STARKEEP_AWS_REGION             region for a from-scratch bootstrap
 *                                   (default "us-east-2"; an existing stack's
 *                                   own region always wins via its pool ID)
 *   STARKEEP_AWS_TEARDOWN           what to tear down after a SUCCESSFUL run:
 *                                   "all" (default) → teardown-bootstrap.sh,
 *                                   "apps" → teardown-cloud-data-server.sh,
 *                                   "none" → keep everything up. A run with any
 *                                   failed step never tears down, regardless of
 *                                   this value, so the stack is left for
 *                                   debugging.
 */

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
export const REGION = process.env.STARKEEP_AWS_REGION ?? "us-east-2";
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
