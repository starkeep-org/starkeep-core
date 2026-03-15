import type {
  SharedSpaceApi,
  SharedSpaceApiOptions,
  ApiRequest,
  ApiResponse,
  ApiContext,
} from "./types.js";
import { createApiRouter } from "./api-router.js";
import { RouteNotFoundError } from "./errors.js";

function parseRoutePath(fullPath: string): {
  namespace: string;
  version: string;
  path: string;
} | null {
  // Expected format: "@namespace/name:version/path/segments"
  const colonIndex = fullPath.indexOf(":");
  if (colonIndex === -1) return null;

  const namespace = fullPath.slice(0, colonIndex);
  const remainder = fullPath.slice(colonIndex + 1);
  const slashIndex = remainder.indexOf("/");

  if (slashIndex === -1) {
    return { namespace, version: remainder, path: "" };
  }

  const version = remainder.slice(0, slashIndex);
  const path = remainder.slice(slashIndex + 1);
  return { namespace, version, path };
}

export function createSharedSpaceApi(
  options: SharedSpaceApiOptions,
): SharedSpaceApi {
  const { databaseAdapter, objectStorageAdapter, clock, ownerId } = options;
  const router = createApiRouter();

  const context: ApiContext = {
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId,
  };

  return {
    router,

    async handleRequest(request: ApiRequest): Promise<ApiResponse> {
      const parsed = parseRoutePath(request.path);
      if (!parsed) {
        return {
          status: 400,
          body: { error: "Invalid route format. Expected: namespace:version/path" },
        };
      }

      const endpoint = router.resolve(
        parsed.namespace,
        parsed.version,
        parsed.path,
        request.method,
      );

      if (!endpoint) {
        throw new RouteNotFoundError(request.path, request.method);
      }

      try {
        return await endpoint.handler(request, context);
      } catch (error) {
        if (error instanceof Error) {
          return {
            status: 500,
            body: { error: error.message },
          };
        }
        return {
          status: 500,
          body: { error: "Internal server error" },
        };
      }
    },
  };
}
