/**
 * Single source of truth for Starkeep's shared core type system.
 *
 * A record's canonical identity is its **Starkeep type** — a two-level
 * `<category>/<format>` id in Starkeep's own namespace (e.g. "image/jpeg"), not
 * an IANA MIME type. The writing app declares this type; the filename extension
 * and MIME type are advisory metadata only and never decide identity.
 *
 * Three views derived from one place (TYPE_SPECS):
 *   - TYPES: the authoritative registry of canonical `<category>/<format>` ids.
 *     A record's `type` is exactly one of these. `other/other` is the terminal
 *     catch-all for unmapped / extension-less files — Drive-only, no metadata
 *     table, and ungrantable.
 *   - EXTENSIONS: advisory lowercase-extension → type-id map, a convenience for
 *     ingestors (e.g. the watcher) that have only a filename. Not authoritative.
 *   - CATEGORIES: the user-facing organizational layer (mobile-style: Images,
 *     Videos, Documents…). Each mapped category owns one metadata table holding
 *     cross-format properties derivable from the file bytes. A type's category
 *     is structurally its prefix (`typeCategory(id)`).
 *
 * Every relevant system — manifest validation, IAM emission, DSQL schema-init,
 * SQLite bootstrap, object-key construction, and the data-servers' access
 * paths — derives its view from the registries below. Adding a type, an alias
 * extension, or a metadata column is a one-file edit here. There is no runtime
 * registration path — apps cannot register new types or extend metadata columns.
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
 * A canonical Starkeep type — a two-level `<category>/<format>` identifier in
 * Starkeep's own namespace (e.g. "image/jpeg"). This is NOT an IANA MIME type;
 * the syntactic resemblance is intentional but the namespace is ours (we have
 * `archive/zip` though MIME has no `archive` top-level, and we never have a
 * `multipart/*`). A record's `type` is exactly one of these ids and is the
 * canonical identity the system treats the file as; the filename extension and
 * MIME type are advisory only.
 */
export interface StarkeepTypeDef {
  /** Canonical `<category>/<format>` id, e.g. "image/jpeg". */
  id: string;
  category: Category;
  /** The `<format>` half of the id, e.g. "jpeg". */
  format: string;
}

/**
 * Single source for the type registry. Each spec is one canonical Starkeep type
 * (`<category>/<format>`) plus the filename extensions that *advise* it. Alias
 * extensions that name the same format collapse to one type (jpg+jpeg →
 * image/jpeg). Both {@link TYPES} (the authority) and {@link EXTENSIONS} (the
 * advisory ext→type map ingestors may consult) are derived from this list, so
 * adding a format or an alias is a one-place edit.
 */
interface TypeSpec {
  category: Exclude<Category, "other">;
  format: string;
  /** Advisory filename extensions (lowercase, no dot) that map to this type. */
  extensions: string[];
}

const TYPE_SPECS: readonly TypeSpec[] = [
  // image
  { category: "image", format: "jpeg", extensions: ["jpg", "jpeg"] },
  { category: "image", format: "png", extensions: ["png"] },
  { category: "image", format: "gif", extensions: ["gif"] },
  { category: "image", format: "webp", extensions: ["webp"] },
  { category: "image", format: "heic", extensions: ["heic"] },
  { category: "image", format: "heif", extensions: ["heif"] },
  { category: "image", format: "avif", extensions: ["avif"] },
  { category: "image", format: "bmp", extensions: ["bmp"] },
  { category: "image", format: "tiff", extensions: ["tif", "tiff"] },
  { category: "image", format: "svg", extensions: ["svg"] },
  { category: "image", format: "ico", extensions: ["ico"] },
  // video
  { category: "video", format: "mp4", extensions: ["mp4"] },
  { category: "video", format: "mov", extensions: ["mov"] },
  { category: "video", format: "m4v", extensions: ["m4v"] },
  { category: "video", format: "avi", extensions: ["avi"] },
  { category: "video", format: "mkv", extensions: ["mkv"] },
  { category: "video", format: "webm", extensions: ["webm"] },
  { category: "video", format: "mpeg", extensions: ["mpg", "mpeg"] },
  { category: "video", format: "wmv", extensions: ["wmv"] },
  { category: "video", format: "flv", extensions: ["flv"] },
  // audio
  { category: "audio", format: "mp3", extensions: ["mp3"] },
  { category: "audio", format: "wav", extensions: ["wav"] },
  { category: "audio", format: "flac", extensions: ["flac"] },
  { category: "audio", format: "aac", extensions: ["aac"] },
  { category: "audio", format: "ogg", extensions: ["ogg", "oga"] },
  { category: "audio", format: "opus", extensions: ["opus"] },
  { category: "audio", format: "m4a", extensions: ["m4a"] },
  { category: "audio", format: "aiff", extensions: ["aiff"] },
  { category: "audio", format: "wma", extensions: ["wma"] },
  // document
  { category: "document", format: "pdf", extensions: ["pdf"] },
  { category: "document", format: "markdown", extensions: ["md", "markdown"] },
  { category: "document", format: "html", extensions: ["htm", "html"] },
  { category: "document", format: "doc", extensions: ["doc"] },
  { category: "document", format: "docx", extensions: ["docx"] },
  { category: "document", format: "xls", extensions: ["xls"] },
  { category: "document", format: "xlsx", extensions: ["xlsx"] },
  { category: "document", format: "ppt", extensions: ["ppt"] },
  { category: "document", format: "pptx", extensions: ["pptx"] },
  { category: "document", format: "odt", extensions: ["odt"] },
  { category: "document", format: "ods", extensions: ["ods"] },
  { category: "document", format: "odp", extensions: ["odp"] },
  { category: "document", format: "rtf", extensions: ["rtf"] },
  { category: "document", format: "epub", extensions: ["epub"] },
  { category: "document", format: "pages", extensions: ["pages"] },
  { category: "document", format: "numbers", extensions: ["numbers"] },
  { category: "document", format: "key", extensions: ["key"] },
  // text
  { category: "text", format: "txt", extensions: ["txt"] },
  { category: "text", format: "log", extensions: ["log"] },
  { category: "text", format: "env", extensions: ["env"] },
  { category: "text", format: "json", extensions: ["json"] },
  { category: "text", format: "jsonc", extensions: ["jsonc"] },
  { category: "text", format: "xml", extensions: ["xml"] },
  { category: "text", format: "yaml", extensions: ["yml", "yaml"] },
  { category: "text", format: "toml", extensions: ["toml"] },
  { category: "text", format: "ini", extensions: ["ini"] },
  { category: "text", format: "conf", extensions: ["conf"] },
  { category: "text", format: "tex", extensions: ["tex"] },
  { category: "text", format: "rst", extensions: ["rst"] },
  { category: "text", format: "adoc", extensions: ["adoc"] },
  // code
  { category: "code", format: "js", extensions: ["js"] },
  { category: "code", format: "mjs", extensions: ["mjs"] },
  { category: "code", format: "cjs", extensions: ["cjs"] },
  { category: "code", format: "ts", extensions: ["ts"] },
  { category: "code", format: "tsx", extensions: ["tsx"] },
  { category: "code", format: "jsx", extensions: ["jsx"] },
  { category: "code", format: "py", extensions: ["py"] },
  { category: "code", format: "rb", extensions: ["rb"] },
  { category: "code", format: "go", extensions: ["go"] },
  { category: "code", format: "rs", extensions: ["rs"] },
  { category: "code", format: "java", extensions: ["java"] },
  { category: "code", format: "kt", extensions: ["kt"] },
  { category: "code", format: "swift", extensions: ["swift"] },
  { category: "code", format: "c", extensions: ["c"] },
  { category: "code", format: "h", extensions: ["h"] },
  { category: "code", format: "cpp", extensions: ["cpp"] },
  { category: "code", format: "hpp", extensions: ["hpp"] },
  { category: "code", format: "cs", extensions: ["cs"] },
  { category: "code", format: "php", extensions: ["php"] },
  { category: "code", format: "sh", extensions: ["sh"] },
  { category: "code", format: "bash", extensions: ["bash"] },
  { category: "code", format: "zsh", extensions: ["zsh"] },
  { category: "code", format: "fish", extensions: ["fish"] },
  { category: "code", format: "ps1", extensions: ["ps1"] },
  { category: "code", format: "lua", extensions: ["lua"] },
  { category: "code", format: "r", extensions: ["r"] },
  { category: "code", format: "sql", extensions: ["sql"] },
  { category: "code", format: "css", extensions: ["css"] },
  { category: "code", format: "scss", extensions: ["scss"] },
  { category: "code", format: "sass", extensions: ["sass"] },
  { category: "code", format: "less", extensions: ["less"] },
  { category: "code", format: "vue", extensions: ["vue"] },
  { category: "code", format: "svelte", extensions: ["svelte"] },
  { category: "code", format: "dockerfile", extensions: ["dockerfile"] },
  { category: "code", format: "gitignore", extensions: ["gitignore"] },
  { category: "code", format: "gitattributes", extensions: ["gitattributes"] },
  // font
  { category: "font", format: "ttf", extensions: ["ttf"] },
  { category: "font", format: "otf", extensions: ["otf"] },
  { category: "font", format: "woff", extensions: ["woff"] },
  { category: "font", format: "woff2", extensions: ["woff2"] },
  { category: "font", format: "eot", extensions: ["eot"] },
  // archive
  { category: "archive", format: "zip", extensions: ["zip"] },
  { category: "archive", format: "tar", extensions: ["tar"] },
  { category: "archive", format: "gz", extensions: ["gz"] },
  { category: "archive", format: "tgz", extensions: ["tgz"] },
  { category: "archive", format: "bz2", extensions: ["bz2"] },
  { category: "archive", format: "tbz2", extensions: ["tbz2"] },
  { category: "archive", format: "xz", extensions: ["xz"] },
  { category: "archive", format: "txz", extensions: ["txz"] },
  { category: "archive", format: "7z", extensions: ["7z"] },
  { category: "archive", format: "rar", extensions: ["rar"] },
  { category: "archive", format: "zst", extensions: ["zst"] },
  // data
  { category: "data", format: "csv", extensions: ["csv"] },
  { category: "data", format: "tsv", extensions: ["tsv"] },
  { category: "data", format: "parquet", extensions: ["parquet"] },
  { category: "data", format: "arrow", extensions: ["arrow"] },
  { category: "data", format: "feather", extensions: ["feather"] },
  { category: "data", format: "sqlite", extensions: ["sqlite", "sqlite3"] },
  { category: "data", format: "db", extensions: ["db"] },
  { category: "data", format: "jsonl", extensions: ["jsonl", "ndjson"] },
  { category: "data", format: "hdf5", extensions: ["hdf5", "h5"] },
  { category: "data", format: "orc", extensions: ["orc"] },
  // model3d
  { category: "model3d", format: "obj", extensions: ["obj"] },
  { category: "model3d", format: "stl", extensions: ["stl"] },
  { category: "model3d", format: "gltf", extensions: ["gltf"] },
  { category: "model3d", format: "glb", extensions: ["glb"] },
  { category: "model3d", format: "fbx", extensions: ["fbx"] },
  { category: "model3d", format: "dae", extensions: ["dae"] },
  { category: "model3d", format: "3ds", extensions: ["3ds"] },
  { category: "model3d", format: "blend", extensions: ["blend"] },
  { category: "model3d", format: "ply", extensions: ["ply"] },
  { category: "model3d", format: "usd", extensions: ["usd"] },
  { category: "model3d", format: "usdz", extensions: ["usdz"] },
];

/** The terminal catch-all type for unmapped / extension-less files. */
export const OTHER_TYPE_ID = "other/other";

/**
 * The authoritative registry of canonical Starkeep types. Derived from
 * {@link TYPE_SPECS} plus the terminal {@link OTHER_TYPE_ID}. `other/other` is
 * Drive-only and ungrantable (see {@link APP_GRANTABLE_CATEGORIES}); every
 * other type maps to a real metadata-bearing category.
 */
export const TYPES: readonly StarkeepTypeDef[] = [
  ...TYPE_SPECS.map((s) => ({ id: `${s.category}/${s.format}`, category: s.category, format: s.format })),
  { id: OTHER_TYPE_ID, category: "other" as Category, format: "other" },
];

/** Lookup index for the registry, keyed by canonical type id. */
const TYPE_BY_ID: ReadonlyMap<string, StarkeepTypeDef> = new Map(TYPES.map((t) => [t.id, t]));

/** The set of known (registered) canonical type ids. */
export const TYPE_IDS: ReadonlySet<string> = new Set(TYPE_BY_ID.keys());

/**
 * Advisory map: filename extension (lowercase, no dot) → canonical type id.
 * Derived from {@link TYPE_SPECS}. This is a convenience for ingestors that
 * have only a filename to go on (e.g. the local watcher) — it is NOT the law:
 * the canonical type is whatever the writing app declares, not what the
 * extension says.
 */
export const EXTENSIONS: Readonly<Record<string, string>> = Object.fromEntries(
  TYPE_SPECS.flatMap((s) => s.extensions.map((ext) => [ext, `${s.category}/${s.format}`] as const)),
);

export const CATEGORY_IDS: readonly Category[] = CATEGORIES.map((c) => c.id);

/**
 * Categories an installable app may be granted — every category a real
 * extension can map to, i.e. all categories EXCEPT `other`. Drive's all-access
 * (`fileAccessAll`) covers `other` as well, via its `shared/*` IAM ceiling.
 */
export const APP_GRANTABLE_CATEGORIES: readonly Category[] = CATEGORY_IDS.filter(
  (c) => c !== "other",
);

/** True if `id` is a registered canonical Starkeep type. */
export function isKnownType(id: string): boolean {
  return TYPE_BY_ID.has(id);
}

/** Look up a registered type by id. */
export function getType(id: string): StarkeepTypeDef | undefined {
  return TYPE_BY_ID.get(id);
}

/**
 * The category half of a canonical type id (`<category>/<format>`). Structural —
 * just the prefix — falling back to "other" for ids that don't name a real
 * category. This replaces the old extension-derived `categoryOf`: storage keys,
 * metadata-table routing, and IAM ceilings are all category-namespaced and read
 * the category straight off the record's canonical `type`.
 */
export function typeCategory(id: string): Category {
  const cat = id.split("/")[0] ?? "";
  return isCategoryId(cat) ? cat : "other";
}

/**
 * Advisory default type for a filename extension, for ingestors that have only
 * a filename (e.g. the local watcher). Unmapped / extension-less → the terminal
 * `other/other`. Accepts the extension with or without a leading dot, any case.
 * Not authoritative: an app may choose any granted type regardless of extension.
 */
export function defaultTypeForExtension(ext: string): string {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  return EXTENSIONS[normalized] ?? OTHER_TYPE_ID;
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
 * Returns the SQLite metadata table name for a canonical type id or a category
 * id. The category is the prefix when a `<category>/<format>` type is passed, so
 * storage adapters that hold only `record.type` route to the correct
 * per-category table. Passing the literal `"other"` (or an `other/*` type)
 * yields the `other` table name, which is never created — callers must not write
 * metadata for `other` records.
 */
export function sqliteMetadataTableName(typeOrCategory: string): string {
  const category = isCategoryId(typeOrCategory) ? typeOrCategory : typeCategory(typeOrCategory);
  return `shared_record_${category}_metadata`;
}

/** DSQL/Postgres counterpart of {@link sqliteMetadataTableName}. */
export function pgMetadataTableName(typeOrCategory: string): string {
  const category = isCategoryId(typeOrCategory) ? typeOrCategory : typeCategory(typeOrCategory);
  return `shared.record_${category}_metadata`;
}
