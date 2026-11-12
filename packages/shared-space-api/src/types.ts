import type { HLCClock } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { AppSyncableSkipReason, ChangeEvent, ChangeNotifier } from "@starkeep/sync-engine";
import type { ParsedQueryResult, QueryParams } from "./query/types.js";

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

export type ApiHandler = (request: ApiRequest, context: ApiContext) => Promise<ApiResponse>;

/**
 * What one row write did: how many rows it changed and, when none, why.
 * `skipped` is set exactly when `changes` is 0.
 */
export interface RowWriteResult {
  readonly changes: number;
  readonly skipped?: AppSyncableSkipReason;
}

/**
 * App-specific syncable data operations. Scoped to the calling app — the
 * `appId` is fixed at construction time by the harness so handlers cannot
 * accidentally touch another app's tables or files. Tables are referred to by
 * their manifest-declared short name (e.g. "captions"); the implementation
 * resolves them to `<appId>_syncable_<name>`. File `subKey`s are paths under
 * `apps/<appId>/syncable/`.
 */
export interface AppSpecificOperations {
  /**
   * Write a row. Without `ifAbsent` the write is an LWW upsert and revives a
   * deleted row. With it, any row holding the key, live or deleted, stops the
   * write, and the result names which one.
   */
  insertRow(
    table: string,
    row: Record<string, unknown>,
    options?: { readonly ifAbsent?: boolean },
  ): Promise<RowWriteResult>;
  /**
   * Patch one live row, named by its whole primary key. A deleted row counts
   * as no match. `ifUpdatedAt` patches only while the row still carries that
   * stamp.
   */
  updateRow(
    table: string,
    where: Record<string, unknown>,
    patch: Record<string, unknown>,
    options?: { readonly ifUpdatedAt?: string },
  ): Promise<RowWriteResult>;
  /**
   * Delete one live row, named by its whole primary key. Deleting a deleted
   * row writes nothing and reports `skipped: "deleted"`. `ifUpdatedAt`
   * deletes only while the row still carries that stamp.
   */
  deleteRow(
    table: string,
    where: Record<string, unknown>,
    options?: { readonly ifUpdatedAt?: string },
  ): Promise<RowWriteResult>;
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
    },
  ): Promise<{ key: string }>;
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
   * The app's live files, in sub-key order, read from the file index.
   *
   * `prefix` narrows the listing to sub-keys that start with it. `limit` and
   * `pageToken` page the way the table query does: the same default and cap,
   * and an opaque token from the previous page. Every entry names its file by
   * sub-key, the form every other file operation takes.
   */
  listFiles(opts?: {
    prefix?: string;
    limit?: string;
    pageToken?: string;
  }): Promise<AppFileListing>;
}

/** One app-private file, as `listFiles` reports it. */
export interface AppFileEntry {
  readonly subKey: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly originalFilename: string | null;
  /** When the file was registered, as an ISO 8601 UTC instant. */
  readonly createdAt: string;
}

/** One page of `listFiles`. */
export interface AppFileListing {
  readonly files: readonly AppFileEntry[];
  /** More files match than this page holds. */
  readonly truncated: boolean;
  /** Pass back as `pageToken` for the next page; null on the last page. */
  readonly pageToken: string | null;
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
