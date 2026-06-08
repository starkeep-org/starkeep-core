# Local data server — permissions TODOs (2026-06-01)

Scope: `local-server-permissions` sub-topic of `local-data-server`. Open items deferred from the 2026-06-01 functional review.

---

## HMAC secret rotation and revocation

Today an installed app's HMAC secret in `shared_app_registry` is valid for the lifetime of the install. There is no affordance to rotate the secret without uninstalling, and no affordance to revoke an active secret short of `DELETE /admin/apps/:appId`. If a secret leaks, the only mitigation is uninstall + reinstall, which loses any local app-state the app has accumulated.

**What's missing.** Two endpoints with corresponding registry behaviour:

- `POST /admin/apps/:appId/rotate-secret` — atomically replace the stored secret with a freshly-minted one; old secret immediately invalid for future HMAC validations. Returns the new secret to the caller.
- `POST /admin/apps/:appId/revoke` — flip the app's registry status away from `active` so `validateAppHmac` refuses every request. Reversible via a future `restore`/reinstall, but in the meantime the app's HMAC is dead.

**Open questions for whoever picks this up.**

- How does the rotated secret get to the app itself? The install flow returns the secret to the admin-web caller, which is responsible for handing it to the app. For rotation, the same handoff path works, but the app needs to be told its old secret no longer works — push to the app via some side channel, or have the app retry on first 401 and re-fetch from admin-web?
- Does revoke include automatic re-grant on next `/admin/apps/install` of the same manifest, or is revoke a one-way trip until explicitly restored?
- Should rotation invalidate currently-in-flight requests (since the body's already been HMAC'd against the old secret), or accept a small grace window during which both secrets validate? Grace window is friendlier; immediate invalidation is safer post-leak.

**Why deferred.** No concrete leak today and no production deployment story that depends on the affordance yet. Source: functional review at `docs/functional-doc-local-data-server-2026-06-01.md`, Part 2 missing-behaviors item 1. Revisit before any deployment context where third parties install apps the user did not write.
