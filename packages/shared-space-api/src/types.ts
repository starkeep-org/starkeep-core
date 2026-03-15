import type { HLCClock } from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";

export interface ApiEndpointDefinition {
  readonly namespace: string;
  readonly version: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly handler: ApiHandler;
  readonly description?: string;
}

export interface ApiRequest {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  readonly query?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly subject: ApiSubject;
}

export interface ApiSubject {
  readonly subjectType: string;
  readonly subjectId: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export type ApiHandler = (
  request: ApiRequest,
  context: ApiContext,
) => Promise<ApiResponse>;

export interface ApiContext {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly clock: HLCClock;
  readonly ownerId: string;
}

export interface ApiRouter {
  register(endpoint: ApiEndpointDefinition): void;
  resolve(
    namespace: string,
    version: string,
    path: string,
    method: string,
  ): ApiEndpointDefinition | undefined;
  listEndpoints(): ApiEndpointDefinition[];
}

export interface SharedSpaceApi {
  readonly router: ApiRouter;
  handleRequest(request: ApiRequest): Promise<ApiResponse>;
}

export interface SharedSpaceApiOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly clock: HLCClock;
  readonly ownerId: string;
}
