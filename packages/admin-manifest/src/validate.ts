import type { AppManifest, TypeDefinition } from "./schema.js";
import { appManifestSchema } from "./schema.js";

export interface ValidationResult {
  valid: boolean;
  manifest: AppManifest | null;
  errors: string[];
  warnings: string[];
}

const RESERVED_PREFIX = "@starkeep/";

export function validateManifest(raw: unknown): ValidationResult {
  const result = appManifestSchema.safeParse(raw);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!result.success) {
    return {
      valid: false,
      manifest: null,
      errors: result.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
      warnings: [],
    };
  }

  const manifest = result.data;

  // Community apps cannot use the @starkeep/ prefix for their ID
  if (manifest.tier === "community" && manifest.id.startsWith(RESERVED_PREFIX)) {
    errors.push(
      `Community apps cannot use the "${RESERVED_PREFIX}" ID prefix`,
    );
  }

  // Community apps cannot register types with @starkeep/ prefix
  for (const td of manifest.typeDefinitions) {
    if (
      manifest.tier === "community" &&
      td.typeId.startsWith(RESERVED_PREFIX)
    ) {
      errors.push(
        `Community apps cannot register types with the "${RESERVED_PREFIX}" prefix: ${td.typeId}`,
      );
    }
  }

  // Warn about optional permissions for types not defined in this manifest
  const definedTypeIds = new Set(manifest.typeDefinitions.map((t) => t.typeId));
  for (const perm of manifest.optionalPermissions) {
    if (!definedTypeIds.has(perm.resourceId)) {
      warnings.push(
        `Optional permission references type "${perm.resourceId}" not defined in this manifest — it must already be registered`,
      );
    }
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
  existingSchemaVersion: string;
  newSchemaVersion: string;
  reason: string;
}

export function checkTypeConflicts(
  newTypes: TypeDefinition[],
  existingTypes: { typeId: string; schemaVersion: string }[],
): TypeConflict[] {
  const existingMap = new Map(
    existingTypes.map((t) => [t.typeId, t]),
  );

  const conflicts: TypeConflict[] = [];
  for (const newType of newTypes) {
    const existing = existingMap.get(newType.typeId);
    if (!existing) continue;

    // Same schema version = compatible, no conflict
    if (existing.schemaVersion === newType.schemaVersion) continue;

    conflicts.push({
      typeId: newType.typeId,
      existingSchemaVersion: existing.schemaVersion,
      newSchemaVersion: newType.schemaVersion,
      reason: `Type "${newType.typeId}" already registered at version ${existing.schemaVersion}, manifest declares version ${newType.schemaVersion}`,
    });
  }

  return conflicts;
}
