# `system-design.md` vs. implementation — discrepancy review

Reviewed `starkeep-core/system-design.md` against the current implementation
(`packages/`, `apps/`). For each item I cite the doc location and the code
location and stay **agnostic** about which side is "correct" — the point is only
that they disagree, and someone who owns the design should decide which to move.

Confidence is noted per item. "Factual" = a concrete, checkable claim that does
not match code. "Framing" = the facts roughly hold but the doc's emphasis,
mechanism, or model differs from what the code actually does.

---

## Factual discrepancies

### F1. A record's `type` is a `<category>/<format>` id, not a file extension *(high confidence)*

- **Doc:** §"How data is classified" → "Shared data" (lines 82–85). "A single
  records table holds one row per item — id, **type (the lowercase file
  extension)**…"; "**Identified by extension, organized by category.** An item's
  `type` is its lowercase file extension; the platform owns a hardcoded
  `extension → category` map (Images, Videos, Documents, …)."
- **Code:** `packages/protocol-primitives/src/types/core-types.ts`. A record's
  canonical identity is a two-level Starkeep type id like `image/jpeg` /
  `document/markdown` / `other/other` — **not** an extension and **not** a MIME
  type. The file extension is explicitly "advisory metadata only and never
  decide identity" (`EXTENSIONS` is "NOT the law"). Category is the structural
  *prefix* of the type id (`typeCategory(id)` splits on `/`), not a lookup
  through an extension→category map. The header comment notes this "replaces the
  old extension-derived `categoryOf`." `records/types.ts:6-13` documents `type`
  the same way.
- **Read:** The doc describes a superseded model (extension-as-identity +
  ext→category map). The implementation moved to app-declared canonical
  `<category>/<format>` type ids. This is the single largest divergence and it
  ripples through several other doc sentences (e.g. "Apps cannot invent new
  types; they declare the exact extensions they handle").

### F2. The reason `other` is app-invisible doesn't match the mechanism *(high confidence)*

- **Doc:** line 83. `other` is "visible only to Starkeep Drive … never to an
  installable app, **since an app could only reach a file by declaring its
  extension and `other` is exactly the set of extensions no app can declare**."
- **Code:** `core-types.ts` → `APP_GRANTABLE_CATEGORIES = CATEGORY_IDS.filter(c
  => c !== "other")`. Apps are granted **categories/types**, and `other` is
  excluded from the grantable set; Drive reaches it via its `shared/*` IAM
  ceiling (`fileAccessAll`). The *conclusion* (other is Drive-only) is correct,
  but the *mechanism* in the doc (extension declaration) is not how the code
  enforces it.

### F3. Bootstrap creates the User-Data-Owner *permissions boundary*, not the role *(high confidence)*

- **Doc:** line 25. The bootstrap stack "creates the identities … (Cognito
  pools, Manager, install-ddl, install-infra, the Pulumi state bucket, the
  foundational + per-app + install-time permissions boundaries, **and the
  reserved User-Data-Owner role**)."
- **Code:** `packages/aws-bootstrap/src/bootstrap/bootstrap-template.ts` creates
  IAM **roles**: `app-admin-role`, `manager-role`, `install-ddl-role`,
  `install-infra-role`; and managed-policy **boundaries** including
  `UserDataOwnerPermissionsBoundary`. The User-Data-Owner **role itself is
  minted at Starkeep Drive install**, not at bootstrap —
  `user-data-owner-permissions-boundary.ts:7` says it is "the *ceiling* for the
  single User-Data-Owner role minted at Starkeep Drive install," routed by a
  magic-string check in the installer's `createAppRole`.
- Secondary: the doc's bootstrap enumeration omits the **admin role**
  (`app-admin-role`), which bootstrap *does* create, while listing the
  User-Data-Owner role, which it does not.

### F4. There is no `path` column on the records row *(medium confidence — possibly loose wording)*

- **Doc:** line 82 lists the row as "id, type …, **path**, timestamps, OCC
  version, common bookkeeping." Line 81: items "map cleanly onto a filesystem."
- **Code:** `records/types.ts` `DataRecord` has no `path`. The blob is
  **content-addressed**: `objectStorageKey = shared/<category>/<shard>/<hash>`
  (`storage/object-keys.ts`) + `contentHash`. There is no human-meaningful path,
  and hash-sharded keys do not "map cleanly onto a filesystem" in the sense the
  doc implies. If "path" was meant as a synonym for `objectStorageKey`, the term
  is misleading.

### F5. Image metadata has no `format` column *(low confidence — example nit)*

- **Doc:** line 84, parenthetical example: "(e.g. for images: width, height,
  format)."
- **Code:** `core-types.ts` `IMAGE_METADATA_COLUMNS` = width, height,
  color_space, orientation, captured_at, camera/lens, f_number, exposure, iso,
  focal_length, gps. No `format` — format is part of the type id, not a metadata
  column. Width/height match; "format" does not.

---

## Framing / emphasis discrepancies

### S1. "The same SDK runs against both" (Stance #3) holds for local only — and the access story is messier than three parallel filters *(high confidence — most consequential framing issue)*

- **Doc:** Stance #3 (lines 15, 69) and the closing paragraph (line 154): "the
  same SDK runs against both [local and cloud]," and "a type-level filter that
  is missing fails in the same shape locally as in the cloud" / "a misconfigured
  grant denies in development the same way it denies in production."

- **What the code actually does (after a closer look):**

  1. **Local** (`apps/local-data-server/server.ts`) constructs the SDK
     (`createStarkeepSdk`, line 498) **but does not pass a `subject`**. In
     `sdk.ts:96-103`, the access-control engine only wraps the database adapter
     when `subject` is set (`createEnforcedDatabaseAdapter`). With no subject the
     SDK runs against the **raw** adapter — so the SDK's access-control engine
     **does not gate any local read/write**. Sharing tokens are explicitly
     disabled (`disabledSharingTokenStore()`, line 505). The engine is
     instantiated and `loadPolicies()` runs, but it is dormant on the data path.
  2. **Local enforcement** is therefore the inline `appCanRead` / `appCanWrite` /
     `appCanWriteCategory` helpers (`server.ts:101-132`), which read the
     `shared_access_grants` SQLite table per request at the HTTP route layer.
  3. **Cloud enforcement** is `access-enforcer.ts` (`loadAccessGrants` +
     `canRead` / `canWrite` / `canReadCategory`), which reads the
     `shared.access_grants` DSQL table — backed underneath by the per-app IAM
     role (S3 prefix) and PG GRANTs (metadata tables). The cloud handler never
     touches `@starkeep/sdk`.

- **So the "three filters" are really:**
  - **Two near-identical, live filters** — local `appCan*` over SQLite and cloud
    `canRead/canWrite` over DSQL. Same predicate (all-access app-id shortcut →
    per-type grant lookup → category derivation), copied across two stores. The
    one *intentional* difference is that local's all-access set
    (`ALL_ACCESS_APP_IDS`, `server.ts:99`) includes `local-watcher` as well as
    `starkeep-drive`, whereas cloud lists only `starkeep-drive`
    (`access-enforcer.ts:54`) — correct by construction, since `local-watcher`
    is a local-only ingest identity that never makes a cloud request. The
    duplication risk is the shared predicate being maintained twice, not this
    deliberate divergence.
  - **One dormant, different-shaped filter** — the SDK/`@starkeep/access-control`
    engine (policies, `checkAccess`, sharing tokens). It is a *policy/subject*
    model, not the *manifest-grant per-type* model the system actually runs on,
    and it is wired into neither live path.

- **Why the cloud legitimately can't just call `createStarkeepSdk`:** the SDK is
  shaped for a stateful single-node host, not a stateless Lambda. It owns one
  long-lived HLC clock seeded from a `syncStateStore` with debounced `onTick`
  write-back (`sdk.ts:55-77`); the cloud needs a fresh per-request clock with a
  per-instance `nodeId` seeded from the DB (`api-handler.ts` `makeCloudClock`,
  `CLOUD_NODE_ID`). The SDK's write API holds bytes (`putWithFile` →
  `objectStorageAdapter.put`; `putWithLocalFile` even does `node:fs` `readFile`),
  whereas the cloud is presign + content-addressed register and never holds the
  bytes. And the SDK's *enforcement* is the dormant policy engine, which is the
  wrong model for the cloud anyway. So a wholesale "use the SDK in the cloud" is
  not the right move.

- **But the duplication is still real and consolidatable.** The genuinely
  side-agnostic logic is *already* shared on both sides: `protocol-primitives`
  (types, object keys, HLC), `sync-engine` (`createInProcessSyncTransport`),
  `shared-space-api` (`createAppSpecificFactory`). The piece that was copied
  rather than shared is the **access-grant model** — `AccessGrants`, the
  all-access shortcut, the grant→category derivation, and `canRead/canWrite/
  can*Category`. That is a pure function of (grants, type); only the *grant
  source* (SQLite vs DSQL) differs. It could live in one small shared module
  parameterized by a grant reader, which would also kill the
  drive-vs-watcher all-access drift noted above.

- **Recommended direction:**
  1. ~~Extract the access-grant predicate into one shared module; have both
     servers supply only their store reader.~~ **Done (2026-06-29):** the grant
     model and the `can*` predicates now live in `@starkeep/protocol-primitives`
     (`access/grants.ts` — `buildAccessGrants`, `canRead/canWrite/
     canReadCategory/canWriteCategory/canWriteMetadataCategory`). The cloud
     `access-enforcer.ts` and the local server's `appCan*` wrappers both delegate
     to it; each supplies only its store source (DSQL vs SQLite) and its
     all-access policy. Build/typecheck/tests pass.
  2. ~~Decide the fate of `@starkeep/access-control`'s policy engine + sharing
     tokens.~~ **Done (2026-06-29):** the policy engine, the enforced-database
     adapter, sharing tokens, the `AccessPolicyStore`, and the SDK's
     `accessControl` surface / `subject` option were a disconnected module
     (never wired into either live path) and have been removed —
     `@starkeep/access-control` is deleted, along with the SQLite
     `access_policies` table, `createSqliteAccessPolicyStore`, and the now-unused
     deps. Live access enforcement is unchanged (cloud `access-enforcer.ts`,
     local inline `appCan*`). Build, typecheck, and tests pass.
  3. ~~Reword Stance #3.~~ **Done (2026-06-29):** Stance #3 (and the
     local-data-server section, the Apps section, and the closing paragraph) no
     longer claim "the same SDK runs against both." They now state that local
     and cloud are *separate hosts* (SDK-driven local; standalone Lambda cloud)
     built from the same shared primitives — including the now-unified
     access-grant predicate, which is what actually backs the "fails in the same
     shape locally as in the cloud" guarantee.

### S2. Residency is derived from two facts, not three *(high confidence)*

- **Doc:** §"Per-record residency" (lines 129–135): "The state is derived from
  **three persisted facts together: 1. row presence 2. blob presence 3. this
  side's own watermark position** relative to this record's `updated_at`." Also
  presents "Equivalently: own-side watermark does not yet cover this record's
  `updated_at`" as co-equal with blob-presence for the Staged state.
- **Code:** the canonical derivation `residencyOf`
  (`packages/sync-engine/src/residency.ts`) reads only **row presence +
  `deleted_at` + blob presence** (`localStorage.has(key)`). It never consults
  the watermark. The watermark is the **durability backstop** for re-surfacing
  Staged records across rounds (`sync-engine.ts` watermark gating), not an input
  to the residency classification.
- **Read:** The watermark equivalence is true as an *invariant* but the doc
  elevates it to a third co-equal *input* of the derivation, which the canonical
  function does not do.

### S3. "app-records" is not a distinct record kind *(medium confidence)*

- **Doc:** lines 120, 137 refer to "app-records whose app stores files" and say
  "app-records may opt out [of blobs] per record."
- **Code:** there is exactly one record kind — `kind: "data"` (`DataRecord`,
  `records/types.ts:31`), which is always blob-backed. The file-bearing
  app-syncable rows the residency model also covers are "AR" rows in the
  reserved `_starkeep_sync_records` table (`sync-engine.ts:14,36`); non-file
  app-syncable rows live in per-app metadata tables and "don't reach
  [`residencyOf`]" (`residency.ts:28-30`). So "app-record" as a kind, and "opt
  out per record," are loose labels for a structural split between two
  app-syncable storage destinations rather than a per-record flag.

### S4. "OCC version" column vs. "no OCC" *(low confidence — internal tension)*

- **Doc:** line 82 lists an "OCC version" column; line 91 says shared-record
  sync has "no OCC."
- **Code:** `DataRecord.version` exists and is incremented on PUT
  (`api-handler.ts:962`), but conflict resolution is last-writer-wins on the HLC
  `updatedAt` — `version` is not used for optimistic concurrency. Calling the
  column "OCC version" in line 82 sits awkwardly with the "no OCC" statement in
  line 91 and with how `version` is actually used.

---

## Notes (not strictly doc-vs-code conflicts, but relevant)

- **Sharing tokens exist in the abstraction but are disabled.**
  `@starkeep/access-control` ships a policy resolver, `SharingToken`, and a
  `SharingTokenStore`, but the live system passes `disabledSharingTokenStore()`
  ("not wired anywhere today … throws on every call",
  `apps/local-data-server/server.ts:502-505`), and the cloud handler lists a
  "sharing-token op" only as a hypothetical future write path
  (`api-handler.ts:406`). The doc never claims sharing tokens, so this is not a
  contradiction — but it reinforces S1: the access-control abstraction is
  broader than what is actually on the live data path, which is part of why
  "the same SDK runs against both" reads as more unified than the code is.

- **Bootstrap also creates an `ArtifactsBucket`** (deployment-bundle store,
  `bootstrap-template.ts:378`) that the doc's bootstrap list (line 25) does not
  mention. The doc does say "supporting resources," so this is a completeness
  note rather than a conflict; the Pulumi state bucket the doc *does* name is
  confirmed present (`PulumiStateBucket`, line 355).

---

## Summary

| # | Item | Type | Confidence |
|---|------|------|-----------|
| F1 | `type` is `<category>/<format>`, not a file extension | Factual | High |
| F2 | `other` invisibility mechanism is category-grant, not extension | Factual | High |
| F3 | Bootstrap makes the User-Data-Owner *boundary*, not the role (and omits admin role) | Factual | High |
| F4 | No `path` column; blob is content-addressed | Factual | Medium |
| F5 | No image `format` metadata column | Factual | Low |
| S1 | "Same SDK runs against both" — cloud doesn't use the SDK; enforcement duplicated 3× | Framing | High |
| S2 | Residency derived from 2 facts, not 3 (watermark is a backstop, not an input) | Framing | High |
| S3 | "app-records" / "opt out per record" isn't a real record kind | Framing | Medium |
| S4 | "OCC version" column vs. "no OCC" | Framing | Low |

The cluster worth prioritizing: **F1/F2** (the type-system section describes a
model the code has replaced) and **S1** (the headline "same SDK both sides"
guarantee about access enforcement, which the cloud path does not share).
