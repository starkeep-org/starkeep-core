import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { createAccessControlEngine } from "@starkeep/access-control";
import { assembleAppImage } from "../helpers/assemble-app-image.js";

export const getSharedImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/shared",
  method: "GET",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const token = request.query?.["token"];
    if (!token) return { status: 400, body: { error: "token query parameter is required" } };

    const acEngine = createAccessControlEngine({
      databaseAdapter: context.databaseAdapter,
      clock: context.clock,
      ownerId: context.ownerId,
    });
    await acEngine.loadPolicies();

    const policy = await acEngine.validateSharingToken(token);
    if (!policy) {
      return { status: 401, body: { error: "Invalid or expired sharing token" } };
    }

    if (!policy.permissions.includes("read")) {
      return { status: 403, body: { error: "Token does not grant read access" } };
    }

    const imageId = policy.resourceId as StarkeepId;
    const record = await context.databaseAdapter.get(imageId);
    if (!record) return { status: 404, body: { error: "Image not found" } };

    const image = await assembleAppImage(record, context.databaseAdapter);
    return { status: 200, body: { image } };
  },
};
