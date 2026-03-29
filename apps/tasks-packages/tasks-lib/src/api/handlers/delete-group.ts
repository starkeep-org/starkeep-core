import type { ApiEndpointDefinition, ApiRequest, ApiContext } from "@starkeep/shared-space-api";
import type { StarkeepId } from "@starkeep/core";

export const deleteGroupHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "groups/item",
  method: "DELETE",
  handler: async (request: ApiRequest, context: ApiContext) => {
    const query = request.query ?? {};
    const id = query["id"];

    if (!id) {
      return { status: 400, body: { error: "id query parameter is required" } };
    }

    const record = await context.databaseAdapter.get(id as StarkeepId);
    if (!record) {
      return { status: 404, body: { error: "Group not found" } };
    }

    await context.databaseAdapter.delete(id as StarkeepId);

    return { status: 200, body: { success: true } };
  },
};
