import type { AppManifest } from "./schema.js";
import { appManifestSchema } from "./schema.js";
import { isKnownType, typeCategory } from "@starkeep/protocol-primitives";

export interface ValidationResult {
  valid: boolean;
  manifest: AppManifest | null;
  errors: string[];
  warnings: string[];
  /** Distinct categories implied by the manifest's declared types. */
  impliedCategories: string[];
}

const RESERVED_PREFIX = "@starkeep/";

// Only the User-Data-Owner app (Starkeep Drive) may claim all-access.
const FILE_ACCESS_ALL_APP_ID = "starkeep-drive";

export function validateManifest(raw: unknown): ValidationResult {
  const result = appManifestSchema.safeParse(raw);
  const errors: string[] = [];
  const warnings: string[] = [];
  const impliedCategories = new Set<string>();

  if (!result.success) {
    return {
      valid: false,
      manifest: null,
      errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      warnings: [],
      impliedCategories: [],
    };
  }

  const manifest = result.data;

  if (manifest.tier === "community" && manifest.id.startsWith(RESERVED_PREFIX)) {
    errors.push(`Community apps cannot use the "${RESERVED_PREFIX}" ID prefix`);
  }

  for (const entry of manifest.infraRequirements.fileAccess) {
    for (const type of entry.types) {
      if (!isKnownType(type)) {
        errors.push(
          `fileAccess: type "${type}" is not in the platform type registry. Apps may only declare known, mapped types; unmapped files belong to the Drive-only "other" category.`,
        );
        continue;
      }
      // `other/other` is a registered type but is the Drive-only catch-all:
      // ungrantable to installable apps. Reject it explicitly — `isKnownType`
      // alone would let it through (it's in the registry), re-opening the hole
      // the old extension map closed structurally (`other` was never mappable).
      if (typeCategory(type) === "other") {
        errors.push(
          `fileAccess: type "${type}" is the Drive-only "other" catch-all and cannot be granted to an installable app. Use fileAccessAll (Starkeep Drive only) for all-access.`,
        );
        continue;
      }
      impliedCategories.add(typeCategory(type));
    }

    if (entry.metadataWrite && entry.access === "readwrite") {
      warnings.push(
        `fileAccess[${entry.types.join(",")}]: metadataWrite is redundant when access is "readwrite"`,
      );
    }
  }

  // All-access is reserved to Starkeep Drive (the User-Data-Owner). It is the
  // only grant that reaches the `other` catch-all; installable apps enumerate
  // types instead.
  if (
    manifest.infraRequirements.fileAccessAll &&
    manifest.id !== FILE_ACCESS_ALL_APP_ID
  ) {
    errors.push(
      `infraRequirements.fileAccessAll may only be true for the "${FILE_ACCESS_ALL_APP_ID}" app (got "${manifest.id}")`,
    );
  }

  if (
    manifest.infraRequirements.compute.enabled &&
    manifest.infraRequirements.compute.handlers.length === 0
  ) {
    errors.push(
      "infraRequirements.compute.enabled is true but no handlers are declared",
    );
  }

  if (manifest.infraRequirements.brokerPower && manifest.id !== "cloud-data-server") {
    errors.push(
      `infraRequirements.brokerPower may only be true for the "cloud-data-server" app (got "${manifest.id}")`,
    );
  }

  // Label keys are the app's published schema, so a duplicate is a manifest
  // authoring mistake rather than something to silently dedup: the registry's
  // primary key is (app_id, key), so a second row would be dropped and the
  // second `description` — the one a reader of the cross-app registry sees —
  // would depend on insert order.
  const seenLabelKeys = new Set<string>();
  const sizeClassKeys: string[] = [];
  for (const entry of manifest.infraRequirements.labelKeys) {
    if (seenLabelKeys.has(entry.key)) {
      errors.push(`infraRequirements.labelKeys: duplicate key "${entry.key}"`);
    }
    seenLabelKeys.add(entry.key);
    if (entry.sizeClass) sizeClassKeys.push(entry.key);
  }

  // One ladder per app. A second key would leave the node choosing between two
  // answers to "which rung is this", and whichever it picked would decide the
  // record's budget row and whether it counts as re-derivable — so the ambiguity
  // is refused at install time rather than resolved by iteration order.
  if (sizeClassKeys.length > 1) {
    errors.push(
      `infraRequirements.labelKeys: at most one key may set sizeClass: true (got ${sizeClassKeys
        .map((k) => `"${k}"`)
        .join(", ")})`,
    );
  }

  // Writing a label needs only a `read` grant on the record's type (requiring
  // readwrite would force an OCR service or a classifier to hold destructive
  // power over photos it only ever reads). But an app with no type grants at
  // all can never satisfy that check, so declared keys it could never write
  // are a manifest mistake worth naming at install time rather than a 403 the
  // author debugs later.
  if (
    manifest.infraRequirements.labelKeys.length > 0 &&
    manifest.infraRequirements.fileAccess.length === 0 &&
    !manifest.infraRequirements.fileAccessAll
  ) {
    errors.push(
      "infraRequirements.labelKeys declares keys but the app has no fileAccess grants — " +
        "labelling a record requires at least a read grant on its type, so none of " +
        "these keys could ever be written",
    );
  }

  return {
    valid: errors.length === 0,
    manifest: errors.length === 0 ? manifest : null,
    errors,
    warnings,
    impliedCategories: [...impliedCategories],
  };
}

