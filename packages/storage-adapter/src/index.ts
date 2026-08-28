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
  StoredAvailability,
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
  loadVariantsForPage,
  loadVariantCandidatesForPage,
} from "./database/variant-queries.js";

export {
  loadMetadataForRecords,
  applyRecordMetadata,
  deleteRecordMetadata,
  type MetadataSubject,
} from "./database/metadata-sync.js";

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

export {
  applyRepairFloors,
  bucketsPeerIsMissing,
  buildBucketDigest,
  digestIsScoped,
  foldDigestScopes,
  mergeDigestBuckets,
  raiseInboundFloors,
  repairFloorsFor,
  scopeDigestBuckets,
  toDigestBuckets,
  totalRows,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
  type DigestDb,
} from "./database/digest-queries.js";

export {
  buildScanSinceForNode,
  collectSince,
  planNodeScans,
  type NodeScan,
  type SinceDb,
  type SincePage,
} from "./database/since-queries.js";

export {
  keyedWhereFor,
  requireKeyedWhere,
  rowToWireEntry,
  type KeyedRowEntry,
} from "./database/app-syncable-rows.js";

export type { RawDatabase, RawStatement } from "./database/raw-database.js";
export type { ObjectStorageAdapter } from "./object-storage/adapter.js";
export type {
  ByteRange,
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
  setHashFactory,
  type HashFactory,
  type IncrementalHash,
} from "./object-storage/stream-verify.js";

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
  FileUriTransferRefused,
} from "./errors.js";

export { MockDatabaseAdapter } from "./mock/mock-database-adapter.js";
export { MockObjectStorageAdapter } from "./mock/mock-object-storage-adapter.js";
