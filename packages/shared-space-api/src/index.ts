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

export { parseAppSyncableTables } from "@starkeep/sync-engine";

export type {
  AppSyncableColumnInfo,
  AppSyncableTableInfo,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  ScanCapableApplier,
  ScanSincePage,
  StreamTruncation,
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
export {
  SYSTEM_COLUMNS,
  SYSTEM_COLUMN_NAMES,
  SOFT_DELETE_COLUMN,
  appSyncableTableInfo,
  syncableIndexName,
  type DeclaredColumn,
} from "./app-syncable/columns.js";
export * from "./query/index.js";
export {
  planStandInWrite,
  planOriginalFidelity,
  planFidelityReport,
  reconcileReportedFidelity,
  recordOriginalFidelity,
  standInExists,
  liveStandIn,
  type StandInWritePlan,
  type StandInWriteRequest,
  type StandInWriteError,
} from "./stand-ins/write.js";
export {
  renderStandInSummary,
  resolveContentRead,
  parseSizeParam,
  type WireStandInSummary,
  type WireStandInSize,
  type ContentReadOutcome,
} from "./stand-ins/read.js";
export {
  planRecordDelete,
  applyRecordDelete,
  keepCanonicalOfArchivedOriginal,
  type DeletePlan,
} from "./stand-ins/delete.js";
export {
  evaluateArchiving,
  applyArchiveEvaluation,
  archiveTriggersFor,
  ARCHIVE_TAGS,
  type ArchiveEvaluation,
  type ArchiveAction,
  type ArchiveTrigger,
} from "./stand-ins/archiving.js";
export {
  pageBacklog,
  countBacklog,
  readableStandInTypes,
  BACKLOG_KINDS,
  type BacklogKind,
  type BacklogPage,
  type BacklogCount,
} from "./stand-ins/backlog.js";
