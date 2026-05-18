/**
 * Single source of truth for Starkeep's shared core types.
 *
 * Every relevant system — manifest validation, IAM emission, DSQL schema-init,
 * SQLite bootstrap, and the local data-server's payload registry — derives its
 * view of the type set from CORE_TYPES below. Local and cloud must agree on
 * the type set; that invariant only holds if there is exactly one place where
 * the set is declared.
 *
 * Adding a type or a metadata column is a one-file edit here. There is no
 * runtime registration path — apps cannot register new types or extend the
 * metadata columns of an existing type.
 */

export type LogicalColumnType =
  | "integer"
  | "bigint"
  | "real"
  | "text"
  | "timestamp"
  | "boolean";

export interface CoreTypeMetadataColumn {
  name: string;
  type: LogicalColumnType;
  /** Defaults to true. Set explicitly when the column must be NOT NULL. */
  nullable?: boolean;
}

export interface CoreType {
  id: string;
  description: string;
  metadataColumns: CoreTypeMetadataColumn[];
  /**
   * True for types that are excluded from wildcard `sharedTypeAccess` expansion
   * and from the public `sharedTypeAccess` allowlist. Access is granted via
   * dedicated manifest flags (canIngestUnknown, canPromoteFromUnknown) instead.
   */
  restricted?: boolean;
}

/**
 * Image metadata columns. Every column must be deterministically derivable
 * from the image file bytes (EXIF or pixel inspection). App-level / user
 * fields belong in app-private storage, not here.
 */
const IMAGE_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "width", type: "integer" },
  { name: "height", type: "integer" },
  { name: "captured_at", type: "timestamp" },
  { name: "camera_make", type: "text" },
  { name: "camera_model", type: "text" },
  { name: "f_number", type: "real" },
  { name: "exposure_time", type: "text" },
  { name: "iso", type: "integer" },
  { name: "lens_model", type: "text" },
  { name: "gps_lat", type: "real" },
  { name: "gps_lon", type: "real" },
  { name: "orientation", type: "integer" },
];

export const CORE_TYPES: readonly CoreType[] = [
  {
    id: "image",
    description: "Image file (photos, thumbnails, scans). Bytes in object storage; metadata columns hold dimensions, capture time, EXIF, and orientation.",
    metadataColumns: IMAGE_METADATA_COLUMNS,
  },
  {
    id: "markdown",
    description: "Markdown document. Bytes in object storage; no type-specific metadata columns.",
    metadataColumns: [],
  },
  {
    id: "unknown",
    description: "Holding pen for ingested files the system cannot classify. Apps cannot read this directly — egress only via promoteFromUnknown.",
    metadataColumns: [],
    restricted: true,
  },
];

export const CORE_TYPE_IDS: readonly string[] = CORE_TYPES.map((t) => t.id);

export const WILDCARD_EXPANDABLE_TYPE_IDS: readonly string[] = CORE_TYPES
  .filter((t) => !t.restricted)
  .map((t) => t.id);

export const RESTRICTED_CORE_TYPE_IDS: readonly string[] = CORE_TYPES
  .filter((t) => t.restricted)
  .map((t) => t.id);

export function getCoreType(id: string): CoreType | undefined {
  return CORE_TYPES.find((t) => t.id === id);
}

export function isCoreTypeId(id: string): boolean {
  return CORE_TYPES.some((t) => t.id === id);
}

export function isRestrictedCoreTypeId(id: string): boolean {
  return CORE_TYPES.some((t) => t.id === id && t.restricted === true);
}

function pgColumnType(t: LogicalColumnType): string {
  switch (t) {
    case "integer": return "integer";
    case "bigint": return "bigint";
    case "real": return "double precision";
    case "text": return "text";
    case "timestamp": return "timestamptz";
    case "boolean": return "boolean";
  }
}

function sqliteColumnType(t: LogicalColumnType): string {
  switch (t) {
    case "integer": return "INTEGER";
    case "bigint": return "INTEGER";
    case "real": return "REAL";
    case "text": return "TEXT";
    case "timestamp": return "TEXT";
    case "boolean": return "INTEGER";
  }
}

/**
 * Emits a `CREATE TABLE IF NOT EXISTS shared.record_<id>_metadata` statement
 * for DSQL. Single non-PL/pgSQL statement, no FK constraints — see
 * `dsql-schema-init.ts` for the DSQL surface caveats.
 */
export function pgMetadataDdl(t: CoreType): string {
  const cols = [
    `         record_id   text PRIMARY KEY`,
    ...t.metadataColumns.map((c) => {
      const nullSuffix = c.nullable === false ? " NOT NULL" : "";
      return `         ${c.name} ${pgColumnType(c.type)}${nullSuffix}`;
    }),
  ];
  return `CREATE TABLE IF NOT EXISTS shared.record_${t.id}_metadata (\n${cols.join(",\n")}\n       )`;
}

/**
 * Emits a `CREATE TABLE IF NOT EXISTS shared_record_<id>_metadata` statement
 * for the local SQLite bootstrap.
 */
export function sqliteMetadataDdl(t: CoreType): string {
  const cols = [
    `      record_id TEXT PRIMARY KEY`,
    ...t.metadataColumns.map((c) => {
      const nullSuffix = c.nullable === false ? " NOT NULL" : "";
      return `      ${c.name} ${sqliteColumnType(c.type)}${nullSuffix}`;
    }),
  ];
  return `CREATE TABLE IF NOT EXISTS shared_record_${t.id}_metadata (\n${cols.join(",\n")}\n    )`;
}

/** Returns the SQLite table name for the per-type metadata table. */
export function sqliteMetadataTableName(typeId: string): string {
  return `shared_record_${typeId.replace(/-/g, "_")}_metadata`;
}

/** Returns the DSQL/Postgres table name for the per-type metadata table. */
export function pgMetadataTableName(typeId: string): string {
  return `shared.record_${typeId.replace(/-/g, "_")}_metadata`;
}
