import type { AppManifest } from "./schema.js";
import { appManifestSchema } from "./schema.js";
import {
  WILDCARD_EXPANDABLE_TYPE_IDS,
  RESTRICTED_CORE_TYPE_IDS,
} from "@starkeep/core";

export interface ValidationResult {
  valid: boolean;
  manifest: AppManifest | null;
  errors: string[];
  warnings: string[];
}

const RESERVED_PREFIX = "@starkeep/";

// Core shared-type registry — derived from @starkeep/core's CORE_TYPES.
// Apps cannot register new types; adding a type requires editing core-types.ts.
// Restricted types (e.g. "unknown") are excluded — access is gated via
// canIngestUnknown / canPromoteFromUnknown instead.
export const CORE_TYPE_REGISTRY = new Set(WILDCARD_EXPANDABLE_TYPE_IDS);

const BUILTIN_RESTRICTED_TYPES = new Set(RESTRICTED_CORE_TYPE_IDS);

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

  // The shared.access_grants schema represents (app_id, type_id) → single
  // access mode. An app declaring both canIngestUnknown (writeable unknown)
  // and canPromoteFromUnknown (readable unknown) would collapse to one row
  // during install DDL — whichever block runs second silently wins. If/when
  // both modes are needed by a single app, the access_grants schema must
  // grow to represent the combination explicitly.
  if (
    manifest.infraRequirements.canIngestUnknown &&
    manifest.infraRequirements.canPromoteFromUnknown
  ) {
    errors.push(
      "infraRequirements: canIngestUnknown and canPromoteFromUnknown cannot both be true on the same app — the shared.access_grants schema cannot represent a single app holding both ingest (write) and promote (read) access to the `unknown` holding pen.",
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
