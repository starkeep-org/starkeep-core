import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { assembleAppImage } from "../helpers/assemble-app-image.js";

export const getImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/item",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const id = request.query?.["id"];
    if (!id) return { status: 400, body: { error: "id query parameter is required" } };

    const record = await context.databaseAdapter.get(id as StarkeepId);
    if (!record) return { status: 404, body: { error: "Image not found" } };

    const image = await assembleAppImage(record, context.databaseAdapter);
    return { status: 200, body: { image } };
  },
};
