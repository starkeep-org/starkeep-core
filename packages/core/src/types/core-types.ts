/**
 * Single source of truth for Starkeep's shared core type system.
 *
 * Two registries derived from one place:
 *   - EXTENSIONS: lowercase file extension → mapped Category. Identification is
 *     by extension; MIME is never authoritative.
 *   - CATEGORIES: the user-facing organizational layer (mobile-style: Images,
 *     Videos, Documents…). Each mapped category owns one metadata table holding
 *     cross-format properties derivable from the file bytes.
 *
 * A record's `type` is the lowercase extension verbatim (e.g. "jpg", "md",
 * "xyz"), even when the extension is unmapped. Its category is derived:
 * `category = EXTENSIONS[ext] ?? "other"`. `other` is the terminal catch-all
 * for unmapped / extension-less files — Drive-only, no metadata table, and no
 * installable app can ever be granted it (apps may only declare extensions that
 * are present in EXTENSIONS, and the unmapped set IS the `other` set).
 *
 * Every relevant system — manifest validation, IAM emission, DSQL schema-init,
 * SQLite bootstrap, object-key construction, and the local data-server's access
 * path — derives its view from the registries below. Adding an extension or a
 * metadata column is a one-file edit here. There is no runtime registration
 * path — apps cannot register new types or extend metadata columns.
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

/** The fixed set of categories. `other` is the terminal catch-all (last). */
export type Category =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "text"
  | "code"
  | "font"
  | "archive"
  | "data"
  | "model3d"
  | "other";

export interface CategoryDef {
  id: Category;
  description: string;
  /** Cross-format metadata columns. Empty for `other` (no metadata table). */
  metadataColumns: CoreTypeMetadataColumn[];
}

const IMAGE_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "width", type: "integer" },
  { name: "height", type: "integer" },
  { name: "color_space", type: "text" },
  { name: "orientation", type: "integer" },
  { name: "captured_at", type: "timestamp" },
  { name: "camera_make", type: "text" },
  { name: "camera_model", type: "text" },
  { name: "lens_model", type: "text" },
  { name: "f_number", type: "real" },
  { name: "exposure_time", type: "text" },
  { name: "iso", type: "integer" },
  { name: "focal_length_mm", type: "real" },
  { name: "gps_lat", type: "real" },
  { name: "gps_lon", type: "real" },
];

const VIDEO_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "width", type: "integer" },
  { name: "height", type: "integer" },
  { name: "duration_ms", type: "bigint" },
  { name: "frame_rate", type: "real" },
  { name: "video_codec", type: "text" },
  { name: "audio_codec", type: "text" },
  { name: "bitrate", type: "bigint" },
  { name: "captured_at", type: "timestamp" },
  { name: "gps_lat", type: "real" },
  { name: "gps_lon", type: "real" },
];

const AUDIO_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "duration_ms", type: "bigint" },
  { name: "sample_rate", type: "integer" },
  { name: "channels", type: "integer" },
  { name: "bitrate", type: "bigint" },
  { name: "codec", type: "text" },
  { name: "title", type: "text" },
  { name: "artist", type: "text" },
  { name: "album", type: "text" },
  { name: "track_number", type: "integer" },
  { name: "year", type: "integer" },
  { name: "genre", type: "text" },
];

const DOCUMENT_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "page_count", type: "integer" },
  { name: "word_count", type: "integer" },
  { name: "author", type: "text" },
  { name: "title", type: "text" },
  { name: "created_at", type: "timestamp" },
  { name: "modified_at", type: "timestamp" },
  { name: "language", type: "text" },
];

const TEXT_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "line_count", type: "integer" },
  { name: "encoding", type: "text" },
];

const CODE_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "line_count", type: "integer" },
  { name: "encoding", type: "text" },
];

const FONT_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "family", type: "text" },
  { name: "subfamily", type: "text" },
  { name: "weight", type: "integer" },
  { name: "style", type: "text" },
  { name: "format", type: "text" },
];

const ARCHIVE_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "entry_count", type: "integer" },
  { name: "uncompressed_bytes", type: "bigint" },
  { name: "compression", type: "text" },
];

const DATA_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "row_count", type: "bigint" },
  { name: "column_count", type: "integer" },
  { name: "schema_json", type: "text" },
];

const MODEL3D_METADATA_COLUMNS: CoreTypeMetadataColumn[] = [
  { name: "vertex_count", type: "bigint" },
  { name: "face_count", type: "bigint" },
  { name: "has_textures", type: "boolean" },
  { name: "has_animation", type: "boolean" },
];

export const CATEGORIES: readonly CategoryDef[] = [
  { id: "image", description: "Raster and vector still images. Bytes in object storage; metadata holds dimensions, capture time, EXIF, orientation.", metadataColumns: IMAGE_METADATA_COLUMNS },
  { id: "video", description: "Moving-picture containers.", metadataColumns: VIDEO_METADATA_COLUMNS },
  { id: "audio", description: "Sound-only containers.", metadataColumns: AUDIO_METADATA_COLUMNS },
  { id: "document", description: "Office-suite and structured documents meant for human reading (incl. markdown, html, spreadsheets).", metadataColumns: DOCUMENT_METADATA_COLUMNS },
  { id: "text", description: "Plain-text formats: prose, config, structured serialization.", metadataColumns: TEXT_METADATA_COLUMNS },
  { id: "code", description: "Programming-language source files.", metadataColumns: CODE_METADATA_COLUMNS },
  { id: "font", description: "Typeface files.", metadataColumns: FONT_METADATA_COLUMNS },
  { id: "archive", description: "Compressed bundles.", metadataColumns: ARCHIVE_METADATA_COLUMNS },
  { id: "data", description: "Tabular / columnar / embedded-DB data files.", metadataColumns: DATA_METADATA_COLUMNS },
  { id: "model3d", description: "3D meshes and scenes.", metadataColumns: MODEL3D_METADATA_COLUMNS },
  { id: "other", description: "Terminal catch-all for unmapped or extension-less files. Drive-only; no metadata table; no installable-app grants.", metadataColumns: [] },
];

/**
 * Extension (lowercase, no dot) → mapped category. `other` is NEVER a value
 * here — it is exclusively the `?? "other"` fallback in `categoryOf`, which is
 * why no app can ever declare an `other` extension.
 */
export const EXTENSIONS: Readonly<Record<string, Exclude<Category, "other">>> = {
  // image
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  heic: "image", heif: "image", avif: "image", bmp: "image", tiff: "image",
  tif: "image", svg: "image", ico: "image",
  // video
  mp4: "video", mov: "video", m4v: "video", avi: "video", mkv: "video",
  webm: "video", mpg: "video", mpeg: "video", wmv: "video", flv: "video",
  // audio
  mp3: "audio", wav: "audio", flac: "audio", aac: "audio", ogg: "audio",
  oga: "audio", opus: "audio", m4a: "audio", aiff: "audio", wma: "audio",
  // document
  pdf: "document", md: "document", markdown: "document", html: "document",
  htm: "document", doc: "document", docx: "document", xls: "document",
  xlsx: "document", ppt: "document", pptx: "document", odt: "document",
  ods: "document", odp: "document", rtf: "document", epub: "document",
  pages: "document", numbers: "document", key: "document",
  // text
  txt: "text", log: "text", env: "text", json: "text", jsonc: "text",
  xml: "text", yaml: "text", yml: "text", toml: "text", ini: "text",
  conf: "text", tex: "text", rst: "text", adoc: "text",
  // code
  js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code", jsx: "code",
  py: "code", rb: "code", go: "code", rs: "code", java: "code", kt: "code",
  swift: "code", c: "code", h: "code", cpp: "code", hpp: "code", cs: "code",
  php: "code", sh: "code", bash: "code", zsh: "code", fish: "code",
  ps1: "code", lua: "code", r: "code", sql: "code", css: "code", scss: "code",
  sass: "code", less: "code", vue: "code", svelte: "code",
  dockerfile: "code", gitignore: "code", gitattributes: "code",
  // font
  ttf: "font", otf: "font", woff: "font", woff2: "font", eot: "font",
  // archive
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive",
  bz2: "archive", tbz2: "archive", xz: "archive", txz: "archive",
  "7z": "archive", rar: "archive", zst: "archive",
  // data
  csv: "data", tsv: "data", parquet: "data", arrow: "data", feather: "data",
  sqlite: "data", sqlite3: "data", db: "data", jsonl: "data", ndjson: "data",
  hdf5: "data", h5: "data", orc: "data",
  // model3d
  obj: "model3d", stl: "model3d", gltf: "model3d", glb: "model3d",
  fbx: "model3d", dae: "model3d", "3ds": "model3d", blend: "model3d",
  ply: "model3d", usd: "model3d", usdz: "model3d",
};

export const CATEGORY_IDS: readonly Category[] = CATEGORIES.map((c) => c.id);

/**
 * Categories an installable app may be granted — every category a real
 * extension can map to, i.e. all categories EXCEPT `other`. Drive's all-access
 * (`fileAccessAll`) covers `other` as well, via its `shared/*` IAM ceiling.
 */
export const APP_GRANTABLE_CATEGORIES: readonly Category[] = CATEGORY_IDS.filter(
  (c) => c !== "other",
);

/** The set of known (mapped) extensions. */
export const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(EXTENSIONS));

/**
 * Derived category for a record's extension/type. Unmapped or empty → "other".
 * Accepts the extension with or without a leading dot, any case.
 */
export function categoryOf(ext: string): Category {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  return EXTENSIONS[normalized] ?? "other";
}

export function getCategory(id: string): CategoryDef | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export function isCategoryId(id: string): id is Category {
  return CATEGORIES.some((c) => c.id === id);
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
 * Emits a `CREATE TABLE IF NOT EXISTS shared.record_<category>_metadata`
 * statement for DSQL. Single non-PL/pgSQL statement, no FK constraints — see
 * `dsql-schema-init.ts` for the DSQL surface caveats. Callers must skip the
 * `other` category (no metadata table).
 */
export function pgMetadataDdl(c: CategoryDef): string {
  const cols = [
    `         record_id   text PRIMARY KEY`,
    ...c.metadataColumns.map((col) => {
      const nullSuffix = col.nullable === false ? " NOT NULL" : "";
      return `         ${col.name} ${pgColumnType(col.type)}${nullSuffix}`;
    }),
  ];
  return `CREATE TABLE IF NOT EXISTS ${pgMetadataTableName(c.id)} (\n${cols.join(",\n")}\n       )`;
}

/**
 * Emits a `CREATE TABLE IF NOT EXISTS shared_record_<category>_metadata`
 * statement for the local SQLite bootstrap. Callers must skip the `other`
 * category (no metadata table).
 */
export function sqliteMetadataDdl(c: CategoryDef): string {
  const cols = [
    `      record_id TEXT PRIMARY KEY`,
    ...c.metadataColumns.map((col) => {
      const nullSuffix = col.nullable === false ? " NOT NULL" : "";
      return `      ${col.name} ${sqliteColumnType(col.type)}${nullSuffix}`;
    }),
  ];
  return `CREATE TABLE IF NOT EXISTS ${sqliteMetadataTableName(c.id)} (\n${cols.join(",\n")}\n    )`;
}

/**
 * Returns the SQLite metadata table name for a record's type/extension or a
 * category id. The category is derived when an extension is passed, so storage
 * adapters that hold only `record.type` route to the correct per-category
 * table. Passing the literal `"other"` (or an unmapped extension) yields the
 * `other` table name, which is never created — callers must not write metadata
 * for `other` records.
 */
export function sqliteMetadataTableName(typeOrCategory: string): string {
  const category = isCategoryId(typeOrCategory) ? typeOrCategory : categoryOf(typeOrCategory);
  return `shared_record_${category}_metadata`;
}

/** DSQL/Postgres counterpart of {@link sqliteMetadataTableName}. */
export function pgMetadataTableName(typeOrCategory: string): string {
  const category = isCategoryId(typeOrCategory) ? typeOrCategory : categoryOf(typeOrCategory);
  return `shared.record_${category}_metadata`;
}
