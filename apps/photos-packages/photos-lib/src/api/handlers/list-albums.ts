import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { serializeHLC } from "@starkeep/core";
import { ALBUM_RECORD_TYPE } from "../../manifest.js";
import type { AppAlbum } from "../../types/album.js";

export const listAlbumsHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/albums/list",
  method: "GET",
  handler: async (_request: ApiRequest, context: ApiContext) => {
    const result = await context.databaseAdapter.query({ type: ALBUM_RECORD_TYPE });

    const albums: AppAlbum[] = result.records.map((record) => ({
      id: record.id,
      name: (record.content["name"] as string) ?? "",
      description: "",
      coverImageId: null,
      orderedImageIds: [],
      createdAt: serializeHLC(record.createdAt),
      updatedAt: serializeHLC(record.updatedAt),
    }));

    return { status: 200, body: { albums } };
  },
};
