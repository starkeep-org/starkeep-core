import type { HLCClock } from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { ChangeEvent, ChangeNotifier } from "@starkeep/sync-engine";

export interface ApiEndpointDefinition {
  readonly namespace: string;
  readonly version: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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

/** Platform-agnostic representation of a single connected WebSocket client. */
export interface WebSocketConnection {
  readonly connectionId: string;
  send(event: ChangeEvent): void | Promise<void>;
}

export interface SharedSpaceApi {
  readonly router: ApiRouter;
  handleRequest(request: ApiRequest): Promise<ApiResponse>;
  /**
   * Register a connected WebSocket client. Returns an unsubscribe function that
   * must be called when the connection closes.
   */
  handleWebSocketConnect(connection: WebSocketConnection): () => void;
}

export interface SharedSpaceApiOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly clock: HLCClock;
  readonly ownerId: string;
  /** When provided, change events are forwarded to all connected WebSocket clients. */
  readonly changeNotifier?: ChangeNotifier;
}

export type { ChangeEvent, ChangeNotifier };
