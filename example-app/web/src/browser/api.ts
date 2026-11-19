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
  EXAMPLE_CATEGORY,
  EXAMPLE_TYPE,
  LABEL_KEYS,
  EXPORT_PREFIX,
  SAMPLE_COLLECTIONS,
  SAMPLE_DERIVED_FROM,
  SAMPLE_FILES,
  TABLES,
  decodeCollection,
  decodeNote,
  encodeNote,
  textMetrics,
  type Collection,
  type CollectionItemRow,
  type CollectionRow,
  type Note,
} from "@example-app/common";
import { recordActivity } from "./activity.js";
import { MAX_IN_FLIGHT, RETRY_DELAYS_MS, createRequestGate } from "./request-gate.js";

/** The app's mount: `/` locally, `/apps/example-app/` in the cloud. */
const BASE = import.meta.env.BASE_URL;

/**
 * Every request to the app's own server waits here for a slot. A refresh of
 * every panel would otherwise overrun the cloud's Lambda concurrency limit.
 * See `request-gate.ts`.
 */
const gate = createRequestGate({ maxInFlight: MAX_IN_FLIGHT, retryDelaysMs: RETRY_DELAYS_MS });

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
  const headers: Record<string, string> = { ...init.headers };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const logged = init.log ?? url.replace(BASE, "/");
  // One fetch, logged on its own, so a throttled request shows in the Activity
  // table as its 503 followed by the retry's answer. Every body the page sends
  // through the gate is a string, so a retry can send it again.
  const attempt = async () => {
    const started = performance.now();
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
      return { status: res.status, ok: res.ok, text };
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
  };
  // Only the app's own server runs on Lambda. Signed S3 and CloudFront URLs
  // are absolute and skip the gate.
  const res = url.startsWith(BASE) ? await gate.send(attempt) : await attempt();
  let parsed: unknown = res.text;
  try {
    parsed = res.text ? JSON.parse(res.text) : null;
  } catch {
    // Not JSON: a file's content, or a proxy error page.
  }
  return { status: res.status, ok: res.ok, body: parsed as T };
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
  /** The platform's consent page for this app. Cloud only. */
  connectUrl?: string;
  /** The platform's page that lists and revokes outside clients. Cloud only. */
  connectionsUrl?: string;
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
  /** The source file's own dates; only a watched folder's files carry them. */
  original_created_at?: string | null;
  original_updated_at?: string | null;
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
    order: JSON.stringify([{ col: "created_at", dir: "desc" }]),
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

/** `GET /data/records/:id/metadata/:category`: the record's metadata row. */
export async function getMetadata(id: string): Promise<Record<string, unknown> | null> {
  return expectOk(
    await data<{ metadata: Record<string, unknown> | null }>(
      "GET",
      // The category, not the type: a type holds a slash, and API Gateway
      // decodes `%2F` into a real one, so an encoded type reaches the data
      // server as two segments and matches no route.
      `/data/records/${encodeURIComponent(id)}/metadata/${EXAMPLE_CATEGORY}`,
    ),
  ).metadata;
}

/** `POST /data/records/file-urls`: several signed URLs in one call, by record id. */
export async function fileUrls(ids: string[]): Promise<Record<string, { url: string }>> {
  return expectOk(
    await data<{ urls: Record<string, { url: string }> }>("POST", "/data/records/file-urls", {
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
 * Delete a file, then the note and the collection memberships of every record
 * the delete took.
 *
 * The platform deletes a record's derived copies, but it knows nothing of the
 * app's own rows that point at a record: a note and a `collection_items` row
 * name their file only by `record_id`. The app deletes those rows itself, from
 * the ids the record delete answers. The record goes first, so a failed delete
 * leaves the rows in place. Restoring the file does not bring them back.
 * Answers the ids of every record the delete took.
 */
export async function deleteFile(id: string): Promise<string[]> {
  const ids = await deleteRecord(id);
  // A table delete names the whole primary key, so one request per row.
  for (const recordId of ids) {
    await deleteNote(recordId);
    const items = await allRows(ITEMS, {
      where: JSON.stringify({ record_id: recordId }),
      select: "collection_id",
      order: JSON.stringify([{ col: "collection_id" }]),
      limit: 500,
    });
    for (const item of items) await removeFromCollection(String(item["collection_id"]), recordId);
  }
  return ids;
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

/** `GET /data/metadata/:category`: the category table, largest first. */
export async function queryMetadata(): Promise<Record<string, unknown>[]> {
  return expectOk(
    await data<{ rows: Record<string, unknown>[] }>(
      "GET",
      `/data/metadata/${EXAMPLE_CATEGORY}${q({
        order: JSON.stringify([{ col: "word_count", dir: "desc", nulls: "last" }]),
        limit: 10,
      })}`,
    ),
  ).rows;
}

/** `GET /data/metadata/:category?aggregate=…`: totals over the whole table. */
export async function metadataTotals(): Promise<Record<string, unknown>> {
  const body = expectOk(
    await data<{ groups: Record<string, unknown>[] }>(
      "GET",
      `/data/metadata/${EXAMPLE_CATEGORY}${q({
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
        order: JSON.stringify([{ col: "n", dir: "desc" }]),
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

/**
 * A note as read, with its row's `updated_at` stamp. The stamp is the
 * platform's sync clock, not a date: send it back unchanged as `ifUpdatedAt`
 * to write only if nobody else wrote the row since this read.
 */
export interface NoteState {
  readonly note: Note;
  readonly stamp: string;
}

/** The note's own columns plus the stamp: `select` without `aggregate`. */
const NOTE_COLUMNS = "record_id,note,pinned,updated_on,updated_at";

/** `GET /app-data/db/notes?where=…&select=…`: one record's note and its stamp. */
export async function getNote(recordId: string): Promise<NoteState | null> {
  const body = expectOk(
    await data<{ rows: Record<string, unknown>[] }>(
      "GET",
      `${NOTES}${q({
        where: JSON.stringify({ record_id: recordId }),
        select: NOTE_COLUMNS,
        limit: 1,
      })}`,
    ),
  );
  const row = body.rows[0];
  return row ? { note: decodeNote(row), stamp: String(row["updated_at"]) } : null;
}

/** The answer a conditional write gets when another write came first. */
function refuseIfSkipped(result: Result<{ skipped?: string } | null>): void {
  if (result.status === 409 && result.body?.skipped === "stale") {
    throw new ApiError(409, "the note changed since the file was opened; open it again");
  }
  if (result.ok && result.body?.skipped === "live") {
    throw new ApiError(409, "a note was added since the file was opened; open it again");
  }
  expectOk(result);
}

/**
 * `POST /app-data/db/notes` with `ifAbsent`: write a new note only if the
 * file has none. A note another tab or an MCP client wrote first stays, and
 * the call throws.
 *
 * `ifAbsent` also skips a key whose row was deleted, which is what makes it
 * safe for seeding: a reseed never brings back a row the person deleted. Here
 * the person asked for a new note, so a deleted one is written over with a
 * plain upsert, which clears the deletion.
 */
export async function addNote(note: Note): Promise<void> {
  const row = encodeNote(note);
  const result = await data<{ skipped?: string }>("POST", NOTES, {
    json: { row, ifAbsent: true },
  });
  if (result.ok && result.body?.skipped === "deleted") {
    expectOk(await data("POST", NOTES, { json: { row } }));
    return;
  }
  refuseIfSkipped(result);
}

/**
 * `PATCH /app-data/db/notes` with `ifUpdatedAt`: change the note only if
 * nobody wrote it since `stamp` was read. Throws on a 409 `stale`.
 */
export async function updateNote(
  recordId: string,
  patch: { note?: string; pinned?: boolean },
  stamp: string,
): Promise<void> {
  refuseIfSkipped(
    await data<{ skipped?: string }>("PATCH", NOTES, {
      json: {
        where: { record_id: recordId },
        patch: { ...patch, updated_on: new Date().toISOString() },
        ifUpdatedAt: stamp,
      },
    }),
  );
}

/** `DELETE /app-data/db/notes` with `ifUpdatedAt`: delete only an unchanged note. */
export async function deleteNoteIfUnchanged(recordId: string, stamp: string): Promise<void> {
  refuseIfSkipped(
    await data<{ skipped?: string }>("DELETE", NOTES, {
      json: { where: { record_id: recordId }, ifUpdatedAt: stamp },
    }),
  );
}

/**
 * `PATCH /app-data/db/notes`: pin or unpin one note. Setting a value, rather
 * than toggling the one read, needs no guard.
 */
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

/**
 * `DELETE /app-data/db/notes`. A record with no note is already in the state
 * the delete asks for, so a 404 that names a missing row counts as done. The
 * route's other 404s carry no `skipped` and still throw.
 */
export async function deleteNote(recordId: string): Promise<void> {
  const result = await data<{ skipped?: string }>("DELETE", NOTES, {
    json: { where: { record_id: recordId } },
  });
  if (result.status === 404 && result.body?.skipped === "missing") return;
  expectOk(result);
}

/**
 * Which files a note search covers. Each kind is a different form of the
 * `record_id` filter, and one `where` holds one filter per column, so a
 * search picks one.
 */
export type NoteFiles =
  /** Every file. */
  | { kind: "all" }
  /** These files only: `in` with a list. */
  | { kind: "page"; ids: readonly string[] }
  /** Every file but these: `not_in` with a list. */
  | { kind: "notPage"; ids: readonly string[] }
  /** The files in one collection: `in` with a subquery. */
  | { kind: "collection"; collectionId: string }
  /** The files in no collection: `not_in` with a subquery. */
  | { kind: "noCollection" };

/** Which notes a search asks for. Every field narrows the result. */
export interface NoteQuery {
  /** Text the note holds. */
  readonly text?: string;
  /** `contains` matches anywhere with `like`; `starts` uses `prefix`. */
  readonly match?: "contains" | "starts";
  /** Notes edited at or after this ISO 8601 instant, with `gte`. */
  readonly since?: string;
  /** Which files' notes; every file when omitted. */
  readonly files?: NoteFiles;
}

/** Rows per request when reading notes; `page_token` fetches the rest. */
export const NOTES_PAGE = 25;

/**
 * Every row a `GET /app-data/db/<table>` query matches, one page at a time.
 * The page token holds every joined table's key, so a joined query pages
 * without skipping or repeating a row.
 */
async function allRows(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  do {
    const page = expectOk(
      await data<{ rows: Record<string, unknown>[]; truncated: boolean; page_token?: string }>(
        "GET",
        `${path}${q({ ...params, page_token: pageToken })}`,
      ),
    );
    rows.push(...page.rows);
    pageToken = page.truncated && page.page_token ? page.page_token : undefined;
  } while (pageToken !== undefined);
  return rows;
}

/** Every note a `where` matches, newest first. */
async function allNotes(where: Record<string, unknown>): Promise<Note[]> {
  const rows = await allRows(NOTES, {
    where: JSON.stringify(where),
    order: JSON.stringify([
      { col: "updated_on", dir: "desc", nulls: "last" },
      { col: "record_id" },
    ]),
    limit: NOTES_PAGE,
  });
  return rows.map(decodeNote);
}

/** The `record_id` filter for one {@link NoteFiles} choice, or none. */
function recordIdFilter(files: NoteFiles): unknown {
  switch (files.kind) {
    case "all":
      return undefined;
    case "page":
      return { in: files.ids };
    case "notPage":
      // An empty `not_in` list excludes nothing, so it is left out.
      return files.ids.length > 0 ? { not_in: files.ids } : undefined;
    case "collection":
      // The subquery selects one column, whose type matches `record_id`.
      return {
        in: {
          table: TABLES.collectionItems,
          select: `${TABLES.collectionItems}.record_id`,
          where: { [`${TABLES.collectionItems}.collection_id`]: files.collectionId },
        },
      };
    case "noCollection":
      // A `not_in` subquery must select a NOT NULL column, which
      // `collection_items.record_id` is, as part of the primary key.
      return {
        not_in: {
          table: TABLES.collectionItems,
          select: `${TABLES.collectionItems}.record_id`,
        },
      };
  }
}

/**
 * `GET /app-data/db/notes`: search, pinned first, then newest.
 *
 * Two queries, because a boolean column has no ordering and the grammar has
 * no `or`: one for the pinned notes, one for the rest, each newest first and
 * each read to its last page.
 */
export async function searchNotes(query: NoteQuery = {}): Promise<Note[]> {
  const files = query.files ?? { kind: "all" };
  if (files.kind === "page" && files.ids.length === 0) return [];
  const where: Record<string, unknown> = {};
  if (query.text) {
    where["note"] =
      query.match === "starts"
        ? { prefix: query.text }
        : { like: `%${query.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` };
  }
  if (query.since) where["updated_on"] = { gte: query.since };
  const recordIds = recordIdFilter(files);
  if (recordIds !== undefined) where["record_id"] = recordIds;
  const [pinned, rest] = await Promise.all([
    allNotes({ ...where, pinned: { is: true } }),
    allNotes({ ...where, pinned: { is: false } }),
  ]);
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
// Collections: two more app tables, read with joins and subqueries
// ---------------------------------------------------------------------------

const COLLECTIONS = `/app-data/db/${TABLES.collections}`;
const ITEMS = `/app-data/db/${TABLES.collectionItems}`;
/** The two tables' names, as qualified column names spell them. */
const C = TABLES.collections;
const I = TABLES.collectionItems;

/** The join condition from `collection_items` to the collection it names. */
const itemOfCollection = { [`${I}.collection_id`]: { eq: { col: `${C}.id` } } };

/** A collection with the number of files in it. */
export interface CollectionSummary extends Collection {
  readonly files: number;
}

/**
 * `GET /app-data/db/collections` left-joined to `collection_items`, with a
 * count per collection.
 *
 * A left join keeps a collection with no files as one row whose joined
 * columns are null. Counting the joined `record_id`, rather than rows, counts
 * that row as 0. With `aggregate`, `select` is the grouping list.
 */
export async function listCollections(): Promise<CollectionSummary[]> {
  const body = expectOk(
    await data<{ groups: Record<string, unknown>[] }>(
      "GET",
      `${COLLECTIONS}${q({
        join: JSON.stringify([{ table: I, kind: "left", on: itemOfCollection }]),
        select: "id,name,archived",
        aggregate: JSON.stringify({ files: { fn: "count", col: `${I}.record_id` } }),
        order: JSON.stringify([{ col: "name" }, { col: "id" }]),
        limit: 500,
      })}`,
    ),
  );
  return body.groups.map((g) => ({ ...decodeCollection(g), files: Number(g["files"] ?? 0) }));
}

/** `POST /app-data/db/collections`: a new, empty collection. */
export async function createCollection(name: string): Promise<string> {
  const row: CollectionRow = {
    id: crypto.randomUUID(),
    name,
    archived: false,
    created_on: new Date().toISOString(),
  };
  expectOk(await data("POST", COLLECTIONS, { json: { row } }));
  return row.id;
}

/** `PATCH /app-data/db/collections`: rename, archive or unarchive one collection. */
export async function patchCollection(
  id: string,
  patch: { name?: string; archived?: boolean },
): Promise<void> {
  expectOk(await data("PATCH", COLLECTIONS, { json: { where: { id }, patch } }));
}

/**
 * Delete a collection: each of its `collection_items` rows, then the
 * collection row. A table delete names the whole primary key, so one request
 * per item.
 */
export async function deleteCollection(id: string): Promise<void> {
  const items = await allRows(ITEMS, {
    where: JSON.stringify({ collection_id: id }),
    select: "record_id",
    order: JSON.stringify([{ col: "record_id" }]),
    limit: 500,
  });
  for (const item of items) await removeFromCollection(id, String(item["record_id"]));
  expectOk(await data("DELETE", COLLECTIONS, { json: { where: { id } } }));
}

/**
 * `POST /app-data/db/collection_items`: put a file in a collection. A plain
 * upsert, so adding a file again, or after it was removed, writes one row.
 */
export async function addToCollection(collectionId: string, recordId: string): Promise<void> {
  const row: CollectionItemRow = {
    collection_id: collectionId,
    record_id: recordId,
    added_on: new Date().toISOString(),
  };
  expectOk(await data("POST", ITEMS, { json: { row } }));
}

/**
 * `DELETE /app-data/db/collection_items` by both key columns. A pair that is
 * already gone counts as done, as a note does in {@link deleteNote}.
 */
export async function removeFromCollection(collectionId: string, recordId: string): Promise<void> {
  const result = await data<{ skipped?: string }>("DELETE", ITEMS, {
    json: { where: { collection_id: collectionId, record_id: recordId } },
  });
  if (result.status === 404 && result.body?.skipped === "missing") return;
  expectOk(result);
}

/** The subquery "the open file sits in this collection", for `exists` and `not_exists`. */
function holdsFile(recordId: string) {
  return [{ table: I, where: { ...itemOfCollection, [`${I}.record_id`]: recordId } }];
}

/**
 * `GET /app-data/db/collections` with `exists`: the collections a file sits
 * in. `exists` tests the related rows without returning them, so each
 * collection comes back once however the file got there.
 */
export async function collectionsHolding(recordId: string): Promise<Collection[]> {
  const rows = await allRows(COLLECTIONS, {
    where: JSON.stringify({ exists: holdsFile(recordId) }),
    select: "id,name,archived",
    order: JSON.stringify([{ col: "name" }, { col: "id" }]),
    limit: 100,
  });
  return rows.map(decodeCollection);
}

/**
 * `GET /app-data/db/collections` with `not_exists`: the unarchived
 * collections a file is not in yet, which the Open file panel offers to add
 * it to.
 */
export async function collectionsLacking(recordId: string): Promise<Collection[]> {
  const rows = await allRows(COLLECTIONS, {
    where: JSON.stringify({ archived: { is: false }, not_exists: holdsFile(recordId) }),
    select: "id,name,archived",
    order: JSON.stringify([{ col: "name" }, { col: "id" }]),
    limit: 100,
  });
  return rows.map(decodeCollection);
}

/** One file in a collection, with its note and the other collections it sits in. */
export interface CollectionEntry {
  readonly recordId: string;
  readonly addedOn: string;
  /** The file's note, or null when it has none. */
  readonly note: string | null;
  /** The names of the other unarchived collections that hold the file. */
  readonly alsoIn: readonly string[];
}

/**
 * `GET /app-data/db/collection_items` with three left joins: one collection's
 * files, each file's note, and the other collections the file sits in.
 *
 * - `notes` joins on `record_id`. A file with no note gets null `notes.*`
 *   columns, and the joined key, `notes.record_id`, tells "no note" from a
 *   note whose text is null.
 * - `collection_items` joins again, under `as: "other"`, because the table is
 *   already in the query. `ne` keeps this collection's own row out.
 * - `collections` joins to `other` with `archived: false` inside `on`. A file
 *   whose other collection is archived keeps its row with null
 *   `collections.*` columns. The same filter in `where` would drop the file
 *   from the list.
 *
 * `other` is to-many, so each file comes back once per other collection, and
 * `limit` counts those joined rows. The query orders by the file first and
 * reads every page, then folds each file's rows into one entry.
 */
export async function collectionContents(collectionId: string): Promise<CollectionEntry[]> {
  const rows = await allRows(ITEMS, {
    where: JSON.stringify({ collection_id: { eq: collectionId } }),
    join: JSON.stringify([
      {
        table: TABLES.notes,
        kind: "left",
        on: { [`${TABLES.notes}.record_id`]: { eq: { col: `${I}.record_id` } } },
      },
      {
        table: I,
        as: "other",
        kind: "left",
        on: {
          "other.record_id": { eq: { col: `${I}.record_id` } },
          "other.collection_id": { ne: { col: `${I}.collection_id` } },
        },
      },
      {
        table: C,
        kind: "left",
        on: { [`${C}.id`]: { eq: { col: "other.collection_id" } }, [`${C}.archived`]: false },
      },
    ]),
    select: `record_id,added_on,${TABLES.notes}.record_id,${TABLES.notes}.note,${C}.id,${C}.name`,
    order: JSON.stringify([
      { col: "added_on", dir: "desc", nulls: "last" },
      { col: "record_id" },
      { col: `${C}.name`, nulls: "last" },
    ]),
    limit: 100,
  });
  const entries = new Map<
    string,
    { recordId: string; addedOn: string; note: string | null; alsoIn: string[] }
  >();
  for (const row of rows) {
    const recordId = String(row["record_id"]);
    let entry = entries.get(recordId);
    if (!entry) {
      const hasNote = row[`${TABLES.notes}.record_id`] != null;
      entry = {
        recordId,
        addedOn: typeof row["added_on"] === "string" ? row["added_on"] : "",
        note: hasNote ? String(row[`${TABLES.notes}.note`] ?? "") : null,
        alsoIn: [],
      };
      entries.set(recordId, entry);
    }
    if (row[`${C}.id`] != null) entry.alsoIn.push(String(row[`${C}.name`]));
  }
  return [...entries.values()];
}

/**
 * `GET /data/records?where={"id":{"in":[…]}}`: file names for record ids, in
 * batches of 100. A row query cannot join shared records, so the page reads
 * the names of the files a collection holds this way.
 */
export async function recordNames(ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const body = expectOk(
      await data<{ records: ExampleRecord[] }>(
        "GET",
        `/data/records${q({ where: JSON.stringify({ id: { in: batch } }), limit: batch.length })}`,
      ),
    );
    for (const r of body.records) names.set(r.id, r.original_filename ?? r.id);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

/** What a sample load did. */
export type SampleLoad = { loaded: true; files: number } | { loaded: false };

/**
 * Create the sample files, labels, notes and collections in
 * `common/src/sample-data.ts`.
 *
 * Records take ids the server assigns, so the load cannot key its files the
 * way it keys rows. Each sample file carries the bare `sample` flag instead,
 * and the load does nothing while a live file carries it. App rows go in with
 * `ifAbsent`, so a collection the person deleted stays deleted, and the load
 * puts no file in it.
 */
export async function loadSampleData(): Promise<SampleLoad> {
  const existing = expectOk(
    await data<{ records: ExampleRecord[] }>(
      "GET",
      `/data/records${q({ label: `${APP_ID}/${LABEL_KEYS.sample}`, limit: 1 })}`,
    ),
  );
  if (existing.records.length > 0) return { loaded: false };

  // A sample collection the person deleted stays deleted, so no file joins it.
  const deletedCollections = new Set<string>();
  for (const c of SAMPLE_COLLECTIONS) {
    const row: CollectionRow = {
      id: c.id,
      name: c.name,
      archived: c.archived,
      created_on: new Date().toISOString(),
    };
    const written = expectOk(
      await data<{ skipped?: string }>("POST", COLLECTIONS, { json: { row, ifAbsent: true } }),
    );
    if (written.skipped === "deleted") deletedCollections.add(c.id);
  }

  const sampleLabel = { key: LABEL_KEYS.sample, value: "" };
  const made = await Promise.all(
    SAMPLE_FILES.map(async (file) => {
      const record = await registerRecord({
        fileName: file.name,
        text: file.text,
        stored: await storeBytes(file.text),
        labels: [
          ...file.tags.map((value) => ({ key: LABEL_KEYS.tag, value })),
          ...(file.reviewed ? [{ key: LABEL_KEYS.reviewed, value: "" }] : []),
          sampleLabel,
        ],
      });
      return { file, record };
    }),
  );

  const source = made.find((m) => m.file.name === SAMPLE_DERIVED_FROM)!;
  const upper = source.file.text.toUpperCase();
  await registerRecord({
    fileName: SAMPLE_DERIVED_FROM.replace(/\.skexample$/, "-upper.skexample"),
    text: upper,
    stored: await storeBytes(upper),
    parentId: source.record.id,
    labels: [{ key: LABEL_KEYS.derived, value: "uppercase" }, sampleLabel],
  });

  const day = 24 * 60 * 60 * 1000;
  await Promise.all(
    made.flatMap(({ file, record }) => [
      ...(file.note
        ? [
            data("POST", NOTES, {
              json: {
                row: encodeNote({
                  recordId: record.id,
                  text: file.note.text,
                  pinned: file.note.pinned ?? false,
                  updatedOn: new Date(Date.now() - file.note.daysAgo * day).toISOString(),
                }),
                ifAbsent: true,
              },
            }).then(expectOk),
          ]
        : []),
      ...file.collections
        .filter((collectionId) => !deletedCollections.has(collectionId))
        .map((collectionId) =>
          data("POST", ITEMS, {
            json: {
              row: {
                collection_id: collectionId,
                record_id: record.id,
                added_on: new Date().toISOString(),
              } satisfies CollectionItemRow,
              ifAbsent: true,
            },
          }).then(expectOk),
        ),
    ]),
  );
  return { loaded: true, files: made.length + 1 };
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
 * Refresh sets: a snapshot loaded before it reloads. `utcOffset` is this
 * page's offset from UTC in minutes, so each day is the user's own day.
 */
export async function notesByDay(
  freshAfter: number,
): Promise<{ rows: NotesByDay[]; loadedAt: number }> {
  const utcOffset = -new Date().getTimezoneOffset();
  return expectOk(
    await call<{ rows: NotesByDay[]; loadedAt: number }>(
      "GET",
      `${BASE}api/notes-by-day${q({ freshAfter, utcOffset })}`,
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
  const notes = await searchNotes();
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
