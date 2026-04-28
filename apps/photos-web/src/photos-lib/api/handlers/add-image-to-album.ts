import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { loadPalFile, writePalFile } from "../../data/album-record";
import type { AlbumFileContent } from "../../types/album";

interface AddImageBody {
  albumId: string;
  imageId: string;
}

export const addImageToAlbumHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/albums/add-image",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<AddImageBody> | undefined;
    if (!body?.albumId) return { status: 400, body: { error: "albumId is required" } };
    if (!body.imageId) return { status: 400, body: { error: "imageId is required" } };

    const albumRecord = await context.databaseAdapter.get(body.albumId as StarkeepId);
    if (!albumRecord) return { status: 404, body: { error: "Album not found" } };

    const imageRecord = await context.databaseAdapter.get(body.imageId as StarkeepId);
    if (!imageRecord) return { status: 404, body: { error: "Image not found" } };

    const content = await loadPalFile(albumRecord, context.objectStorageAdapter);
    if (!content) return { status: 404, body: { error: "Album file not found" } };

    if (content.orderedImageIds.includes(body.imageId)) {
      return { status: 200, body: { message: "Image already in album" } };
    }

    const newContent: AlbumFileContent = {
      ...content,
      orderedImageIds: [...content.orderedImageIds, body.imageId],
    };

    const { updatedRecord } = await writePalFile(
      albumRecord,
      newContent,
      context.objectStorageAdapter,
      context.clock,
    );

    await context.databaseAdapter.put(updatedRecord);

    return { status: 200, body: { message: "Image added to album" } };
  },
};
