import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";

export const deleteImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/item",
  method: "DELETE",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const id = request.query?.["id"];
    if (!id) return { status: 400, body: { error: "id query parameter is required" } };

    const record = await context.databaseAdapter.get(id as StarkeepId);
    if (!record) return { status: 404, body: { error: "Image not found" } };

    await context.databaseAdapter.delete(id as StarkeepId);

    // Note: object storage files (original + thumbnail) are not deleted here.
    // Content-addressed storage means the same bytes may be referenced by other
    // records (e.g. a crop). Cleanup of unreferenced objects is a separate concern.

    return { status: 204, body: {} };
  },
};
