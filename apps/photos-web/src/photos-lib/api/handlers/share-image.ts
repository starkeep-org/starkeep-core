import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";
import { createAccessControlEngine } from "@starkeep/access-control";

interface ShareBody {
  imageId: string;
}

export const shareImageHandler: ApiEndpointDefinition = {
  namespace: "photos",
  version: "v1",
  path: "photos/share",
  method: "POST",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const body = request.body as Partial<ShareBody> | undefined;
    if (!body?.imageId) return { status: 400, body: { error: "imageId is required" } };

    const record = await context.databaseAdapter.get(body.imageId as StarkeepId);
    if (!record) return { status: 404, body: { error: "Image not found" } };

    const acEngine = createAccessControlEngine({
      databaseAdapter: context.databaseAdapter,
      clock: context.clock,
      ownerId: context.ownerId,
    });
    await acEngine.loadPolicies();

    const policy = await acEngine.createPolicy({
      subjectType: "token",
      subjectId: "*",
      resourceType: "item",
      resourceId: body.imageId,
      permissions: ["read"],
    });

    const { token } = await acEngine.createSharingToken(policy.policyId);

    return {
      status: 201,
      body: { token, shareUrl: `/shared/${token}` },
    };
  },
};
