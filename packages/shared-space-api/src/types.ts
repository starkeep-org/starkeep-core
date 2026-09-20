import type { HLCClock } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { ChangeEvent, ChangeNotifier } from "@starkeep/sync-engine";
import type { ParsedQueryResult, QueryParams } from "./query/types.js";
import type {
  AppBlobDropResult,
  AppBlobFetchResult,
  AppBlobEntry,
  AppBlobResidencyPage,
} from "./app-syncable/blob-plane.js";

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

/**
 * App-specific syncable data operations. Scoped to the calling app — the
 * `appId` is fixed at construction time by the harness so handlers cannot
 * accidentally touch another app's tables or files. Tables are referred to by
 * their manifest-declared short name (e.g. "captions"); the implementation
 * resolves them to `<appId>_syncable_<name>`. File `subKey`s are paths under
 * `apps/<appId>/syncable/`.
 */
export interface AppSpecificOperations {
  insertRow(table: string, row: Record<string, unknown>): Promise<void>;
  updateRow(
    table: string,
    where: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<number>;
  deleteRow(table: string, where: Record<string, unknown>): Promise<number>;
  /**
   * Ask a question of one of the app's own tables.
   *
   * `params` are the request's raw query parameters; the implementation parses
   * them against the table's registered columns and answers rows or aggregate
   * groups. Everything a caller may express lives in the grammar — see
   * `query/parse.ts` — and everything a caller may *not* express is ANDed in
   * here: the soft-delete predicate always, and the app's own namespace via
   * `resolveTable`.
   *
   * Replaced `queryRows(table, where?)`, which offered equality filters over
   * `SELECT *` and nothing else: no projection, no comparison, no ordering, no
   * limit and no cursor. Apps were reimplementing all five in the browser over
   * full-table downloads.
   */
  query(table: string, params: QueryParams): Promise<ParsedQueryResult>;

  /**
   * Record the index row for a file whose bytes were uploaded out-of-band
   * (the direct-to-S3 presign flow), without the server holding the bytes.
   * This is the only write path for the app-data file plane.
   */
  registerFile(
    subKey: string,
    meta: {
      contentHash: string;
      mimeType: string;
      sizeBytes: number;
      originalFilename?: string | null;
      localMetadata?: Record<string, unknown>;
    },
  ): Promise<{ key: string }>;
  localFiles?(cursor?: string | null, prefix?: string): Promise<{ files: Array<{ subKey: string; metadata: Record<string, unknown> }>; nextCursor: string | null }>;
  getFile(subKey: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  /**
   * Existence + metadata from the index row alone — no S3 call, no byte
   * download. Returns null when no live file exists at `subKey`.
   */
  statFile(
    subKey: string,
  ): Promise<{ mimeType: string; sizeBytes: number; contentHash: string } | null>;
  deleteFile(subKey: string): Promise<void>;
  fileUrl(subKey: string, opts?: { expiresIn?: number }): Promise<string | null>;

  /**
   * What this node is holding of the app's private plane, and against what
   * ceiling.
   *
   * The app's own accounting, because the platform stopped doing it: an app
   * namespace carries one advisory budget and the eviction pass does not run
   * over it. An overrun is reported here and the app decides what to give up.
   */
  blobResidency(cursor?: string | null): Promise<AppBlobResidencyPage>;
  /**
   * The same answer for blobs the caller can already name.
   *
   * A read path resolving a page of records knows exactly which sub-keys it is
   * about to paint and needs one fact about each: are the bytes here. Paging
   * the whole plane to find out is O(everything the app holds) for a question
   * whose answer is O(the page).
   *
   * Sub-keys with no live row are omitted, so absence from the result is
   * absence of the file.
   */
  blobResidencyOf(subKeys: readonly string[]): Promise<readonly AppBlobEntry[]>;
  /**
   * Note that the app opened one of its own blobs, so the order it gives them
   * up in reflects use rather than age.
   */
  touchBlob(subKey: string): Promise<void>;
  /**
   * Let the bytes go and keep the file.
   *
   * What {@link deleteFile} cannot express: a delete tombstones the row and the
   * tombstone travels, so an app reclaiming disk on one machine would lose the
   * file on every machine. This drops the bytes here, leaves the row alone, and
   * writes nothing a peer will ever see.
   *
   * Refused where the bytes would be the last copy and the app has not declared
   * its private blobs re-derivable.
   */
  dropBlob(subKey: string): Promise<AppBlobDropResult>;
  /** Bring the bytes back from a peer for a file row whose blob is not here. */
  fetchBlob(subKey: string): Promise<AppBlobFetchResult>;
}

export interface ApiContext {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly clock: HLCClock;
  /**
   * Scoped row CRUD + file ops against the calling app's app-specific
   * syncable namespace. `null` when the request subject is not an installed
   * app (e.g. local-only admin requests).
   */
  readonly appSpecific: AppSpecificOperations | null;
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
  /** When provided, change events are forwarded to all connected WebSocket clients. */
  readonly changeNotifier?: ChangeNotifier;
  /**
   * Builds the app-scoped `appSpecific` view exposed on the ApiContext for a
   * given request's subject. Wired in by the harness (local-data-server)
   * since this package has no knowledge of the app registry.
   */
  readonly getAppSpecific?: (subject: ApiSubject) => AppSpecificOperations | null;
}

export type { ChangeEvent, ChangeNotifier };
