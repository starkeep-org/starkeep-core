import type { StarkeepSdk } from "@starkeep/sdk";
import { PHOTOS_APP_ID, PHOTOS_APP_RECORD_TYPES, IMAGE_RECORD_TYPE, ALBUM_RECORD_TYPE } from "./manifest.js";

const TYPE_REGISTRATION_RECORD_TYPE = "@starkeep/type-registration";

const IMAGE_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
  description:
    "A raw raster image file. The image bytes live in object storage; the records table entry carries only indexing fields.",
};

const ALBUM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Display name for the album" },
  },
  required: ["name"],
  additionalProperties: false,
};

/**
 * Idempotent bootstrap for the photos app.
 * Must be called with an owner-level SDK (no `subject`) before initialising
 * the app-scoped SDK.
 *
 * 1. Registers global types in the type registry (if not already present).
 * 2. Grants the photos app type-level read/write/delete policies for all
 *    record types it needs to read or write.
 */
export async function bootstrapPhotosAppPolicies(ownerSdk: StarkeepSdk): Promise<void> {
  // --- 1. Type registration ---
  for (const [typeId, schema, description] of [
    [IMAGE_RECORD_TYPE, IMAGE_SCHEMA, "A raw raster image file stored in object storage."] as const,
    [ALBUM_RECORD_TYPE, ALBUM_SCHEMA, "An ordered collection of images. Full album data is in a .pal file in object storage; the records table carries the name for listing."] as const,
  ]) {
    const existing = await ownerSdk.data.query({
      type: TYPE_REGISTRATION_RECORD_TYPE,
      filters: [{ field: "content.typeId", operator: "eq", value: typeId }],
    });

    if (existing.length === 0) {
      await ownerSdk.data.put({
        type: TYPE_REGISTRATION_RECORD_TYPE,
        ownerId: "owner",
        content: {
          typeId,
          schema,
          schemaVersion: "1.0.0",
          description,
          registeredByAppId: PHOTOS_APP_ID,
        },
      });
    }
  }

  // --- 2. Access policies ---
  const existing = await ownerSdk.accessControl.listPolicies({ subjectId: PHOTOS_APP_ID });
  const coveredTypes = new Set(
    existing.filter((p) => p.resourceType === "type").map((p) => p.resourceId),
  );

  for (const recordType of PHOTOS_APP_RECORD_TYPES) {
    if (coveredTypes.has(recordType)) continue;

    await ownerSdk.accessControl.createPolicy({
      subjectType: "app",
      subjectId: PHOTOS_APP_ID,
      resourceType: "type",
      resourceId: recordType,
      permissions: ["read", "write", "delete"],
    });
  }
}
