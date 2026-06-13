# Cache invalidation for app credentials and HMAC secrets on uninstall/reinstall

`getAppCreds` in `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts` caches STS credentials per `appId` for ~14 minutes (slightly under the 15-minute STS lifetime, with a 60-second skew). If an admin uninstalls an app and immediately reinstalls it on a warm Lambda, the cached entry refers to the *old* role's RoleId. The new role is a different identity even though it has the same name and ARN.

The functional review claims this leaves the Lambda brokering under stale credentials until the TTL expires or the worker recycles. **This claim should be validated with a manual test before any code is written**: it's plausible that STS credentials issued against a deleted role become immediately invalid at the data-plane (DSQL DbConnect, S3 sigv4), in which case the only observable effect is per-request failures for up to ~14 minutes, not "old role keeps working". The two failure modes have very different fix surfaces:

- If old creds fail immediately: small, local fix — catch the AssumeRole-failure / DbConnect-failure on the per-request adapter init, evict the cache entry, retry once.
- If old creds keep brokering successfully against the new role (unlikely but worth checking): the issue is real cross-identity authority leak and the fix needs an explicit invalidation hook driven by install/uninstall.

Suggested test: write a record under an app, uninstall + reinstall the same app within a couple minutes, immediately hit a data-plane route on the warmed Lambda, observe what happens.

## Same property now applies to `hmacSecretCache` (2026-06-11)

The 2026-06-10 HMAC-auth work added a parallel cache: `hmacSecretCache` in the same file holds each app's HMAC secret from SSM for 5 minutes. An uninstall + reinstall rotates the SSM SecureString (the installer's `put_app_creds_parameter` step writes the new value, and `ensureLocalHmacSecret` may mint a fresh one if no local creds file exists), but warm Lambdas continue to accept signatures under the *old* secret — or reject signatures from the new caller signing with the *new* secret — until the cache expires.

The fix shape is the same: an explicit invalidation hook driven by install/uninstall, applied to both `credentialCache` and `hmacSecretCache`. Worth solving together rather than as separate patches.

From doc id 14 (`functional-doc-cloud-data-server-2026-06-05.md`), Part 2 — Missing behaviors, and doc id 18 (`functional-doc-cloud-apps-2026-06-05.md`), Part 2 — Potential gaps.

Revisit when: someone is hardening install/uninstall flows for production, or sooner if a real user hits either failure mode.

## Progress: `hmacSecretCache` mode validated; partial mitigation landed (2026-06-13)

The Tier-3 e2e-aws runner (test-plan §11, first green run) directly **validated the `hmacSecretCache` failure mode**. With a warm broker, after the install CLI rotated an app's SSM secret, signed requests under the new secret 401'd until the cache expired — confirmed by reading the SSM parameter history, the broker Lambda env, and a signed-curl burst that flipped to 200 only after the 5-min TTL lapsed. So the "warm Lambda keeps using the stale secret" claim is real for the HMAC cache.

Two changes landed on `aaron/tests` (commit `c5a5857`) that mitigate but do **not** fully close this:
- `HMAC_CACHE_TTL_MS` is now an env knob on the broker Lambda (default 5 min). The Tier-3 suite sets it to `0` so rotation/revocation take effect immediately under test. This is a tunable, not an invalidation hook — production still has the up-to-5-min window.
- The installer's `put_app_creds_parameter` step is now `alwaysRun` (reconciles SSM to the current local secret on every drive), so a re-minted local secret reliably reaches SSM — removing one *source* of divergence, but not the warm-cache staleness itself.

**Still open** (the actual ask here): the `getAppCreds` **STS-creds** cache on uninstall/reinstall is unvalidated and unaddressed, and neither cache has an explicit install/uninstall-driven invalidation hook. Keep this todo in backlog for that work.
