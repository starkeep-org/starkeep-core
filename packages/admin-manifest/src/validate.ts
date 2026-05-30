import type { AppManifest } from "./schema.js";
import { appManifestSchema } from "./schema.js";
import { KNOWN_EXTENSIONS, categoryOf } from "@starkeep/core";

export interface ValidationResult {
  valid: boolean;
  manifest: AppManifest | null;
  errors: string[];
  warnings: string[];
  /** Distinct categories implied by the manifest's declared extensions. */
  impliedCategories: string[];
}

const RESERVED_PREFIX = "@starkeep/";

// The set of platform-known extensions an installable app may declare. Apps
// cannot register new types; adding an extension requires editing
// @starkeep/core's core-types.ts. Re-exported for callers that want the set.
export { KNOWN_EXTENSIONS };

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
    for (const ext of entry.extensions) {
      if (!KNOWN_EXTENSIONS.has(ext)) {
        errors.push(
          `fileAccess: extension "${ext}" is not in the platform extension map. Apps may only declare known, mapped extensions; unmapped files belong to the Drive-only "other" category.`,
        );
        continue;
      }
      impliedCategories.add(categoryOf(ext));
    }

    if (entry.metadataWrite && entry.access === "readwrite") {
      warnings.push(
        `fileAccess[${entry.extensions.join(",")}]: metadataWrite is redundant when access is "readwrite"`,
      );
    }
  }

  // All-access is reserved to Starkeep Drive (the User-Data-Owner). It is the
  // only grant that reaches the `other` catch-all; installable apps enumerate
  // extensions instead.
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

  return {
    valid: errors.length === 0,
    manifest: errors.length === 0 ? manifest : null,
    errors,
    warnings,
    impliedCategories: [...impliedCategories],
  };
}

export interface TypeConflict {
  typeId: string;
  reason: string;
}

// Apps no longer define shared types — all types are declared in core system code.
// This function is kept for API compatibility but always returns an empty array.
export function checkTypeConflicts(): TypeConflict[] {
  return [];
}
