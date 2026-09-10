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
 *
 * ## What platform metadata is, exactly
 *
 * Narrower than "derived from the bytes". It is the intersection of four
 * properties, and all four are required:
 *
 *   1. **Derivable from the bytes** — anyone re-deriving it from the same file
 *      reproduces it.
 *   2. **Declared upfront** in the registry below.
 *   3. **Scoped to a category** rather than to an app.
 *   4. **Standard**, in that every app reading that category means the same
 *      thing by it.
 *
 * Derivability alone is not sufficient, and the wording used to invite that
 * inference. A face count, an OCR confidence and a word count from one app's
 * own parser are all derived from the bytes and none of them is metadata: the
 * registry is closed, so a per-app derived value can never be a metadata column
 * whatever its provenance. The two-way choice for such a value is a **label**
 * when other apps may read it and a **row in the app's own table** when only
 * the owning app reads it.
 *
 * ## The schema rule for anything queryable
 *
 * **Every queryable access path to shared data carries the caller's grant
 * discriminant in a position the index can use, and a resource namespaced by
 * category is a ceiling rather than a gate.**
 *
 * A surface built without one is unqueryable, and nothing says so at
 * schema-design time — which is how the per-category metadata tables came to
 * hold `record_id` and the category's columns and nothing else, while
 * `shared.record_labels` carries a denormalized `record_type` because somebody
 * hit this and solved it in one place without generalizing. Applying the rule
 * to the metadata tables is what made a metadata predicate expressible at all.
 * See METADATA_DISCRIMINANT_COLUMN.
 */

/**
 * The one column-type vocabulary both data planes name.
 *
 * Per-category metadata columns and app-syncable table columns are declared in
 * different places — this file's registry and an app's manifest — and used to
 * be spelled by two enums that mostly agreed. Two enums that mostly agree is
 * how they drift, and the query grammar has to validate a value against a
 * declared type on both planes, so the type has to mean one thing.
 *
 * `blob` came from the manifest side and `bigint` and `timestamp` from this
 * one; the union of the two is the vocabulary. Nothing requires every surface
 * to use every member: no metadata column is a `blob`, and none needs to be.
 *
 * `timestamp` is a **logical** type over a physical `text` column holding
 * canonical ISO-8601 in UTC. Deliberately not a physical `timestamptz`: SQLite
 * has no native timestamp, so a physical type would mean two representations
 * and a conversion layer between them. The declaration's whole job is to let
 * the platform promise that lexical comparison *is* time comparison, and
 * canonical text delivers that identically on both engines. The per-category
 * metadata tables predate that reasoning and do use a physical `timestamptz`
 * on the DSQL side; they are platform-written and platform-read, so nothing
 * app-facing depends on the difference.
 */
export type LogicalColumnType =
  | "integer"
  | "bigint"
  | "real"
  | "text"
  | "blob"
  | "timestamp"
  | "boolean";

/** Every member of {@link LogicalColumnType}, for schema validators. */
export const LOGICAL_COLUMN_TYPES = [
  "integer",
  "bigint",
  "real",
  "text",
  "blob",
  "timestamp",
  "boolean",
] as const satisfies readonly LogicalColumnType[];

/**
 * Types an ordered comparison (`lt`, `gt`, `min`, `max`, `order`) is defined
 * over.
 *
 * Everything but `blob` and `boolean`. Byte-string ordering is defined in SQL
 * and means nothing an app asked for. A flag has two values and no order worth
 * asking for either: `min(suspended)` and `order=suspended.asc` answer
 * questions nobody posed, and `is`, equality and `ne` cover every real one.
 *
 * `boolean` used to be admitted here while `predicateFor` rejected
 * `flag > false` by inspecting the *bound value*'s JavaScript type, so one rule
 * was enforced in two places with two messages and `order` escaped both.
 * Excluding the type states the rule once. It also keeps a boolean out of a
 * keyset page token, which would otherwise carry a sort key whose two possible
 * values cannot separate the rows a cursor has to.
 */
export function isOrderableColumnType(t: LogicalColumnType): boolean {
  return t !== "blob" && t !== "boolean";
}

/** Types `sum` and `avg` are defined over. */
export function isNumericColumnType(t: LogicalColumnType): boolean {
  return t === "integer" || t === "bigint" || t === "real";
}

/**
 * The canonical `timestamp` spelling: ISO-8601, UTC, millisecond precision.
 *
 * Fixed rather than permissive because the guarantee is lexical: two values
 * compare as instants only while every writer pads identically and every value
 * carries the same offset. `2026-01-01T00:00:00Z` and `2026-01-01T00:00:00.000Z`
 * denote the same instant and sort apart, so only one of them can be legal.
 */
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Is `value` a canonical `timestamp` string? See {@link CANONICAL_TIMESTAMP_RE}. */
export function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANONICAL_TIMESTAMP_RE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

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
  // Both are deterministic from the bytes, which is what makes them metadata
  // rather than labels — see the four properties above. A label is an app's
  // *assertion* about a record, and
  // these are facts anyone re-deriving from the same file would reproduce. Both
  // are computed during derivation, when the decoded bitmap is already in hand.
  //
  // perceptual_hash — near-duplicate detection. Deliberately not a substitute
  // for content_hash: it matches re-encodes and resizes, which is exactly what
  // makes it useful for import dedup and exactly what makes it unsafe as an
  // identity. It is a candidate-finder, never a decision.
  { name: "perceptual_hash", type: "text" },
  // thumb_hash — a ~25-byte inline placeholder, rendered client-side with zero
  // requests. It rides the record itself precisely so that the first frame of a
  // grid needs no network at all; putting it in object storage would defeat the
  // entire point by making the placeholder cost a request.
  { name: "thumb_hash", type: "text" },
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
  // Same rationale as the image columns: a video's poster frame gets a
  // ThumbHash too, and a grid mixing stills and clips must not have a hole
  // where one kind of placeholder should be.
  { name: "thumb_hash", type: "text" },
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
  // Camera raw. Until these existed, `.dng` fell through to `other/other` —
  // which is Drive-only and ungrantable to installable apps, so ProRAW was
  // invisible to Photos entirely. That was a live bug, not a missing feature:
  // the files synced and no app could be granted them.
  //
  // Each maker's raw format is its own type rather than one shared `image/raw`,
  // because they are not interchangeable — the embedded-preview layout that
  // derivation reads differs per vendor, and a single type would leave nothing
  // to branch on.
  //
  // Grants are per **type**, not per category: `fileAccess` enumerates
  // `<category>/<format>` ids and `canRead` tests one of them, so an app that
  // wants ProRAW has to declare `image/dng` and does not get it by declaring
  // `image/jpeg`. What *is* category-granular is the ceiling — the IAM policy,
  // the Postgres GRANT and the object-storage prefix — which is a different
  // thing from the gate. See the note on METADATA_DISCRIMINANT_COLUMN.
  { category: "image", format: "dng", extensions: ["dng"] },
  { category: "image", format: "cr2", extensions: ["cr2"] },
  { category: "image", format: "cr3", extensions: ["cr3"] },
  { category: "image", format: "nef", extensions: ["nef"] },
  { category: "image", format: "arw", extensions: ["arw"] },
  { category: "image", format: "raf", extensions: ["raf"] },
  { category: "image", format: "orf", extensions: ["orf"] },
  { category: "image", format: "rw2", extensions: ["rw2"] },
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

/**
 * The caller's grant discriminant, on every per-category metadata table.
 *
 * The metadata tables were the one shared surface with a ceiling and no gate.
 * The IAM policy, the Postgres `GRANT SELECT` and the `canReadCategory` check
 * are three spellings of one category-granular rule, and nothing type-granular
 * sat inside any of them — so a metadata column could not appear in a query
 * predicate at all, because the server's grant filter would have had to run
 * over whatever the scan returned rather than riding the access path.
 *
 * `shared.records` carries `type` and `shared.record_labels` carries
 * `record_type` for exactly this reason. With the column here, a pinned-category
 * query puts `record_type IN (…the caller's granted types)` on a leading index
 * column, which is the property the whole authorization question is about.
 *
 * The column cannot go stale, because a record's type is declared at creation
 * and immutable — the same trade `shared.record_labels` already made and
 * documented (`dsql-schema-init.ts`).
 *
 * **It must never come from the wire.** Per-category metadata is a sync
 * passenger: it rides on the record as `SyncRecordItem.metadata`, applied with
 * the record, with null columns stripped before sending so a node knowing less
 * cannot erase a peer's columns. That per-column merge is right for a derived
 * fact and wrong for a grant discriminant, since a peer supplying it would be
 * asserting who may read the row. It is derived locally from the record it
 * rides with, on both the sync-apply path and the app write path.
 */
export const METADATA_DISCRIMINANT_COLUMN = "record_type";

function pgColumnType(t: LogicalColumnType): string {
  switch (t) {
    case "integer": return "integer";
    case "bigint": return "bigint";
    case "real": return "double precision";
    case "text": return "text";
    case "blob": return "bytea";
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
    case "blob": return "BLOB";
    case "timestamp": return "TEXT";
    case "boolean": return "INTEGER";
  }
}

/**
 * Emits a `CREATE TABLE IF NOT EXISTS shared.record_<category>_metadata`
 * statement for DSQL. Single non-PL/pgSQL statement, no FK constraints — see
 * `dsql-schema-init.ts` for the DSQL surface caveats. Callers must skip the
 * `other` category (no metadata table).
 *
 * A caution about `record_type NOT NULL` on an install that already exists.
 * These tables are created `IF NOT EXISTS`, so a cluster provisioned before the
 * discriminant arrived keeps its old table and never gains the column from this
 * statement. Adding it afterwards reaches only half way: `ALTER TABLE ADD
 * COLUMN IF NOT EXISTS` works on DSQL and is idempotent, but `ALTER TABLE ALTER
 * COLUMN SET NOT NULL` fails with `0A000 unsupported ALTER TABLE ALTER COLUMN
 * ...` (both probed against the live cluster 2026-09-10). A migrated table
 * therefore holds a nullable `record_type` that this DDL declares NOT NULL,
 * permanently. Read gates must treat a NULL discriminant as unknown and deny
 * rather than trusting the constraint.
 *
 * None of that is wired up, deliberately. Pre-production, the per-category
 * metadata tables are derived data over shared records and are treated as
 * disposable: dropping them lets this statement recreate them with the column
 * and the constraint intact, which is why no `ALTER TABLE` path exists in the
 * installer. The facts above are recorded for whoever first needs to migrate a
 * table that cannot be dropped.
 *
 * Note the ordering trap either way: `metadataIndexDdls` builds an index over
 * `record_type`, so an index statement issued against a table that predates the
 * column fails with `42703` and takes the whole install with it. That is the
 * symptom a stale install shows, and dropping the table is the fix.
 */
export function pgMetadataDdl(c: CategoryDef): string {
  const cols = [
    `         record_id   text PRIMARY KEY`,
    `         ${METADATA_DISCRIMINANT_COLUMN} text NOT NULL`,
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
    `      ${METADATA_DISCRIMINANT_COLUMN} TEXT NOT NULL`,
    ...c.metadataColumns.map((col) => {
      const nullSuffix = col.nullable === false ? " NOT NULL" : "";
      return `      ${col.name} ${sqliteColumnType(col.type)}${nullSuffix}`;
    }),
  ];
  return `CREATE TABLE IF NOT EXISTS ${sqliteMetadataTableName(c.id)} (\n${cols.join(",\n")}\n    )`;
}

/**
 * The indexes a per-category metadata table needs, as DDL for one dialect.
 *
 * The metadata tables carried no index at all beyond the `record_id` primary
 * key, so every predicate over them was a full scan — which is why the stranded
 * `capturedAt` ordering was never worth wiring up.
 *
 * One index, and only where it has a column to build on: `(record_type,
 * captured_at)`, which is the shape every real query over these tables takes.
 * `record_type` leads because it is the grant predicate and is present on every
 * query whether or not the caller asked for it, and `captured_at` follows
 * because ordering a photo library by when the shutter fired is the question
 * being asked. A category with no `captured_at` gets no index here; the plan is
 * one per named filter as callers arrive, rather than one per column in advance.
 */
export function metadataIndexDdls(
  c: CategoryDef,
  dialect: "pg" | "sqlite",
): Array<{ name: string; sql: string }> {
  if (!c.metadataColumns.some((col) => col.name === CAPTURED_AT_METADATA_COLUMN)) return [];
  const columns = `("${METADATA_DISCRIMINANT_COLUMN}", "${CAPTURED_AT_METADATA_COLUMN}")`;
  if (dialect === "pg") {
    // ASYNC because DSQL builds an index in the background and the statement
    // returns before it is usable. `IF NOT EXISTS` because install is
    // re-runnable — DSQL accepts the guard on the async form, probed against
    // the live cluster on 2026-09-10. No `USING`: DSQL refuses the access
    // method.
    const name = `idx_record_${c.id}_metadata_type_captured_at`;
    return [
      {
        name,
        sql: `CREATE INDEX ASYNC IF NOT EXISTS "${name}" ON ${pgMetadataTableName(c.id)}${columns}`,
      },
    ];
  }
  const name = `idx_${sqliteMetadataTableName(c.id)}_type_captured_at`;
  return [
    {
      name,
      sql: `CREATE INDEX IF NOT EXISTS "${name}" ON ${sqliteMetadataTableName(c.id)}${columns}`,
    },
  ];
}

/** The capture-time column, which image and video both carry and nothing else does. */
export const CAPTURED_AT_METADATA_COLUMN = "captured_at";

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
