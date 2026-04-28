import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { IMAGE_RECORD_TYPE } from "../../manifest";
import { THUMBNAIL_GENERATOR_ID } from "../../metadata/thumbnail-generator";

export const getThumbnailHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/thumbnail",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const id = request.query?.["id"];
    if (!id) return { status: 400, body: { error: "id query parameter is required" } };

    const record = await context.databaseAdapter.get(id as StarkeepId);
    if (!record) return { status: 404, body: { error: "Image not found" } };

    // Look up the thumbnail key from metadata
    const metaResult = await context.databaseAdapter.queryMetadata(IMAGE_RECORD_TYPE, {
      targetId: record.id,
      generatorId: THUMBNAIL_GENERATOR_ID,
    });

    const thumbValue = (metaResult.entries[0]?.value ?? {}) as {
      thumbnailKey?: string | null;
    };
    const thumbnailKey = thumbValue.thumbnailKey ?? `images/thumbnails/${id}`;

    const storageResult = await context.objectStorageAdapter.get(thumbnailKey);
    if (!storageResult) {
      return { status: 404, body: { error: "Thumbnail not yet generated" } };
    }

    const bytes =
      storageResult.data instanceof Uint8Array
        ? storageResult.data
        : new Uint8Array(storageResult.data as ArrayBuffer);

    return {
      status: 200,
      body: { thumbnailBase64: bytesToBase64(bytes), contentType: "image/jpeg" },
    };
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
