import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import { IMAGE_RECORD_TYPE } from "../../manifest";
import { assembleAppImages } from "../helpers/assemble-app-image";

export const listImagesHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/list",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const query = request.query ?? {};
    const limit = query["limit"] ? parseInt(query["limit"], 10) : 100;
    const cursor = query["cursor"];

    const queryResult = await context.databaseAdapter.query({
      type: IMAGE_RECORD_TYPE,
      limit,
      cursor,
    });

    const images = await assembleAppImages(queryResult.records, context.databaseAdapter);

    // Sort by effectiveDateTaken descending
    images.sort((a, b) => b.effectiveDateTaken.localeCompare(a.effectiveDateTaken));

    return {
      status: 200,
      body: { images, nextCursor: queryResult.nextCursor },
    };
  },
};
