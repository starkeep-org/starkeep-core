# Drop `owner_id` from shared records

The `owner_id` field on shared records (cloud `shared.records`, local `shared_records`) is load-bearing in the schema but not load-bearing in any decision the system actually makes — and the two sides source it incompatibly, which silently breaks the constraint the field is supposed to support. Remove it.

## Why this is broken today

- **Local source** (`apps/local-data-server/server.ts:66`): `const OWNER_ID = process.env.STARKEEP_OWNER_ID || "starkeep-user";`. Read once at boot, stamped on every locally-created record.
- **Cloud source** (`packages/admin-installer/builtin-apps/cloud-data-server/src/api-handler.ts:401`): `const ownerId = claims?.sub ?? "unknown";`. Per-request, from the Cognito JWT.

For the same human user these two values are never equal. A record ingested locally arrives at the cloud (via the Drive channel) carrying `owner_id="starkeep-user"`; a record ingested directly via the cloud handler carries `owner_id=<cognito-sub>`. They sit side by side in `shared.records` as if owned by different users.

Direct consequences:

1. **The natural-key uniqueness index `uq_shared_records_owner_filename_hash (owner_id, original_filename, content_hash)` does not actually dedupe across sources** on the cloud. The same file ingested once locally and once via the cloud handler passes the index as two distinct rows. (Independent of the cross-device same-side case in [[todo-shared-data-sync-cross-device-duplicate-merge]] — that one assumed `owner_id` matched.)
2. **No authorization decision consults `owner_id`.** Authorization is `(Cognito user) × (per-app IAM role) × (manifest grants + application-layer type filter)`. The lone `owner_id` query filter (`apps/local-data-server/server.ts:1096`, `{ field: "ownerId", operator: "eq", value: OWNER_ID }`) is vacuous in a single-user-per-deployment system — it filters by the only value the server itself ever writes.
3. **The `"starkeep-user"` fallback masks misconfiguration.** A local server with no env var keeps running, writing rows under a literal placeholder string. Nothing pushes the operator to fix it.
4. **The field is "set from env" all over** — see [[todo-stop-reading-env-variables]] (covers the `STARKEEP_OWNER_ID` half of this directly).

## What the change is

Starkeep is single-user per deployment; the deployment *is* the owner. Drop the field.

- Remove the `owner_id` column from `shared.records` (DSQL: `packages/admin-installer/src/dsql-schema-init.ts:128`) and from `shared_records` (sqlite: `packages/storage-sqlite/src/schema/bootstrap.ts:38`).
- Simplify the natural-key index on both sides to
  `(original_filename, content_hash) WHERE deleted_at IS NULL AND original_filename IS NOT NULL`
  (`packages/storage-sqlite/src/schema/bootstrap.ts:57`, `packages/admin-installer/src/dsql-schema-init.ts:145`).
- Remove `ownerId` from the SDK / shared-space-api surface (`packages/shared-space-api/src/types.ts:74,114`, `packages/shared-space-api/src/shared-space-api.ts:37,45`) and from the SQLite serialization layer (`packages/storage-sqlite/src/serialization.ts:9,27,47`).
- Strip `ownerId` plumbing in `apps/local-data-server/server.ts` (lines 66, 446, 572, 993, 1067, 1078, 1096, 1111, 1589), `apps/local-data-server/watcher.ts` (lines 151, 154, 295), and the cloud handler (`api-handler.ts:337,401,534`).
- Drop `STARKEEP_OWNER_ID` env reading and the `"starkeep-user"` fallback. Remove the line from `apps/local-data-server/README.md:66`.
- Update tests that seed/assert `ownerId`: `packages/sync-engine/__tests__/exchange.test.ts`, `channel-split.test.ts`, harness `operations.ts` / `seeding.ts`.

Pre-production, so no migration is required — drop the column outright.

## Connections

- [[todo-shared-data-sync-cross-device-duplicate-merge]] — the natural-key index is the conflict point in that todo too. Doing this first simplifies the index there.
- [[todo-stop-reading-env-variables]] — `STARKEEP_OWNER_ID` removal lands here.
