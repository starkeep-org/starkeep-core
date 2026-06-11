# Plan: foundational fixes for the 2026-06-10 cloud-auth pass

Companion to the revised functional reviews of `cloud-apps` and
`cloud-data-server` (both dated 2026-06-05, revised 2026-06-10). Those
reviews flag a set of bugs introduced by the HMAC-auth + `/app-data/*`
work; this plan addresses the ones that block the system from working
end-to-end, in dependency order. Lower-impact findings are deferred at
the bottom.

Source-ref at planning time: `starkeep-core @ 345ec13`,
`starkeep-apps @ f4270ad`.

## Step 1 — Decide and apply the gateway auth posture

Pick one (recommended: **drop the JWT authorizer** on reserved routes):

- The 2026-06-10 handoff plan
  (`plan-cloud-apps-app-data-cloud-plane-2026-06-10.md`) explicitly chose
  "Style B: per-app credentials identify the app, not the end user."
  A gateway-level Cognito JWT authorizer is checking end-user identity —
  incoherent with that decision.
- Edit `packages/admin-installer/src/builtin-programs/cloud-data-server-program.ts`:
  remove `authorizerId` / `authorizationType` from `route-app-health`,
  `route-data-proxy`, `route-files-proxy`, `route-sync-proxy`. Leave the
  `cognito-jwt` `Authorizer` resource alone for now if admin-web or any
  other flow still references it; remove only if nothing does.
- The HMAC verifier in
  `packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts`
  becomes the sole identity check on `/apps/{appId}/*`. That's the
  intended end state.

## Step 2 — Make `/app-data/*` reachable

Two coupled edits, both small:

- In `cloud-data-server-program.ts`, add a `route-app-data-proxy`:
  `ANY /apps/{appId}/app-data/{proxy+}` → same Lambda integration, no
  authorizer (after Step 1).
- In `packages/admin-installer/src/pulumi-program.ts`, add `"app-data"`
  to `RESERVED_SUBPATHS` so per-app installs reject manifest collisions
  on that prefix.
- No handler changes needed — the `/app-data/*` logic already exists in
  `api-handler.ts` (~line 923, `if (subPath.startsWith("/app-data/"))`).

## Step 3 — Fix the dedup unique index

The current `(original_filename, content_hash, deleted_at)` index does
not collide on multiple NULLs (PG/DSQL default = NULLs distinct in
unique indexes). Two options:

- **Preferred:** `CREATE UNIQUE INDEX ASYNC ... ON shared.records
  (original_filename, content_hash, deleted_at) NULLS NOT DISTINCT` —
  verify DSQL supports `NULLS NOT DISTINCT` (PG 15+ feature) first. If
  so this is a one-word fix.
- **Fallback:** stamp live rows with a sentinel `deleted_at` value (e.g.
  the empty string, or epoch `'0:0:'`) instead of NULL, and treat that
  value as "live" everywhere that reads/writes it (broker registers,
  tombstone path, sync filters, `parent_id` integrity, the dedup index).
  More invasive but works on any PG-compatible store.
- Apply the matching change to `packages/storage-sqlite/src/schema/bootstrap.ts`
  so local SQLite mirrors the cloud's dedup semantics.

## Step 4 — Make the per-app secret an installer invariant

In `packages/admin-installer/src/orchestrator.ts`:

- `ensureLocalHmacSecret` currently mints a secret if the local creds
  file is missing but does not write the file back. Either:
  - (a) write the minted secret back to
    `~/.starkeep/app-creds/${appId}.json` and to the local registry's
    `hmac_secret` column whenever it mints, so the supervisor and the
    cloud verifier agree, or
  - (b) refuse to mint and require local install to have run first.
  (a) is friendlier; (b) is stricter. Pick based on whether cloud-only
  installs are a supported flow.

In `apps/local-data-server/sync-supervisor.ts`:

- `makeSignerFor` should throw on missing `hmacSecret` instead of
  warning and returning `undefined`. Silent unsigned traffic is the
  worst failure mode — the broker 401s it, but the warning is easy to
  miss in production logs.

## Step 5 — Migrate the Photos resize Lambda

In `starkeep-apps/photos/`, find the resize handler wired to
`POST /apps/photos/api/resize` and replace its JWT-forwarding broker
calls with the same pattern the captions route now uses:

```ts
import { loadAppCredentialsAsync, signedFetch } from "@starkeep/app-client";

const creds = await loadAppCredentialsAsync("photos");
if (!creds) return notInstalled();
await signedFetch(creds, "/data/records", { ... });
```

Mirror the captions migration exactly (same import, same async load,
same signed call). Every broker call the resize handler makes —
fetching the source record, presigning original/resized URLs,
registering the thumbnail, writing `image` metadata — needs the swap.

## Verify end-to-end

After all five land, three flows that don't work today should work:

- **Captions:** GET/PUT/DELETE `/api/photos/captions/[id]` from the
  cloud-built photos app round-trips through the broker's
  `/app-data/db/image_enriched`.
- **Thumbnails:** `POST /apps/photos/api/resize` produces a thumbnail
  shared record registered via the broker.
- **Local→cloud sync:** the supervisor's `/sync/exchange` calls succeed
  under HMAC alone (no Bearer header, no gateway authorizer).

## Deferred — revisit after the foundation works

Not blocking; not in this plan:

- **HMAC replay protection.** No method/path/timestamp binding. Real,
  but the secret is internal to the platform; harden after end-to-end
  works.
- **HMAC cache invalidation on uninstall/reinstall.** Symmetric to the
  existing `getAppCreds` staleness item (todo 16); revisit together.
- **`GET /app-data/files` existence check** likely downloads bytes;
  swap to a HEAD-style probe.
- **20 MB PUT cap** vs. APIGW's 10 MB body ceiling — cosmetic.
- **Remove sync `loadAppCredentials`** or have it throw in cloud mode
  once every in-tree call site is migrated.

## Order of work

1. Step 1 (drop gateway authorizer on reserved routes) — small, unblocks
   everything else's testing.
2. Step 2 (route `/app-data/{proxy+}` + reserve the prefix) — small.
3. Step 3 (dedup index) — verify `NULLS NOT DISTINCT` on DSQL first; if
   unsupported, plan the sentinel-value migration as its own commit.
4. Step 4 (secret invariant + supervisor hard-fail) — small.
5. Step 5 (resize Lambda migration) — touches `starkeep-apps`.
6. End-to-end verify captions + thumbnails + sync exchange.
