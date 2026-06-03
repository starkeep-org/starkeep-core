export type {
  ApiEndpointDefinition,
  ApiRequest,
  ApiResponse,
  ApiSubject,
  ApiHandler,
  ApiContext,
  ApiRouter,
  AppSpecificOperations,
  SharedSpaceApi,
  SharedSpaceApiOptions,
  WebSocketConnection,
  ChangeEvent,
  ChangeNotifier,
} from "./types.js";

export { createApiRouter } from "./api-router.js";
export { createSharedSpaceApi } from "./shared-space-api.js";
export { parseQueryParams, type ParsedQueryParams } from "./helpers/query-params.js";
export {
  formatPaginatedResponse,
  type PaginatedApiResponse,
} from "./helpers/pagination.js";
export { ApiError, RouteNotFoundError, MethodNotAllowedError } from "./errors.js";

export type {
  AppSyncableTableInfo,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  ScanCapableApplier,
  ScanSinceOptions,
  ScanSincePage,
  AppSyncableRowEntry,
  FileRecordRow,
} from "./app-syncable/types.js";
export {
  createAppSpecificFactory,
  type AppSpecificFactoryOptions,
} from "./app-syncable/factory.js";
export { quoteIdent, validateTableName, RESERVED_COLUMN_NAMES } from "./app-syncable/validation.js";
export {
  FILE_RECORDS_TABLE,
  FILE_RECORDS_TABLE_INFO,
  FILE_RECORDS_COLUMNS,
  RESERVED_TABLE_NAMES,
  withFileRecordsTable,
  type FileRecordsTableColumn,
} from "./app-syncable/reserved.js";
