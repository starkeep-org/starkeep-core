import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { albumRecordToAppAlbum, loadPalFile } from "../../data/album-record";

export const getAlbumHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/albums/item",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const id = request.query?.["id"];
    if (!id) return { status: 400, body: { error: "id query parameter is required" } };

    const record = await context.databaseAdapter.get(id as StarkeepId);
    if (!record) return { status: 404, body: { error: "Album not found" } };

    const content = await loadPalFile(record, context.objectStorageAdapter);
    if (!content) return { status: 404, body: { error: "Album file not found" } };

    const album = albumRecordToAppAlbum(record, content);
    return { status: 200, body: { album } };
  },
};
