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
  LabelValueReplacement,
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

export { loadVariantsForPage } from "./database/variant-queries.js";

export {
  buildLabelUpsert,
  buildLabelSnapshotUpsert,
  buildLabelRetraction,
  buildLabelValueReplacementTombstone,
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
  PutStreamOptions,
  GetResult,
  ListOptions,
  ListResult,
  SignedUrlOptions,
  SignedPutUrlOptions,
  ObjectFacts,
  ObjectAvailability,
} from "./object-storage/types.js";

export { sha256HexToBase64, sha256Base64ToHex } from "./object-storage/checksum.js";

export {
  verifyingStream,
  collectStream,
  streamFromBytes,
  ChecksumMismatchError,
} from "./object-storage/stream-verify.js";

export {
  StorageError,
  ConnectionError,
  TransactionError,
  ObjectNotFoundError,
} from "./errors.js";

export { MockDatabaseAdapter } from "./mock/mock-database-adapter.js";
export { MockObjectStorageAdapter } from "./mock/mock-object-storage-adapter.js";
