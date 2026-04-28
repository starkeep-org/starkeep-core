import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";

export const deleteAlbumHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/albums/item",
  method: "DELETE",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const id = request.query?.["id"];
    if (!id) return { status: 400, body: { error: "id query parameter is required" } };

    const record = await context.databaseAdapter.get(id as StarkeepId);
    if (!record) return { status: 404, body: { error: "Album not found" } };

    await context.databaseAdapter.delete(id as StarkeepId);

    return { status: 204, body: {} };
  },
};
