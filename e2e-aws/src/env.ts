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
 *   STARKEEP_AWS_TEARDOWN           "apps" → teardown-cloud-data-server.sh,
 *                                   "all" → teardown-bootstrap.sh, after the
 *                                   journey; default keeps the stack up
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
export const TEARDOWN = process.env.STARKEEP_AWS_TEARDOWN as "apps" | "all" | undefined;
