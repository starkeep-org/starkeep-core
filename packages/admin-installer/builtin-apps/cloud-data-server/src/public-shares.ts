/**
 * Public shares: a link anyone may open, showing the stand-ins of the records
 * that carry one app label.
 *
 * A public share names an app label, `(app_id, label_key, label_value)`, and
 * the records carrying it are its members, resolved when a visitor asks. The
 * share copies nothing, so a record labelled later appears on the next page,
 * and a record deleted or unlabelled leaves it. Photos' albums are the first
 * use: an album is the `photos/album` label with the album's id.
 *
 * What a visitor may reach is fixed here and nowhere else:
 *
 * - **Members** are the owner's parentless, live, image or video records with
 *   the label, of a type the creating app may read.
 * - **Display children** are a member's stand-ins, and the image-category
 *   derived children of a video member (its poster frames) that carry a label
 *   in the creating app's `derived` key.
 * - **Nothing else.** No original bytes, no labels, no captions, no record ids,
 *   no metadata beyond a display size.
 *
 * Originals are never signed, whatever their size. That one rule keeps an
 * archived original out of reach (only parentless originals archive), keeps a
 * large original's egress off the link, and keeps a small original's EXIF and
 * GPS off it too: stand-ins carry no EXIF, and a self-canonical original shows
 * at its largest smaller stand-in instead. {@link PublicDisplaySet} enforces
 * the rule at the signer, so the viewer has no original to offer rather than
 * declining to show one.
 *
 * The anonymous route calls only {@link loadPublicSharePage} and
 * {@link projectPublicSharePage}. Neither reads anything from the request but
 * the link token and the cursor, and neither shares code with the general
 * records handler, which is how a request parameter cannot widen the query.
 *
 * See `~/projects/starkeep/proposal-public-sharing-albums-2026-11-05.md`,
 * section "Public shares".
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  canRead,
  isStandInOriginal,
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

/** The anonymous route: `GET /public-shares/<linkToken>/items`. */
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

export interface PublicShareRow {
  readonly id: string;
  readonly link_token: string;
  readonly owner_user_id: string;
  readonly app_id: string;
  readonly label_key: string;
  readonly label_value: string;
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
  "label_key",
  "label_value",
  "title",
  "item_id_salt",
  "created_at_ms",
  "expires_at_ms",
] as const;

/** The link token in `/public-shares/<token>/items`, or null for any other path. */
export function publicItemsToken(rawPath: string): string | null {
  if (!rawPath.startsWith(PUBLIC_SHARES_PREFIX)) return null;
  const m = rawPath.match(/^\/public-shares\/([^/]+)\/items$/);
  if (!m || !LINK_TOKEN_PATTERN.test(m[1]!)) return null;
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

/** What the owner's routes answer for one public share. Never the salt. */
export function ownerView(share: PublicShareRow) {
  return {
    id: share.id,
    linkToken: share.link_token,
    labelKey: share.label_key,
    labelValue: share.label_value,
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
  source?: { labelKey: string; labelValue: string },
): Promise<PublicShareRow[]> {
  let q = compiler
    .selectFrom(SHARES_TABLE)
    .select([...SHARE_COLUMNS])
    .where("owner_user_id", "=", owner.userId)
    .where("app_id", "=", owner.appId);
  if (source) {
    q = q.where("label_key", "=", source.labelKey).where("label_value", "=", source.labelValue);
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
  labelKey: string;
  labelValue: string;
  title: string;
  nowMs: number;
  expiresAtMs: number | null;
}): PublicShareRow {
  return {
    id: randomUUID(),
    link_token: newLinkToken(),
    owner_user_id: input.ownerUserId,
    app_id: input.appId,
    label_key: input.labelKey,
    label_value: input.labelValue,
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
    if (key.split("/").includes("..")) return { ok: false, status: 400, message: "Invalid key" };
    const m = key.match(
      /^shared\/([A-Za-z0-9_-]+)\/([a-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/,
    );
    if (!m) return { ok: false, status: 400, message: "Not a shared key" };
    if (m[1] !== this.ownerUserId) {
      return { ok: false, status: 403, message: "Forbidden (another user's key)" };
    }
    if (this.originals.has(key)) {
      return { ok: false, status: 403, message: "Forbidden (an original's key)" };
    }
    if (!this.admitted.has(key)) {
      return { ok: false, status: 403, message: "Forbidden (not a display child of this page)" };
    }
    return { ok: true };
  }
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
  const readable = [...grants.readableTypes].filter((t) => PUBLIC_CATEGORIES.has(typeCategory(t)));
  if (readable.length === 0) {
    return {
      members: [],
      summaries: new Map(),
      posters: new Map(),
      displayFiles: [],
      nextCursor: null,
      truncated: false,
    };
  }

  // The membership, from the reverse index. The value matches by equality.
  const ids: StarkeepId[] = [];
  let labelCursor: string | undefined;
  let truncated = false;
  for (;;) {
    const plan = planFindByLabel({
      appId: share.app_id,
      key: share.label_key,
      value: share.label_value,
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
      { column: "type", predicate: { op: "in", values: readable.sort() } },
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
    const summary = page.summaries.get(member.id);
    // Stand-ins only: never the size an original answers itself.
    const standIns = (summary?.sizes ?? []).filter(
      (s) =>
        (s.role === "canonical" || s.role === "smaller") &&
        s.recordId !== null &&
        s.recordId !== member.id &&
        s.objectStorageKey !== null &&
        s.objectStorageKey !== member.objectStorageKey &&
        !missing.has(s.objectStorageKey),
    );
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
