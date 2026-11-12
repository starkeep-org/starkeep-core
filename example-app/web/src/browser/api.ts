/**
 * Every operation the example performs, one function each.
 *
 * This file is the reference for the routes `docs/authoring-an-app.md` lists.
 * Each function names the route it calls, and every data-plane call goes
 * through the app's signing proxy at `api/local-data/…`. The proxy forwards to
 * local-data-server on a computer and to the cloud data server in the cloud,
 * so this file has no idea which surface it runs on. The two exceptions are
 * the presigned upload PUTs, which go straight to the URL the data server
 * signed.
 *
 * Every request is logged to the Activity table, with its status, so even an
 * operation with no other visible effect shows up on the page.
 */

import {
  APP_ID,
  EXAMPLE_TYPE,
  LABEL_KEYS,
  EXPORT_PREFIX,
  TABLES,
  decodeNote,
  encodeNote,
  textMetrics,
  type Note,
} from "@example-app/common";
import { recordActivity } from "./activity.js";

/** The app's mount: `/` locally, `/apps/example-app/` in the cloud. */
const BASE = import.meta.env.BASE_URL;

/** What every call returns: the HTTP status and the parsed JSON body. */
export interface Result<T> {
  readonly status: number;
  readonly ok: boolean;
  readonly body: T;
}

/** A failed call, carrying the server's message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  method: string,
  url: string,
  init: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; log?: string } = {},
): Promise<Result<T>> {
  const started = performance.now();
  const headers: Record<string, string> = { ...init.headers };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const logged = init.log ?? url.replace(BASE, "/");
  try {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    recordActivity({
      method,
      path: logged,
      status: res.status,
      ms: Math.round(performance.now() - started),
      at: new Date(),
    });
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: a file's content, or a proxy error page.
    }
    return { status: res.status, ok: res.ok, body: parsed as T };
  } catch (err) {
    recordActivity({
      method,
      path: logged,
      status: "error",
      ms: Math.round(performance.now() - started),
      at: new Date(),
    });
    throw err;
  }
}

/** A data-plane call through the signing proxy. */
function data<T>(method: string, path: string, init: Parameters<typeof call>[2] = {}) {
  return call<T>(method, `${BASE}api/local-data${path}`, { ...init, log: path });
}

/** Throw unless the call succeeded, and answer its body. */
function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    const body = result.body as { error?: unknown; detail?: unknown } | null;
    const message =
      [body?.error, body?.detail].filter(Boolean).join(": ") || `HTTP ${result.status}`;
    throw new ApiError(result.status, String(message));
  }
  return result.body;
}

function q(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The headers a presigned PUT must carry: each one is inside the signature. */
function presignedPutHeaders(
  contentType: string,
  presign: { checksumSha256?: string; storageClass?: string; tagging?: Record<string, string> },
): Record<string, string> {
  return {
    "Content-Type": contentType,
    ...(presign.checksumSha256 ? { "x-amz-checksum-sha256": presign.checksumSha256 } : {}),
    ...(presign.storageClass ? { "x-amz-storage-class": presign.storageClass } : {}),
    ...(presign.tagging && Object.keys(presign.tagging).length > 0
      ? {
          "x-amz-tagging": Object.entries(presign.tagging)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&"),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  apiGatewayUrl?: string;
  region?: string;
  userPoolId?: string;
}

/** `GET /starkeep-runtime-config`, the app's own route: which surface this is. */
export async function runtimeConfig(): Promise<RuntimeConfig> {
  return expectOk(await call<RuntimeConfig>("GET", `${BASE}starkeep-runtime-config`));
}

/** `GET /api/session`: who is signed in. The local surface has no session. */
export async function session(): Promise<{ signedIn: boolean; email?: string }> {
  return expectOk(await call<{ signedIn: boolean; email?: string }>("GET", `${BASE}api/session`));
}

/** `POST /api/session/refresh`: trade the refresh cookie for a new id token. */
export async function refreshSession(): Promise<Result<unknown>> {
  return call("POST", `${BASE}api/session/refresh`);
}

/** `POST /api/session/sign-out`: clear the cookies; answers the platform's sign-out page. */
export async function signOut(): Promise<{ signOutUrl?: string }> {
  return expectOk(await call<{ signOutUrl?: string }>("POST", `${BASE}api/session/sign-out`));
}

/**
 * `POST /api/echo`, the app's own JWT-gated route (`web/src/server/echo.ts`).
 *
 * In the cloud the gateway's JWT authorizer guards the route, and it wants
 * the signed-in user's token as a Bearer credential, which a cookie cannot
 * carry. `GET /api/session/token` hands the page a short-lived one. Locally
 * the route is same-origin and needs no token.
 */
export async function callJwtRoute(
  cloud: boolean,
  message: string,
): Promise<Result<{ ok?: boolean; echo?: { message?: unknown } | null }>> {
  const headers: Record<string, string> = {};
  if (cloud) {
    const { accessToken } = expectOk(
      await call<{ accessToken?: string }>("GET", `${BASE}api/session/token`),
    );
    if (!accessToken) throw new ApiError(401, "The session handed out no token");
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  return call("POST", `${BASE}api/echo`, { json: { message }, headers });
}

/**
 * `POST /data/records` for a type the app was not granted. The data server
 * refuses it with 403 before anything is written, which is the point.
 */
export async function grantCheck(): Promise<Result<unknown>> {
  return data("POST", "/data/records", {
    json: {
      type: "text/txt",
      fileName: "grant-check.txt",
      contentHash: "0".repeat(64),
      sizeBytes: 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Example files: shared records
// ---------------------------------------------------------------------------

export interface ExampleRecord {
  id: string;
  type: string;
  original_filename: string | null;
  size_bytes: number | null;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  metadata?: Record<string, unknown> | null;
  labels?: { app_id: string; key: string; value: string; label: string }[];
}

interface StoredBytes {
  key: string;
  contentHash: string;
  sizeBytes: number;
}

/** `POST /data/files?type=…`: store small bytes inline, answering their hash. */
async function storeBytes(text: string): Promise<StoredBytes> {
  return expectOk(
    await data<StoredBytes>("POST", `/data/files${q({ type: EXAMPLE_TYPE })}`, {
      body: text,
      headers: { "Content-Type": "text/plain" },
    }),
  );
}

/**
 * `POST /data/records`: register stored bytes as a record, with its metadata
 * inline so the record never syncs without it.
 */
async function registerRecord(input: {
  fileName: string;
  text: string;
  stored: { contentHash: string; sizeBytes: number };
  parentId?: string;
  labels?: { key: string; value?: string }[];
}): Promise<ExampleRecord> {
  const body = expectOk(
    await data<{ record: ExampleRecord }>("POST", "/data/records", {
      json: {
        type: EXAMPLE_TYPE,
        fileName: input.fileName,
        contentType: "text/plain",
        contentHash: input.stored.contentHash,
        sizeBytes: input.stored.sizeBytes,
        metadata: textMetrics(input.text),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(input.labels ? { labels: input.labels } : {}),
      },
    }),
  );
  return body.record;
}

/** Store bytes, then register the record. */
export async function createFromText(fileName: string, text: string): Promise<ExampleRecord> {
  return registerRecord({ fileName, text, stored: await storeBytes(text) });
}

/**
 * `POST /files/presign`, `PUT <url>`, then `POST /data/records`: the upload
 * path for a file of any size, which keeps the bytes off the data server's
 * request body.
 */
export async function uploadFile(file: File): Promise<ExampleRecord> {
  const bytes = await file.arrayBuffer();
  const contentHash = await sha256Hex(bytes);
  const presign = expectOk(
    await data<{
      url: string;
      checksumSha256?: string;
      storageClass?: string;
      tagging?: Record<string, string>;
    }>("POST", "/files/presign", {
      json: { type: EXAMPLE_TYPE, contentHash, contentType: "text/plain" },
    }),
  );
  expectOk(
    await call("PUT", presign.url, {
      body: bytes,
      headers: presignedPutHeaders("text/plain", presign),
      log: "PUT <presigned upload URL>",
    }),
  );
  const text = new TextDecoder().decode(bytes);
  return registerRecord({
    fileName: file.name,
    text,
    stored: { contentHash, sizeBytes: bytes.byteLength },
  });
}

/** `GET /data/records/:id/file-url`, then the URL itself: a file's text. */
export async function readContent(id: string): Promise<string> {
  const { url } = expectOk(
    await data<{ url: string }>("GET", `/data/records/${encodeURIComponent(id)}/file-url`),
  );
  const res = await call<string>("GET", url, { log: "GET <signed file URL>" });
  if (!res.ok) throw new ApiError(res.status, "The file's content could not be read");
  return typeof res.body === "string" ? res.body : JSON.stringify(res.body);
}

/**
 * A derived copy: the record's text in upper case, linked to its source by
 * `parentId` and marked with the advisory `derived` label at creation.
 */
export async function deriveUppercase(record: ExampleRecord): Promise<ExampleRecord> {
  const text = (await readContent(record.id)).toUpperCase();
  const name = `${(record.original_filename ?? "file").replace(/\.skexample$/, "")}-upper.skexample`;
  return registerRecord({
    fileName: name,
    text,
    stored: await storeBytes(text),
    parentId: record.id,
    labels: [{ key: LABEL_KEYS.derived, value: "uppercase" }],
  });
}

export type RecordFilter =
  | { kind: "all" }
  | { kind: "originals" }
  | { kind: "children"; parentId: string }
  | { kind: "tag"; value: string };

/**
 * `GET /data/records`, newest first, with metadata and labels. A query that
 * names no type answers the app's granted types, which here is the one.
 */
export async function listRecords(
  filter: RecordFilter,
  pageToken?: string,
): Promise<{ records: ExampleRecord[]; nextCursor: string | null }> {
  const params: Record<string, string | number | undefined> = {
    include: "metadata,labels",
    order: "created_at.desc",
    limit: 10,
    page_token: pageToken,
  };
  if (filter.kind === "originals") params["notLabel"] = `${APP_ID}/${LABEL_KEYS.derived}`;
  if (filter.kind === "children") params["where"] = JSON.stringify({ parent_id: filter.parentId });
  if (filter.kind === "tag") {
    params["label"] = `${APP_ID}/${LABEL_KEYS.tag}`;
    params["labelValue"] = filter.value;
  }
  const body = expectOk(
    await data<{ records: ExampleRecord[]; nextCursor?: string | null }>(
      "GET",
      `/data/records${q(params)}`,
    ),
  );
  return { records: body.records, nextCursor: body.nextCursor ?? null };
}

/** `GET /data/records?aggregate=…`: a count, without paging. */
export async function countRecords(): Promise<number> {
  const body = expectOk(
    await data<{ groups: { total: number | string }[] }>(
      "GET",
      `/data/records${q({ aggregate: JSON.stringify({ total: { fn: "count" } }) })}`,
    ),
  );
  return Number(body.groups[0]?.total ?? 0);
}

/** `GET /data/records/:id`: one record. */
export async function getRecord(id: string): Promise<ExampleRecord> {
  return expectOk(
    await data<{ record: ExampleRecord }>(
      "GET",
      `/data/records/${encodeURIComponent(id)}${q({ include: "labels" })}`,
    ),
  ).record;
}

/** `GET /data/records/:id/metadata/:typeId`: the record's metadata row. */
export async function getMetadata(id: string): Promise<Record<string, unknown> | null> {
  return expectOk(
    await data<{ metadata: Record<string, unknown> | null }>(
      "GET",
      // The type holds a slash, so it travels encoded as one path segment.
      `/data/records/${encodeURIComponent(id)}/metadata/${encodeURIComponent(EXAMPLE_TYPE)}`,
    ),
  ).metadata;
}

/** `POST /data/records/file-urls`: several signed URLs in one call. */
export async function fileUrls(ids: string[]): Promise<Record<string, unknown>> {
  return expectOk(
    await data<{ urls: Record<string, unknown> }>("POST", "/data/records/file-urls", {
      json: { ids },
    }),
  ).urls;
}

/**
 * `DELETE /data/records/:id`. Deleting a record deletes its derived copies
 * with it: deleting a file also deletes its uppercase copy. Answers the id of
 * every record the delete took, the file's own first.
 */
export async function deleteRecord(id: string): Promise<string[]> {
  return expectOk(
    await data<{ ids: string[] }>("DELETE", `/data/records/${encodeURIComponent(id)}`),
  ).ids;
}

/**
 * Delete a file, then the note of every record the delete took.
 *
 * The platform deletes a record's derived copies, but it knows nothing of the
 * app's own rows that point at a record: a note names its file only by
 * `record_id`. The app deletes those rows itself, from the ids the record
 * delete answers. The record goes first, so a failed delete leaves the note in
 * place. Restoring the file does not bring its note back.
 */
export async function deleteFile(id: string): Promise<void> {
  const ids = await deleteRecord(id);
  // The table delete matches one value per column, so one request per note.
  for (const recordId of ids) await deleteNote(recordId);
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** `POST /data/records/:id/metadata`: recompute the counts and write them. */
export async function recomputeMetadata(id: string): Promise<void> {
  const text = await readContent(id);
  expectOk(
    await data("POST", `/data/records/${encodeURIComponent(id)}/metadata`, {
      json: { typeId: EXAMPLE_TYPE, metadata: textMetrics(text) },
    }),
  );
}

/** `GET /data/metadata/example`: the category table, largest first. */
export async function queryMetadata(): Promise<Record<string, unknown>[]> {
  return expectOk(
    await data<{ rows: Record<string, unknown>[] }>(
      "GET",
      `/data/metadata/example${q({ order: "word_count.desc.nullslast", limit: 10 })}`,
    ),
  ).rows;
}

/** `GET /data/metadata/example?aggregate=…`: totals over the whole table. */
export async function metadataTotals(): Promise<Record<string, unknown>> {
  const body = expectOk(
    await data<{ groups: Record<string, unknown>[] }>(
      "GET",
      `/data/metadata/example${q({
        aggregate: JSON.stringify({
          files: { fn: "count" },
          words: { fn: "sum", col: "word_count" },
          longest: { fn: "max", col: "line_count" },
        }),
      })}`,
    ),
  );
  return body.groups[0] ?? {};
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** `POST /data/labels`: add tag values, and optionally the bare `reviewed` flag. */
export async function addLabels(
  recordId: string,
  tags: string[],
  reviewed: boolean,
): Promise<void> {
  const labels: { recordId: string; key: string; value: string }[] = tags.map((value) => ({
    recordId,
    key: LABEL_KEYS.tag,
    value,
  }));
  if (reviewed) labels.push({ recordId, key: LABEL_KEYS.reviewed, value: "" });
  expectOk(await data("POST", "/data/labels", { json: { labels } }));
}

/** `POST /data/labels/values`: make the tag key hold exactly these values. */
export async function setTags(recordId: string, values: string[]): Promise<void> {
  expectOk(
    await data("POST", "/data/labels/values", {
      json: { labels: [{ recordId, key: LABEL_KEYS.tag, values }] },
    }),
  );
}

/** `POST /data/labels/retract`: one value, or the whole key when `value` is omitted. */
export async function retractLabel(recordId: string, key: string, value?: string): Promise<void> {
  expectOk(
    await data("POST", "/data/labels/retract", {
      json: { labels: [{ recordId, key, ...(value !== undefined ? { value } : {}) }] },
    }),
  );
}

/** `GET /data/labels?…&aggregate=…`: records per tag value. */
export async function tagCounts(): Promise<{ value: string; n: number }[]> {
  const body = expectOk(
    await data<{ groups: { value: string; n: number | string }[] }>(
      "GET",
      `/data/labels${q({
        where: JSON.stringify({ app_id: APP_ID, key: LABEL_KEYS.tag }),
        select: "value",
        aggregate: JSON.stringify({ n: { fn: "count" } }),
        order: "n.desc",
      })}`,
    ),
  );
  return body.groups.map((g) => ({ value: g.value, n: Number(g.n) }));
}

export interface LabelKey {
  app_id: string;
  key: string;
  label: string;
  description: string | null;
}

/** `GET /data/label-keys`: every installed app's declared keys. */
export async function labelKeys(): Promise<LabelKey[]> {
  return expectOk(await data<{ labelKeys: LabelKey[] }>("GET", "/data/label-keys")).labelKeys;
}

// ---------------------------------------------------------------------------
// Notes: the app's own table
// ---------------------------------------------------------------------------

const NOTES = `/app-data/db/${TABLES.notes}`;

/** `GET /app-data/db/notes?where=…`: one record's note. */
export async function getNote(recordId: string): Promise<Note | null> {
  const body = expectOk(
    await data<{ rows: Record<string, unknown>[] }>(
      "GET",
      `${NOTES}${q({ where: JSON.stringify({ record_id: recordId }), limit: 1 })}`,
    ),
  );
  return body.rows[0] ? decodeNote(body.rows[0]) : null;
}

/** `POST /app-data/db/notes`: write a note. An existing row is replaced. */
export async function saveNote(note: Note): Promise<void> {
  expectOk(await data("POST", NOTES, { json: { row: encodeNote(note) } }));
}

/** `PATCH /app-data/db/notes`: change some columns of one note. */
export async function patchNote(
  recordId: string,
  patch: { note?: string; pinned?: boolean },
): Promise<void> {
  expectOk(
    await data("PATCH", NOTES, {
      json: {
        where: { record_id: recordId },
        patch: { ...patch, updated_on: new Date().toISOString() },
      },
    }),
  );
}

/** `DELETE /app-data/db/notes`. */
export async function deleteNote(recordId: string): Promise<void> {
  expectOk(await data("DELETE", NOTES, { json: { where: { record_id: recordId } } }));
}

/**
 * `GET /app-data/db/notes`: search, pinned first, then newest.
 *
 * Two requests, because a boolean column has no ordering and the grammar has
 * no `or`: one for the pinned notes, one for the rest, each newest first.
 */
export async function searchNotes(search: string): Promise<Note[]> {
  const text = search ? { note: { like: `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` } } : {};
  const page = async (pinned: boolean) =>
    expectOk(
      await data<{ rows: Record<string, unknown>[] }>(
        "GET",
        `${NOTES}${q({
          where: JSON.stringify({ ...text, pinned: { is: pinned } }),
          order: "updated_on.desc.nullslast",
          limit: 50,
        })}`,
      ),
    ).rows.map(decodeNote);
  const [pinned, rest] = await Promise.all([page(true), page(false)]);
  return [...pinned, ...rest];
}

/** `GET /app-data/db/notes?aggregate=…`: how many notes are pinned. */
export async function pinnedCount(): Promise<number> {
  const body = expectOk(
    await data<{ groups: { n: number | string }[] }>(
      "GET",
      `${NOTES}${q({
        where: JSON.stringify({ pinned: { is: true } }),
        aggregate: JSON.stringify({ n: { fn: "count" } }),
      })}`,
    ),
  );
  return Number(body.groups[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Analysis: SQL over a snapshot of the app's own table
// ---------------------------------------------------------------------------

export interface NotesByDay {
  day: string | null;
  notes: number;
  pinned: number;
  average_length: number | null;
}

/**
 * `GET /api/notes-by-day`: notes per day, in SQL the app's server runs over a
 * cached snapshot (`web/src/server/analysis.ts`). `freshAfter` is the floor a
 * Refresh sets: a snapshot loaded before it reloads.
 */
export async function notesByDay(
  freshAfter: number,
): Promise<{ rows: NotesByDay[]; loadedAt: number }> {
  return expectOk(
    await call<{ rows: NotesByDay[]; loadedAt: number }>(
      "GET",
      `${BASE}api/notes-by-day${q({ freshAfter })}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Note exports: the app's own files
// ---------------------------------------------------------------------------

export interface NoteExport {
  sub_key: string;
  size_bytes: number;
  mime_type: string;
  original_filename: string | null;
  created_at: string;
}

/**
 * Save every note as one private JSON file: `POST /app-data/files/presign`,
 * `PUT <url>`, then `POST /app-data/files/<subKey>/record`.
 */
export async function saveExport(): Promise<string> {
  const notes = await searchNotes("");
  const bytes = new TextEncoder().encode(JSON.stringify({ notes }, null, 2));
  const contentHash = await sha256Hex(bytes.buffer as ArrayBuffer);
  const name = `notes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const subKey = `${EXPORT_PREFIX}${name}`;
  const presign = expectOk(
    await data<{ url: string; checksumSha256?: string }>("POST", "/app-data/files/presign", {
      json: { subKey, contentType: "application/json", contentHash },
    }),
  );
  expectOk(
    await call("PUT", presign.url, {
      body: bytes,
      headers: presignedPutHeaders("application/json", presign),
      log: "PUT <presigned upload URL>",
    }),
  );
  expectOk(
    await data("POST", `/app-data/files/${subKey}/record`, {
      json: {
        contentHash,
        mimeType: "application/json",
        sizeBytes: bytes.byteLength,
        originalFilename: name,
      },
    }),
  );
  return subKey;
}

/**
 * `GET /app-data/files?prefix=exports/`: every export file, one page at a
 * time. A page holds 30 files by default, and the listing answers a
 * `page_token` while more remain.
 */
export async function listExports(): Promise<NoteExport[]> {
  const files: NoteExport[] = [];
  let pageToken: string | undefined;
  do {
    const page = expectOk(
      await data<{ files: NoteExport[]; truncated: boolean; page_token: string | null }>(
        "GET",
        `/app-data/files${q({ prefix: EXPORT_PREFIX, page_token: pageToken })}`,
      ),
    );
    files.push(...page.files);
    pageToken = page.truncated && page.page_token ? page.page_token : undefined;
  } while (pageToken !== undefined);
  return files;
}

/** `GET /app-data/files/<subKey>`, then the URL: one export's content. */
export async function openExport(subKey: string): Promise<string> {
  const { url } = expectOk(await data<{ url: string }>("GET", `/app-data/files/${subKey}`));
  const res = await call<unknown>("GET", url, { log: "GET <signed file URL>" });
  if (!res.ok) throw new ApiError(res.status, "The export could not be read");
  return typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2);
}

/** `POST /app-data/file-urls`: several export URLs in one call. */
export async function exportUrls(subKeys: string[]): Promise<Record<string, string>> {
  return expectOk(
    await data<{ urls: Record<string, string> }>("POST", "/app-data/file-urls", {
      json: { subKeys },
    }),
  ).urls;
}

/** `DELETE /app-data/files/<subKey>`. */
export async function deleteExport(subKey: string): Promise<void> {
  expectOk(await data("DELETE", `/app-data/files/${subKey}`));
}

// ---------------------------------------------------------------------------
// Deleted
// ---------------------------------------------------------------------------

/** `GET /data/records?deleted=only&updated_after=…`: deletions since an instant. */
export async function deletedSince(since: string): Promise<ExampleRecord[]> {
  return expectOk(
    await data<{ records: ExampleRecord[] }>(
      "GET",
      `/data/records${q({ deleted: "only", updated_after: since, limit: 20 })}`,
    ),
  ).records;
}

/** `POST /data/records/:id/restore`: take a delete back. */
export async function restoreRecord(id: string): Promise<void> {
  expectOk(await data("POST", `/data/records/${encodeURIComponent(id)}/restore`, { json: {} }));
}

/** `GET /data/trash`: how long a deleted record stays recoverable. */
export async function trashPolicy(): Promise<{ retention_days: number | null }> {
  return expectOk(await data<{ retention_days: number | null }>("GET", "/data/trash"));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `GET /data/types`: record counts per type the app may read. */
export async function types(): Promise<{ record_type: string; count: number }[]> {
  return expectOk(
    await data<{ types: { record_type: string; count: number }[] }>("GET", "/data/types"),
  ).types;
}

// ---------------------------------------------------------------------------
// Public links
// ---------------------------------------------------------------------------

export interface PublicShare {
  id: string;
  linkToken: string;
  source: { kind: string; recordId?: string };
  title: string;
  expiresAtMs: number | null;
}

/** `GET /data/public-shares`: this app's links. */
export async function listShares(): Promise<Result<{ publicShares?: PublicShare[] }>> {
  return data("GET", "/data/public-shares");
}

/** `POST /data/public-shares`: a week-long link to one file. */
export async function createShare(recordId: string, title: string): Promise<PublicShare> {
  return expectOk(
    await data<{ publicShare: PublicShare }>("POST", "/data/public-shares", {
      json: { source: { kind: "record", recordId }, title, lifetime: "7d" },
    }),
  ).publicShare;
}

/** `DELETE /data/public-shares/:id`: revoke a link. */
export async function revokeShare(id: string): Promise<void> {
  expectOk(await data("DELETE", `/data/public-shares/${encodeURIComponent(id)}`));
}

/** The app's own route: the cloud address public links live under, if known. */
export async function cloudAddress(): Promise<string | null> {
  const res = await call<{ url: string | null }>("GET", `${BASE}api/cloud-address`);
  return res.ok ? res.body.url : null;
}
