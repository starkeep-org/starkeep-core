import type { ApiRouter, ApiEndpointDefinition } from "./types.js";
import { ApiError } from "./errors.js";

function buildRouteKey(
  namespace: string,
  version: string,
  path: string,
  method: string,
): string {
  return `${method.toUpperCase()}:${namespace}:${version}/${path}`;
}

export function createApiRouter(): ApiRouter {
  const endpoints = new Map<string, ApiEndpointDefinition>();

  return {
    register(endpoint: ApiEndpointDefinition): void {
      const key = buildRouteKey(
        endpoint.namespace,
        endpoint.version,
        endpoint.path,
        endpoint.method,
      );
      if (endpoints.has(key)) {
        throw new ApiError(`Endpoint already registered: ${key}`, 409);
      }
      endpoints.set(key, endpoint);
    },

    resolve(
      namespace: string,
      version: string,
      path: string,
      method: string,
    ): ApiEndpointDefinition | undefined {
      const key = buildRouteKey(namespace, version, path, method);
      return endpoints.get(key);
    },

    listEndpoints(): ApiEndpointDefinition[] {
      return Array.from(endpoints.values());
    },
  };
}
