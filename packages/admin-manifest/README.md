# @starkeep/admin-manifest

Zod schema, types, and validator for Starkeep app manifests.

An app manifest is the single declaration a Starkeep app (built-in or installable) makes about itself: identity, install targets, requested file-extension grants, IAM-shaped permissions, app-specific syncable state, and any compute / shared-resource infra it needs. The admin-installer reads it to plan installs; admin-web reads it to render the Dashboard's app lists and to spawn local dev processes.

This package is the source of truth for that schema. It only describes and validates manifests — it does not load, persist, or apply them.

## Exports

```ts
import {
  appManifestSchema,
  validateManifest,
  KNOWN_EXTENSIONS,
  type AppManifest,
  type ValidationResult,
} from "@starkeep/admin-manifest";
```

- `appManifestSchema` — the top-level Zod schema. Defaults are applied on parse (e.g. `targets` defaults to `["local"]`, `infraRequirements` to an empty requirements block).
- Per-section schemas + inferred types: `fileAccessSchema` / `FileAccess`, `infraRequirementsSchema` / `InfraRequirements`, `appComputeHandlerSchema` / `AppComputeHandler`, `syncableTableSchema` / `SyncableTable`, `appSpecificSyncableSchema` / `AppSpecificSyncable`, `permissionEntrySchema` / `PermissionEntry`, `localRunSchema` / `LocalRun`, `sharedResourceRequirementSchema` / `SharedResourceRequirement`, `appTierSchema` / `AppTier`.
- `validateManifest(raw) => ValidationResult` — parses with the schema and then applies cross-field rules that Zod alone cannot express.
- `KNOWN_EXTENSIONS` — re-exported from `@starkeep/protocol-primitives`; the set of file extensions an installable app is allowed to claim.

## `validateManifest`

```ts
interface ValidationResult {
  valid: boolean;
  manifest: AppManifest | null;   // populated only when valid
  errors: string[];
  warnings: string[];
  impliedCategories: string[];    // distinct categories implied by fileAccess extensions
}
```

In addition to schema parsing, the validator enforces:

- Community-tier apps may not use the reserved `@starkeep/` id prefix.
- Every extension in `infraRequirements.fileAccess[].extensions` must be in `KNOWN_EXTENSIONS`. Apps cannot register new types — adding one requires editing `@starkeep/protocol-primitives`'s `core-types.ts`.
- `infraRequirements.fileAccessAll` is reserved for `starkeep-drive` (the User-Data-Owner). All other apps must enumerate extensions.
- `infraRequirements.brokerPower` is reserved for `cloud-data-server`.
- `compute.enabled` requires at least one handler.
- Warns when `metadataWrite` is set alongside `access: "readwrite"` (redundant).

## Manifest shape (quick reference)

- `id`, `name`, `version`, `tier` (`official` | `verified` | `community`)
- `targets`: where the app can be installed — `local`, `cloud`, or both. Drives the Dashboard's Local / Cloud split.
- `requiredPermissions`, `optionalPermissions`: IAM-shaped entries against shared-data resources (`type` / `collection` / `wildcard`) with `read` / `write` / `delete` / `admin`.
- `infraRequirements`:
  - `fileAccess[]`: enumerated extension grants with rationale and optional `metadataWrite`.
  - `fileAccessAll`: Drive-only all-access.
  - `compute`: enable + Lambda handler definitions (runtime, memory, timeout, routes, env, auth). `handler` resolves inside the app's bundled `dist.zip`; the installer does not synthesize handler code.
  - `appSpecificSyncable`: private per-app syncable tables (mapped to `<appId>_syncable_<name>` in local SQLite) and optional `files` opt-in for the `apps/<appId>/syncable/` object-storage prefix. `updated_at` and `deleted_at` are reserved column names.
  - `additionalResources` / `sharedResources`: extra cloud resources (`cloudfront`, `custom`).
  - `brokerPower`: `cloud-data-server` only.
- `localRun`: how admin-web should spawn the app's local process. With `portFlag` set, admin-web allocates a free port and appends `[portFlag, <port>]` to `args`.

## Scripts

- `pnpm build` — bundle with tsup
- `pnpm test` — vitest
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — eslint
