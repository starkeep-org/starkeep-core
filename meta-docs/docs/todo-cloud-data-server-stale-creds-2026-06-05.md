# Cache invalidation for app credentials on uninstall/reinstall

`getAppCreds` in `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts` caches STS credentials per `appId` for ~14 minutes (slightly under the 15-minute STS lifetime, with a 60-second skew). If an admin uninstalls an app and immediately reinstalls it on a warm Lambda, the cached entry refers to the *old* role's RoleId. The new role is a different identity even though it has the same name and ARN.

The functional review claims this leaves the Lambda brokering under stale credentials until the TTL expires or the worker recycles. **This claim should be validated with a manual test before any code is written**: it's plausible that STS credentials issued against a deleted role become immediately invalid at the data-plane (DSQL DbConnect, S3 sigv4), in which case the only observable effect is per-request failures for up to ~14 minutes, not "old role keeps working". The two failure modes have very different fix surfaces:

- If old creds fail immediately: small, local fix — catch the AssumeRole-failure / DbConnect-failure on the per-request adapter init, evict the cache entry, retry once.
- If old creds keep brokering successfully against the new role (unlikely but worth checking): the issue is real cross-identity authority leak and the fix needs an explicit invalidation hook driven by install/uninstall.

Suggested test: write a record under an app, uninstall + reinstall the same app within a couple minutes, immediately hit a data-plane route on the warmed Lambda, observe what happens.

From doc id 14 (`functional-doc-cloud-data-server-2026-06-05.md`), Part 2 — Missing behaviors.

Revisit when: someone is hardening install/uninstall flows for production, or sooner if a real user hits the failure mode.
