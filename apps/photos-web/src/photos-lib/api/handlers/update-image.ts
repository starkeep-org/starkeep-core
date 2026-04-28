import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { USER_AUTHORED_GENERATOR_ID } from "../../metadata/user-authored-generator";
import { IMAGE_RECORD_TYPE } from "../../manifest";
import { assembleAppImage } from "../helpers/assemble-app-image";

interface UpdateBody {
  id: string;
  caption?: string;
  title?: string;
  dateTakenOverride?: string | null;
}

/**
 * Updates user-authored metadata (caption, title, dateTakenOverride) for an image.
 * Merges the provided fields with existing values — unspecified fields are preserved.
 */
export const updateImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/item",
  method: "PATCH",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<UpdateBody> | undefined;
    if (!body?.id) return { status: 400, body: { error: "id is required" } };

    const record = await context.databaseAdapter.get(body.id as StarkeepId);
    if (!record) return { status: 404, body: { error: "Image not found" } };

    // Read existing user-authored metadata to merge
    const existing = await context.databaseAdapter.queryMetadata(IMAGE_RECORD_TYPE, {
      targetId: record.id,
      generatorId: USER_AUTHORED_GENERATOR_ID,
    });
    const existingValue = (existing.entries[0]?.value ?? {}) as {
      caption?: string;
      title?: string;
      dateTakenOverride?: string | null;
    };

    const merged = {
      caption: body.caption !== undefined ? body.caption : (existingValue.caption ?? ""),
      title: body.title !== undefined ? body.title : (existingValue.title ?? ""),
      dateTakenOverride:
        body.dateTakenOverride !== undefined
          ? body.dateTakenOverride
          : (existingValue.dateTakenOverride ?? null),
    };

    await context.databaseAdapter.upsertSyncableMetadata({
      targetId: record.id,
      targetType: IMAGE_RECORD_TYPE,
      generatorId: USER_AUTHORED_GENERATOR_ID,
      generatorVersion: 1,
      updatedAt: context.clock.now(),
      inputHash: "",
      value: merged,
    });

    const image = await assembleAppImage(record, context.databaseAdapter);
    return { status: 200, body: { image } };
  },
};
