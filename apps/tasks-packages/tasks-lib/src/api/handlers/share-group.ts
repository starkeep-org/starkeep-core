import type { ApiEndpointDefinition } from "@starkeep/shared-space-api";

export const shareGroupHandler: ApiEndpointDefinition = {
  namespace: "tasks",
  version: "v1",
  path: "groups/share",
  method: "POST",
  handler: async () => ({ status: 501, body: { error: "Not implemented" } }),
};
