/**
 * Public shares: a link anyone may open, showing the stand-ins of the records
 * that carry one app label, or one record.
 *
 * A public share names its source. A label share names an app label,
 * `(app_id, label_key, label_value)`, and the records carrying it are its
 * members, resolved when a visitor asks. The share copies nothing, so a record
 * labelled later appears on the next page, and a record deleted or unlabelled
 * leaves it. Photos' albums are the first use: an album is the `photos/album`
 * label with the album's id. A record share names one parentless record, and
 * that record is its only member while it lives.
 *
 * What a visitor may reach is fixed here and nowhere else:
 *
 * - **Members** are the owner's parentless, live records named by the source,
 *   of a type the creating app may read. A label share admits image and video
 *   records only.
 * - **Display children** are a media member's stand-ins, and the
 *   image-category derived children of a video member (its poster frames)
 *   that carry a label in the creating app's `derived` key.
 * - **A record share's original**, through `GET /public-shares/<token>/file/<name>`
 *   only, and only when the record is a file member (neither image nor video,
 *   so it has no stand-in) or the share says `serves: "original"`. Only a
 *   Starkeep Drive record share may say so for an image or video.
 * - **Nothing else.** No labels, no captions, no record ids, no metadata
 *   beyond a display size.
 *
 * The items route never signs an original, whatever its size. That rule keeps
 * an archived original out of reach (only parentless originals archive), keeps
 * a large original's egress off an album, and keeps a small original's EXIF
 * and GPS off it too: stand-ins carry no EXIF, and a self-canonical original
 * shows at its largest smaller stand-in instead. {@link PublicDisplaySet}
 * enforces the rule at the signer, so the viewer has no original to offer
 * rather than declining to show one. {@link PublicFileGrant} is the one other
 * signer path, and admits exactly one original's key.
 *
 * The anonymous routes call only {@link loadPublicSharePage},
 * {@link projectPublicSharePage} and {@link loadPublicShareRecord}. None of
 * them reads anything from the request but the link token and the cursor, and
 * none shares code with the general records handler, which is how a request
 * parameter cannot widen the query.
 *
 * See `~/projects/starkeep/proposal-public-sharing-albums-2026-11-05.md`,
 * section "Public shares", and
 * `~/projects/starkeep/plan-public-links-single-items-and-drive-2026-11-05.md`.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { contentDisposition } from "@starkeep/app-client/content-disposition";
import {
  canRead,
  isStandInOriginal,
  isStarkeepId,
  typeCategory,
  type AccessGrants,
  type DataRecord,
  type StandInStandards,
  type StandInSummary,
  type StarkeepId,
  type VariantCandidate,
} from "@starkeep/protocol-primitives";
import { postgresCompiler, type DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  LABEL_QUERY_TARGET,
  labelPageFrom,
  loadStandInSummariesForPage,
  loadVariantCandidatesForPage,
  planFindByLabel,
  type DatabaseAdapter,
} from "@starkeep/storage-adapter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The anonymous routes: `GET /public-shares/<linkToken>/items` and
 * `GET /public-shares/<linkToken>/file/<name>`.
 */
export const PUBLIC_SHARES_PREFIX = "/public-shares/";

/** A link token: 128 random bits, base64url, so 22 characters. */
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Items per page. A grid screen and a little more. */
export const PUBLIC_SHARE_PAGE_SIZE = 60;

/**
 * Members one public share shows at most.
 *
 * Membership lives in the reverse label index, which orders by record id, and
 * a visitor expects capture order. So each page reads the label's whole
 * membership from the index (index-only, cheap) and lets one records query
 * order and page it. The cap bounds that read and the IN-list it feeds.
 */
export const PUBLIC_SHARE_MAX_MEMBERS = 2_000;

/** Label rows per index read while collecting the membership. */
const MEMBERSHIP_READ_PAGE = 1_000;

/**
 * How long a signed display URL lives. Short, because revocation stops new
 * pages at once but cannot recall a URL already handed out.
 */
export const PUBLIC_SHARE_URL_TTL_SECONDS = 60 * 60;

/**
 * How long CloudFront may serve an items page from its cache. Bounds both the
 * Lambda cost of a burst of refreshes and how long a revoked link keeps
 * answering from the edge.
 */
export const PUBLIC_SHARE_CACHE_SECONDS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The lifetimes an owner may choose. `never` is a null expiry. */
export const PUBLIC_SHARE_LIFETIMES = {
  "1d": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "1y": 365 * DAY_MS,
  never: null,
} as const satisfies Record<string, number | null>;

export type PublicShareLifetime = keyof typeof PUBLIC_SHARE_LIFETIMES;

export const DEFAULT_PUBLIC_SHARE_LIFETIME: PublicShareLifetime = "30d";

/** Longest title a visitor sees. */
export const PUBLIC_SHARE_TITLE_MAX = 200;

/** The app key whose label marks a derived child: a video's poster frame. */
const DERIVED_KEY = "derived";

// ---------------------------------------------------------------------------
// The share record
// ---------------------------------------------------------------------------

/** What a public share names: an app label, or one record. */
export type PublicShareSource =
  | { readonly kind: "label"; readonly key: string; readonly value: string }
  | { readonly kind: "record"; readonly recordId: string };

/**
 * What a record share's link serves for an image or video. A file member has
 * no stand-in and always serves its original, so its row stores `original`.
 */
export type PublicShareServes = "stand-in" | "original";

export interface PublicShareRow {
  readonly id: string;
  readonly link_token: string;
  readonly owner_user_id: string;
  readonly app_id: string;
  readonly source_kind: PublicShareSource["kind"];
  /** Set for a label share, null for a record share. */
  readonly label_key: string | null;
  readonly label_value: string | null;
  /** Set for a record share, null for a label share. */
  readonly record_id: string | null;
  readonly serves: PublicShareServes;
  readonly title: string;
  readonly item_id_salt: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number | null;
}

const SHARES_TABLE = "public_sharing.public_shares";
const CAPABILITIES_TABLE = "public_sharing.app_capabilities";

const SHARE_COLUMNS = [
  "id",
  "link_token",
  "owner_user_id",
  "app_id",
  "source_kind",
  "label_key",
  "label_value",
  "record_id",
  "serves",
  "title",
  "item_id_salt",
  "created_at_ms",
  "expires_at_ms",
] as const;

/** The link token in `/public-shares/<token>/items`, or null for any other path. */
export function publicItemsToken(rawPath: string): string | null {
  return publicShareToken(rawPath, "items");
}

/**
 * The link token in `/public-shares/<token>/file/<name>`, or null for any
 * other path. The name tells a recipient what the link opens, and the route
 * reads nothing from it.
 */
export function publicFileToken(rawPath: string): string | null {
  if (!rawPath.startsWith(PUBLIC_SHARES_PREFIX)) return null;
  const m = rawPath.match(/^\/public-shares\/([^/]+)\/file\/[^/]+$/);
  if (!m || !LINK_TOKEN_PATTERN.test(m[1]!)) return null;
  return m[1]!;
}

function publicShareToken(rawPath: string, leaf: "items"): string | null {
  if (!rawPath.startsWith(PUBLIC_SHARES_PREFIX)) return null;
  const m = rawPath.match(/^\/public-shares\/([^/]+)\/([a-z]+)$/);
  if (!m || m[2] !== leaf || !LINK_TOKEN_PATTERN.test(m[1]!)) return null;
  return m[1]!;
}

export function newLinkToken(): string {
  return randomBytes(16).toString("base64url");
}

export function newItemIdSalt(): string {
  return randomBytes(32).toString("hex");
}

/**
 * A member's id as a visitor sees it: stable within one public share and
 * unlinkable across two, so no record id reaches a visitor and nobody can
 * test whether the owner holds a given file.
 */
export function publicItemId(salt: string, recordId: StarkeepId): string {
  return createHmac("sha256", salt).update(recordId).digest("base64url").slice(0, 22);
}

/** The expiry for a lifetime chosen now, or null when it is not one of the choices. */
export function expiresAtFor(
  lifetime: unknown,
  nowMs: number,
): { ok: true; expiresAtMs: number | null } | { ok: false } {
  if (typeof lifetime !== "string" || !Object.hasOwn(PUBLIC_SHARE_LIFETIMES, lifetime)) {
    return { ok: false };
  }
  const span = PUBLIC_SHARE_LIFETIMES[lifetime as PublicShareLifetime];
  return { ok: true, expiresAtMs: span === null ? null : nowMs + span };
}

export function isExpired(share: PublicShareRow, nowMs: number): boolean {
  return share.expires_at_ms !== null && share.expires_at_ms <= nowMs;
}

/** A title as stored: trimmed, non-empty, bounded. Null when unusable. */
export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.trim();
  if (title.length === 0 || title.length > PUBLIC_SHARE_TITLE_MAX) return null;
  return title;
}

/** A share's source, from its row. */
export function sourceOf(share: PublicShareRow): PublicShareSource {
  return share.source_kind === "record"
    ? { kind: "record", recordId: share.record_id! }
    : { kind: "label", key: share.label_key!, value: share.label_value! };
}

/**
 * The source an owner's request names, or an error. The label's key and the
 * record's existence are checked by the caller, which holds the database.
 */
export function parseSource(
  raw: unknown,
): { ok: true; source: PublicShareSource } | { ok: false; message: string } {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (body?.kind === "label") {
    if (typeof body.key !== "string" || typeof body.value !== "string") {
      return { ok: false, message: "A label source needs key and value (strings)" };
    }
    if (body.value.length === 0 || Buffer.byteLength(body.value, "utf8") > 128) {
      return { ok: false, message: "A label value must be 1 to 128 bytes" };
    }
    return { ok: true, source: { kind: "label", key: body.key, value: body.value } };
  }
  if (body?.kind === "record") {
    if (!isStarkeepId(body.recordId)) {
      return { ok: false, message: "A record source needs recordId (a record id)" };
    }
    return { ok: true, source: { kind: "record", recordId: body.recordId } };
  }
  return {
    ok: false,
    message: 'source must be { kind: "label", key, value } or { kind: "record", recordId }',
  };
}

/** What the owner's routes answer for one public share. Never the salt. */
export function ownerView(share: PublicShareRow) {
  return {
    id: share.id,
    linkToken: share.link_token,
    source: sourceOf(share),
    serves: share.serves,
    title: share.title,
    createdAtMs: Number(share.created_at_ms),
    expiresAtMs: share.expires_at_ms === null ? null : Number(share.expires_at_ms),
  };
}

function rowOf(raw: Record<string, unknown>): PublicShareRow {
  return {
    ...(raw as unknown as PublicShareRow),
    // `bigint` comes back from `pg` as a string.
    created_at_ms: Number(raw.created_at_ms),
    expires_at_ms: raw.expires_at_ms === null ? null : Number(raw.expires_at_ms),
  };
}

type Db = Record<string, Record<string, unknown>>;
const compiler = postgresCompiler as unknown as import("kysely").Kysely<Db>;

async function run(
  client: DatabaseClient,
  compiled: { sql: string; parameters: readonly unknown[] },
): Promise<Record<string, unknown>[]> {
  const result = await client.query(compiled.sql, [...compiled.parameters]);
  return result.rows as Record<string, unknown>[];
}

/** Whether the person approved this app to publish public links at install. */
export async function appMayPublish(client: DatabaseClient, appId: string): Promise<boolean> {
  const rows = await run(
    client,
    compiler.selectFrom(CAPABILITIES_TABLE).select("app_id").where("app_id", "=", appId).compile(),
  );
  return rows.length > 0;
}

export async function findShareByToken(
  client: DatabaseClient,
  linkToken: string,
): Promise<PublicShareRow | null> {
  const rows = await run(
    client,
    compiler
      .selectFrom(SHARES_TABLE)
      .select([...SHARE_COLUMNS])
      .where("link_token", "=", linkToken)
      .compile(),
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/** The owner's own share, or null. Every owner route reads through this. */
export async function findOwnedShare(
  client: DatabaseClient,
  owner: { appId: string; userId: string },
  id: string,
): Promise<PublicShareRow | null> {
  const rows = await run(
    client,
    compiler
      .selectFrom(SHARES_TABLE)
      .select([...SHARE_COLUMNS])
      .where("id", "=", id)
      .where("owner_user_id", "=", owner.userId)
      .where("app_id", "=", owner.appId)
      .compile(),
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

export async function listOwnedShares(
  client: DatabaseClient,
  owner: { appId: string; userId: string },
  source?: PublicShareSource,
): Promise<PublicShareRow[]> {
  let q = compiler
    .selectFrom(SHARES_TABLE)
    .select([...SHARE_COLUMNS])
    .where("owner_user_id", "=", owner.userId)
    .where("app_id", "=", owner.appId);
  if (source?.kind === "label") {
    q = q
      .where("source_kind", "=", "label")
      .where("label_key", "=", source.key)
      .where("label_value", "=", source.value);
  } else if (source?.kind === "record") {
    q = q.where("source_kind", "=", "record").where("record_id", "=", source.recordId);
  }
  const rows = await run(client, q.orderBy("created_at_ms", "asc").compile());
  return rows.map(rowOf);
}

export async function insertShare(client: DatabaseClient, share: PublicShareRow): Promise<void> {
  await run(
    client,
    compiler
      .insertInto(SHARES_TABLE)
      .values({ ...share })
      .compile(),
  );
}

/** Apply a change to the owner's share. The owner predicate rides on the update itself. */
export async function updateOwnedShare(
  client: DatabaseClient,
  owner: { appId: string; userId: string },
  id: string,
  set: Partial<Pick<PublicShareRow, "title" | "expires_at_ms" | "link_token">>,
): Promise<void> {
  await run(
    client,
    compiler
      .updateTable(SHARES_TABLE)
      .set({ ...set })
      .where("id", "=", id)
      .where("owner_user_id", "=", owner.userId)
      .where("app_id", "=", owner.appId)
      .compile(),
  );
}

export async function deleteOwnedShare(
  client: DatabaseClient,
  owner: { appId: string; userId: string },
  id: string,
): Promise<void> {
  await run(
    client,
    compiler
      .deleteFrom(SHARES_TABLE)
      .where("id", "=", id)
      .where("owner_user_id", "=", owner.userId)
      .where("app_id", "=", owner.appId)
      .compile(),
  );
}

/** A fresh share, ready to insert. */
export function newShare(input: {
  ownerUserId: string;
  appId: string;
  source: PublicShareSource;
  serves: PublicShareServes;
  title: string;
  nowMs: number;
  expiresAtMs: number | null;
}): PublicShareRow {
  const { source } = input;
  return {
    id: randomUUID(),
    link_token: newLinkToken(),
    owner_user_id: input.ownerUserId,
    app_id: input.appId,
    source_kind: source.kind,
    label_key: source.kind === "label" ? source.key : null,
    label_value: source.kind === "label" ? source.value : null,
    record_id: source.kind === "record" ? source.recordId : null,
    serves: input.serves,
    title: input.title,
    item_id_salt: newItemIdSalt(),
    created_at_ms: input.nowMs,
    expires_at_ms: input.expiresAtMs,
  };
}

// ---------------------------------------------------------------------------
// The keys a page may sign
// ---------------------------------------------------------------------------

export type KeyCheck = { ok: true } | { ok: false; status: number; message: string };

/**
 * The object keys one items page may sign, and the keys it never may.
 *
 * Built from what the fixed query returned, never from the request. A display
 * child is admitted with its parent; a member's own key is recorded so that a
 * child sharing it (identical bytes) still cannot sign it. `check` is what
 * `signPublicShareCloudFrontUrl` asks before it signs anything.
 */
export class PublicDisplaySet {
  private readonly admitted = new Set<string>();
  private readonly originals = new Set<string>();

  constructor(readonly ownerUserId: string) {}

  /** A member: its key is never signable through this set. */
  addMember(record: Pick<DataRecord, "objectStorageKey" | "parentId">): void {
    this.originals.add(record.objectStorageKey);
  }

  /** A display child. A record with no parent is refused, whatever else it is. */
  admit(child: { objectStorageKey: string; parentId: string | null }): boolean {
    if (child.parentId === null) return false;
    this.admitted.add(child.objectStorageKey);
    return true;
  }

  check(key: string): KeyCheck {
    const owned = checkOwnedSharedKey(this.ownerUserId, key);
    if (!owned.ok) return owned;
    if (this.originals.has(key)) {
      return { ok: false, status: 403, message: "Forbidden (an original's key)" };
    }
    if (!this.admitted.has(key)) {
      return { ok: false, status: 403, message: "Forbidden (not a display child of this page)" };
    }
    return { ok: true };
  }
}

/** A key under `shared/<ownerUserId>/`, in the shared key layout, with no traversal. */
function checkOwnedSharedKey(ownerUserId: string, key: string): KeyCheck {
  if (key.split("/").includes("..")) return { ok: false, status: 400, message: "Invalid key" };
  const m = key.match(
    /^shared\/([A-Za-z0-9_-]+)\/([a-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/,
  );
  if (!m) return { ok: false, status: 400, message: "Not a shared key" };
  if (m[1] !== ownerUserId) {
    return { ok: false, status: 403, message: "Forbidden (another user's key)" };
  }
  return { ok: true };
}

/**
 * The one original a record share's `/file` route may sign.
 *
 * Built from the record {@link loadPublicShareRecord} returned, never from the
 * request, and it admits exactly that record's key. A file member's original
 * is always admitted, because a file has no stand-in. An image or video
 * original is admitted only when the share row says `original`, which only a
 * Starkeep Drive record share may store, so an album or a Photos link can
 * never reach one through this path either. `forRecord` answers null for
 * anything else, and the route then serves a stand-in or nothing.
 */
export class PublicFileGrant {
  private constructor(
    readonly ownerUserId: string,
    private readonly key: string,
  ) {}

  static forRecord(
    share: Pick<PublicShareRow, "owner_user_id" | "source_kind" | "record_id" | "serves">,
    record: { id: string; type: string; objectStorageKey: string; parentId: string | null },
  ): PublicFileGrant | null {
    if (share.source_kind !== "record" || share.record_id !== record.id) return null;
    if (record.parentId !== null) return null;
    if (!isFileType(record.type) && share.serves !== "original") return null;
    return new PublicFileGrant(share.owner_user_id, record.objectStorageKey);
  }

  check(key: string): KeyCheck {
    const owned = checkOwnedSharedKey(this.ownerUserId, key);
    if (!owned.ok) return owned;
    if (key !== this.key) {
      return { ok: false, status: 403, message: "Forbidden (not this link's file)" };
    }
    return { ok: true };
  }
}

/**
 * The content type a direct link shows in the browser, by record type, or
 * null for a type that downloads. Each one renders as an image, a player, a
 * PDF viewer or plain text, and none can run script. Every text and code type,
 * and Markdown, shows as UTF-8 plain text.
 *
 * The signed URL pins this type, so the type stored at upload never decides
 * how a browser treats the file. The direct link opens on the deployment's own
 * origin, beside the signed-in cloud apps, and an HTML or SVG file shown there
 * would run its script as those apps.
 */
const INLINE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
  "image/avif": "image/avif",
  "image/heic": "image/heic",
  "image/heif": "image/heif",
  "image/bmp": "image/bmp",
  "image/tiff": "image/tiff",
  "image/ico": "image/x-icon",
  "video/mp4": "video/mp4",
  "video/m4v": "video/mp4",
  "video/mov": "video/quicktime",
  "video/webm": "video/webm",
  "audio/mp3": "audio/mpeg",
  "audio/m4a": "audio/mp4",
  "audio/aac": "audio/aac",
  "audio/wav": "audio/wav",
  "audio/flac": "audio/flac",
  "audio/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "document/pdf": "application/pdf",
};

const PLAIN_TEXT = "text/plain; charset=utf-8";

function inlineContentType(type: string): string | null {
  const exact = INLINE_CONTENT_TYPES[type];
  if (exact) return exact;
  const category = typeCategory(type);
  if (
    category === "text" ||
    category === "code" ||
    type === "document/markdown" ||
    type === "example/plaintext"
  ) {
    return PLAIN_TEXT;
  }
  return null;
}

/** How S3 answers a direct link's file: the type it pins and the disposition. */
export interface PublicFileResponse {
  readonly contentType: string;
  readonly disposition: string;
}

/**
 * The response a direct link's file gets. A type in the inline list opens in
 * the browser under its pinned type. Any other type downloads as
 * `application/octet-stream`, so a browser never renders it.
 *
 * The file takes the share's title for its name, with the served file's
 * extension when the title lacks it: the original's for an original, and the
 * stand-in's format for a stand-in. A stand-in's name drops the original's
 * extension first. `contentDisposition` from `@starkeep/app-client` builds
 * the header, the same construction Drive's file route uses.
 */
export function publicFileResponse(
  title: string,
  originalFilename: string | null,
  served: { readonly type: string; readonly isOriginal: boolean },
): PublicFileResponse {
  const originalExt = originalFilename?.match(/\.([A-Za-z0-9]{1,10})$/)?.[1] ?? null;
  const servedExt = served.isOriginal ? originalExt : (served.type.split("/")[1] ?? null);
  let base = title.trim() || "download";
  if (
    !served.isOriginal &&
    originalExt &&
    base.toLowerCase().endsWith(`.${originalExt.toLowerCase()}`)
  ) {
    base = base.slice(0, -(originalExt.length + 1));
  }
  const name =
    servedExt && !base.toLowerCase().endsWith(`.${servedExt.toLowerCase()}`)
      ? `${base}.${servedExt}`
      : base;
  const inline = inlineContentType(served.type);
  return {
    contentType: inline ?? "application/octet-stream",
    disposition: contentDisposition(name, { inline: inline !== null }),
  };
}

// ---------------------------------------------------------------------------
// The fixed query
// ---------------------------------------------------------------------------

/** What one items page read, before projection. */
export interface PublicSharePage {
  readonly members: readonly DataRecord[];
  readonly summaries: ReadonlyMap<StarkeepId, StandInSummary>;
  readonly posters: ReadonlyMap<StarkeepId, readonly VariantCandidate[]>;
  /**
   * Every display child's key with its `updatedAt`, for the check that its
   * file has reached the cloud. A child whose file is still on a device is
   * left off the page rather than signed into a URL that cannot load.
   */
  readonly displayFiles: ReadonlyArray<{ key: string; updatedAt: DataRecord["updatedAt"] }>;
  readonly nextCursor: string | null;
  /** Whether the label has more members than one public share shows. */
  readonly truncated: boolean;
}

const PUBLIC_CATEGORIES = new Set(["image", "video"]);

/**
 * Whether a type is a file member's: neither image nor video, so it has no
 * stand-in and a public link can only serve its original.
 */
export function isFileType(type: string): boolean {
  return !PUBLIC_CATEGORIES.has(typeCategory(type));
}

/**
 * The ids a share's source names, before the records query filters them. A
 * record share names its one record. A label share reads the label's whole
 * membership from the reverse index, where the value matches by equality.
 */
async function loadMembership(
  db: DatabaseAdapter,
  share: PublicShareRow,
  readable: readonly string[] | null,
): Promise<{ ids: StarkeepId[]; truncated: boolean }> {
  if (share.source_kind === "record") {
    return { ids: [share.record_id! as StarkeepId], truncated: false };
  }
  if (readable === null) return { ids: [], truncated: false };
  const ids: StarkeepId[] = [];
  let labelCursor: string | undefined;
  let truncated = false;
  for (;;) {
    const plan = planFindByLabel({
      appId: share.app_id,
      key: share.label_key!,
      value: share.label_value!,
      readableTypes: new Set(readable),
      limit: MEMBERSHIP_READ_PAGE,
      ...(labelCursor === undefined ? {} : { cursor: labelCursor }),
    });
    if (plan === null) break;
    const found = labelPageFrom(
      await db.queryShared(LABEL_QUERY_TARGET, plan.query, { serverWhere: plan.serverWhere }),
    );
    for (const label of found.labels) ids.push(label.recordId);
    if (ids.length >= PUBLIC_SHARE_MAX_MEMBERS) {
      truncated = ids.length > PUBLIC_SHARE_MAX_MEMBERS || found.nextCursor !== null;
      ids.length = Math.min(ids.length, PUBLIC_SHARE_MAX_MEMBERS);
      break;
    }
    if (found.nextCursor === null) break;
    labelCursor = found.nextCursor;
  }
  return { ids, truncated };
}

/**
 * A record share's one record, when it is still the owner's parentless, live
 * record of a type the creating app may read. Null otherwise, which a visitor
 * sees as a link that no longer shows anything.
 *
 * `db` and `grants` are as for {@link loadPublicSharePage}. The owner routes
 * call this too, so a share is created only for a record a visit could reach.
 */
export async function loadPublicShareRecord(
  db: DatabaseAdapter,
  grants: AccessGrants,
  recordId: string,
): Promise<DataRecord | null> {
  const page = await db.query({
    filters: [
      { field: "id", operator: "in", value: [recordId as StarkeepId] },
      { field: "parentId", operator: "isNull" },
      { field: "deletedAt", operator: "isNull" },
    ],
    where: [{ column: "stand_in_role", predicate: { op: "is", value: null } }],
    limit: 1,
  });
  const record = page.records[0];
  if (
    !record ||
    record.id !== recordId ||
    record.parentId !== null ||
    record.deletedAt ||
    record.standInRole !== null ||
    !canRead(grants, record.type)
  ) {
    return null;
  }
  return record;
}

/**
 * One page of a public share's members and their display children.
 *
 * `db` is the creating app's adapter scoped to the owner, so every statement
 * reads the owner's rows only; `grants` are the creating app's. `cursor` is
 * the records query's own page token and the only input from the request.
 */
export async function loadPublicSharePage(
  db: DatabaseAdapter,
  grants: AccessGrants,
  share: PublicShareRow,
  standards: StandInStandards,
  cursor: string | undefined,
): Promise<PublicSharePage> {
  // The media types the app may read. Starkeep Drive reads every type by id
  // rather than by grant rows, so it has no list; its record shares filter by
  // category below instead. It declares no label key, so it has no label share.
  const readable = grants.allAccess
    ? null
    : [...grants.readableTypes].filter((t) => PUBLIC_CATEGORIES.has(typeCategory(t)));
  if (readable === null ? share.source_kind !== "record" : readable.length === 0) {
    return {
      members: [],
      summaries: new Map(),
      posters: new Map(),
      displayFiles: [],
      nextCursor: null,
      truncated: false,
    };
  }

  const { ids, truncated } = await loadMembership(db, share, readable);
  if (ids.length === 0) {
    return {
      members: [],
      summaries: new Map(),
      posters: new Map(),
      displayFiles: [],
      nextCursor: null,
      truncated,
    };
  }

  // One page of them, in capture order. A label on a child record admits
  // nothing: only parentless records are members.
  const page = await db.query({
    filters: [
      { field: "id", operator: "in", value: ids },
      { field: "parentId", operator: "isNull" },
      { field: "deletedAt", operator: "isNull" },
    ],
    where: [
      ...(readable === null
        ? []
        : [{ column: "type", predicate: { op: "in", values: readable.sort() } } as const]),
      { column: "stand_in_role", predicate: { op: "is", value: null } },
    ],
    sort: [
      { field: "capturedAt", direction: "desc" },
      { field: "createdAt", direction: "desc" },
    ],
    limit: PUBLIC_SHARE_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const members = page.records.filter(
    (r) =>
      r.parentId === null &&
      !r.deletedAt &&
      canRead(grants, r.type) &&
      PUBLIC_CATEGORIES.has(typeCategory(r.type)) &&
      isStandInOriginal(r),
  );

  const displayFiles: Array<{ key: string; updatedAt: DataRecord["updatedAt"] }> = [];
  const summaries = await loadStandInSummariesForPage(db, members, standards, async (record) => {
    // Placement is asked of every record a size can name, the original
    // included; only the children are display files.
    if (record.parentId !== null) {
      displayFiles.push({ key: record.objectStorageKey, updatedAt: record.updatedAt });
    }
    return "cloud";
  });
  const videos = members.filter((r) => typeCategory(r.type) === "video");
  const candidates = await loadVariantCandidatesForPage(db, videos, {
    appId: share.app_id,
    key: DERIVED_KEY,
  });
  const posters = new Map<StarkeepId, VariantCandidate[]>();
  for (const [id, list] of candidates) {
    const stills = list.filter(
      (c) => typeCategory(c.type) === "image" && canRead(grants, c.type) && c.width && c.height,
    );
    if (stills.length === 0) continue;
    posters.set(id, stills);
    for (const c of stills) displayFiles.push({ key: c.objectStorageKey, updatedAt: c.updatedAt });
  }

  return {
    members,
    summaries,
    posters,
    displayFiles,
    nextCursor: page.hasMore ? (page.nextCursor ?? null) : null,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/** One display file: a long edge in pixels for images, and the URL. */
export interface PublicDisplaySize {
  readonly longEdge: number;
  readonly url: string;
}

/** One member as a visitor sees it. Nothing here names the record. */
export interface PublicItem {
  readonly id: string;
  readonly category: "image" | "video";
  /** The largest display size's dimensions, for layout. */
  readonly width: number;
  readonly height: number;
  /** Image stand-ins, or a video's poster frames, ascending. */
  readonly sizes: readonly PublicDisplaySize[];
  /** A video's playable stand-in, when one has been made. */
  readonly playback: { readonly url: string; readonly type: string } | null;
}

/**
 * A member's stand-ins whose files have reached the cloud. Stand-ins only:
 * never the size an original answers itself.
 */
function displayStandIns(page: PublicSharePage, member: DataRecord, missing: ReadonlySet<string>) {
  return (page.summaries.get(member.id)?.sizes ?? []).filter(
    (s) =>
      (s.role === "canonical" || s.role === "smaller") &&
      s.recordId !== null &&
      s.recordId !== member.id &&
      s.objectStorageKey !== null &&
      s.objectStorageKey !== member.objectStorageKey &&
      !missing.has(s.objectStorageKey),
  );
}

/**
 * A record share's direct link to a stand-in: the URL of the one member's
 * largest stand-in, which for a video is its best playable one. Null when
 * none has reached the cloud. Unlike the items page this needs no poster
 * frame, because a browser opens the file itself.
 */
export async function signLargestStandIn(
  share: PublicShareRow,
  page: PublicSharePage,
  missing: ReadonlySet<string>,
  sign: (display: PublicDisplaySet, key: string, type: string | null) => Promise<string | null>,
): Promise<string | null> {
  const member = page.members[0];
  if (!member || share.source_kind !== "record") return null;
  const display = new PublicDisplaySet(share.owner_user_id);
  display.addMember(member);
  const best = displayStandIns(page, member, missing).sort((a, b) => b.fidelity - a.fidelity)[0];
  if (!best) return null;
  display.admit({ objectStorageKey: best.objectStorageKey!, parentId: member.id });
  return sign(display, best.objectStorageKey!, best.type);
}

/** A signer for one display key; refuses anything the page did not admit. */
export type PublicSigner = (key: string) => Promise<string | null>;

/**
 * Build the visitor's page: admit the display children, sign them, and copy
 * the allowlisted fields. A member with nothing to show yet (its stand-ins
 * still on their way from a device) is left out, and appears on a later load.
 *
 * `dimensionsOf` gives a member's stored width and height, from its metadata
 * row. Only their ratio leaves here, scaled to the largest display size.
 */
export async function projectPublicSharePage(
  share: PublicShareRow,
  page: PublicSharePage,
  dimensionsOf: (id: StarkeepId) => { width: number; height: number } | null,
  missing: ReadonlySet<string>,
  sign: (display: PublicDisplaySet, key: string) => Promise<string | null>,
): Promise<PublicItem[]> {
  const display = new PublicDisplaySet(share.owner_user_id);
  for (const member of page.members) display.addMember(member);

  const items: PublicItem[] = [];
  for (const member of page.members) {
    const category = typeCategory(member.type) === "video" ? "video" : "image";
    const standIns = displayStandIns(page, member, missing);
    for (const s of standIns)
      display.admit({ objectStorageKey: s.objectStorageKey!, parentId: member.id });

    const sizes: PublicDisplaySize[] = [];
    let playback: PublicItem["playback"] = null;
    let width = 0;
    let height = 0;

    if (category === "image") {
      const dims = dimensionsOf(member.id);
      for (const s of standIns) {
        const url = await sign(display, s.objectStorageKey!);
        if (url) sizes.push({ longEdge: s.fidelity, url });
      }
      sizes.sort((a, b) => a.longEdge - b.longEdge);
      const top = sizes[sizes.length - 1];
      if (!top || !dims || dims.width <= 0 || dims.height <= 0) continue;
      const scale = top.longEdge / Math.max(dims.width, dims.height);
      width = Math.max(1, Math.round(dims.width * scale));
      height = Math.max(1, Math.round(dims.height * scale));
    } else {
      const stills = (page.posters.get(member.id) ?? []).filter(
        (c) => c.objectStorageKey !== member.objectStorageKey && !missing.has(c.objectStorageKey),
      );
      for (const c of stills)
        display.admit({ objectStorageKey: c.objectStorageKey, parentId: member.id });
      let topPoster: VariantCandidate | null = null;
      for (const c of stills) {
        const url = await sign(display, c.objectStorageKey);
        if (!url) continue;
        sizes.push({ longEdge: Math.max(c.width!, c.height!), url });
        if (
          !topPoster ||
          Math.max(c.width!, c.height!) > Math.max(topPoster.width!, topPoster.height!)
        ) {
          topPoster = c;
        }
      }
      sizes.sort((a, b) => a.longEdge - b.longEdge);
      if (!topPoster) continue;
      width = topPoster.width!;
      height = topPoster.height!;
      // The best playable stand-in. A video below the size floor has none,
      // and plays nowhere but its poster.
      const best = [...standIns].sort((a, b) => b.fidelity - a.fidelity)[0];
      if (best) {
        const url = await sign(display, best.objectStorageKey!);
        if (url) playback = { url, type: best.type ?? "video/webm" };
      }
    }

    items.push({
      id: publicItemId(share.item_id_salt, member.id),
      category,
      width,
      height,
      sizes,
      playback,
    });
  }
  return items;
}
