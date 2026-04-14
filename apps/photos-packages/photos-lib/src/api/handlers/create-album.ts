import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { createAlbumRecord, albumRecordToAppAlbum } from "../../data/album-record.js";
import type { AlbumFileContent } from "../../types/album.js";

interface CreateAlbumBody {
  name: string;
  description?: string;
}

export const createAlbumHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/albums",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<CreateAlbumBody> | undefined;
    if (!body?.name) return { status: 400, body: { error: "name is required" } };

    const content: AlbumFileContent = {
      name: body.name,
      description: body.description ?? "",
      coverImageId: null,
      orderedImageIds: [],
    };

    const { record } = await createAlbumRecord(
      content,
      context.clock,
      context.ownerId,
      context.objectStorageAdapter,
    );

    await context.databaseAdapter.put(record);

    const album = albumRecordToAppAlbum(record, content);
    return { status: 201, body: { album } };
  },
};
