import type { AppManifest } from "./schema.js";
import { appManifestSchema } from "./schema.js";

export interface ValidationResult {
  valid: boolean;
  manifest: AppManifest | null;
  errors: string[];
  warnings: string[];
}

const RESERVED_PREFIX = "@starkeep/";

// Core shared-type registry — fixed at the core system version.
// Apps cannot register new types; adding a type requires a core version bump + DDL migration.
export const CORE_TYPE_REGISTRY = new Set(["image", "markdown"]);

// Types that cannot appear directly in sharedTypeAccess.
// Access is gated via canIngestUnknown / canPromoteFromUnknown instead.
const BUILTIN_RESTRICTED_TYPES = new Set(["unknown"]);

export function validateManifest(raw: unknown): ValidationResult {
  const result = appManifestSchema.safeParse(raw);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!result.success) {
    return {
      valid: false,
      manifest: null,
      errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      warnings: [],
    };
  }

  const manifest = result.data;

  if (manifest.tier === "community" && manifest.id.startsWith(RESERVED_PREFIX)) {
    errors.push(`Community apps cannot use the "${RESERVED_PREFIX}" ID prefix`);
  }

  for (const entry of manifest.infraRequirements.sharedTypeAccess) {
    if (BUILTIN_RESTRICTED_TYPES.has(entry.typeId)) {
      errors.push(
        `sharedTypeAccess: typeId "${entry.typeId}" is restricted. Use canIngestUnknown or canPromoteFromUnknown instead.`,
      );
      continue;
    }

    // Wildcard is valid — installer expands it, always excluding "unknown"
    if (entry.typeId === "*") continue;

    if (!CORE_TYPE_REGISTRY.has(entry.typeId)) {
      errors.push(
        `sharedTypeAccess: typeId "${entry.typeId}" is not in the core type registry. Valid types: ${[...CORE_TYPE_REGISTRY].join(", ")}`,
      );
    }

    if (entry.metadataWrite && entry.access === "readwrite") {
      warnings.push(
        `sharedTypeAccess[${entry.typeId}]: metadataWrite is redundant when access is "readwrite"`,
      );
    }
  }

  if (
    manifest.infraRequirements.appPrivate.compute.enabled &&
    manifest.infraRequirements.appPrivate.compute.handlers.length === 0
  ) {
    errors.push(
      "infraRequirements.appPrivate.compute.enabled is true but no handlers are declared",
    );
  }

  if (manifest.infraRequirements.appPrivate.brokerPower && manifest.id !== "data-server") {
    errors.push(
      `infraRequirements.appPrivate.brokerPower may only be true for the "data-server" app (got "${manifest.id}")`,
    );
  }

  return {
    valid: errors.length === 0,
    manifest: errors.length === 0 ? manifest : null,
    errors,
    warnings,
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
