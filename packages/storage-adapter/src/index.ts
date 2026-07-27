export type { DatabaseAdapter } from "./database/adapter.js";
export type {
  Query,
  QueryResult,
  Filter,
  SortField,
  SortDirection,
  BatchOperation,
  Transaction,
  LabelUpsert,
  LabelRetraction,
  FindByLabelQuery,
  FindByLabelResult,
} from "./database/types.js";

export {
  encodeLabelCursor,
  decodeLabelCursor,
  encodeLabelScanCursor,
  decodeLabelScanCursor,
  compareLabelOrder,
  compareLabelScanOrder,
  isAfterLabelCursor,
  isAfterLabelScanCursor,
  type LabelCursor,
  type LabelScanCursor,
} from "./database/label-cursor.js";

export { rowToLabel, labelToRow, type LabelRow } from "./database/label-row.js";

export {
  buildLabelUpsert,
  buildLabelSnapshotUpsert,
  buildLabelRetraction,
  buildTombstoneLabelsForRecord,
  buildLabelsByRecordIds,
  buildGetLabel,
  buildFindByLabel,
  buildQueryLabels,
  buildLabelNodeWatermarks,
  paginateFindByLabel,
  paginateLabelScan,
  groupLabelsByRecordId,
  DEFAULT_FIND_LIMIT,
  DEFAULT_SCAN_LIMIT,
  type LabelDb,
  type LabelDialect,
} from "./database/label-queries.js";

export type { ObjectStorageAdapter } from "./object-storage/adapter.js";
export type {
  PutOptions,
  GetResult,
  ListOptions,
  ListResult,
  SignedUrlOptions,
  SignedPutUrlOptions,
} from "./object-storage/types.js";

export {
  StorageError,
  ConnectionError,
  TransactionError,
  ObjectNotFoundError,
} from "./errors.js";

export { MockDatabaseAdapter } from "./mock/mock-database-adapter.js";
export { MockObjectStorageAdapter } from "./mock/mock-object-storage-adapter.js";
