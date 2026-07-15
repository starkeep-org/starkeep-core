/**
 * Server-only client that talks to the local-data-server *as Starkeep Drive*.
 *
 * A browser can't hold Drive's HMAC secret, so all data access goes through
 * these server-side helpers: read Drive's `hmac_secret` from the local-data-
 * server's SQLite registry, sign each request, and call the LDS `/data/*`
 * endpoints. The LDS then enforces `appCanRead(starkeep-drive)` — which, via
 * Drive's all-access (User-Data-Owner) grant, spans every extension plus the
 * Drive-only `other` catch-all. No bypass: Drive reads through the exact same
 * per-app access path as any installed app.
 */

import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dataDbPath } from "@starkeep/app-client";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

// Compile-only Kysely instance (DummyDriver never executes); statements run
// synchronously through node:sqlite. Local to this file because the drive app
// is bundled by Turbopack, which can't consume @starkeep/storage-sqlite's
// live TS source (where the shared compiler lives).
const sqliteCompiler = new Kysely<Record<string, Record<string, unknown>>>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const DRIVE_APP_ID = "starkeep-drive";
const DATA_DB_PATH = dataDbPath();
export const LDS_URL =
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";

/**
 * Read Drive's HMAC secret from the local-data-server's SQLite registry.
 * Opened read-only with a short busy_timeout and closed immediately, so a
 * concurrent LDS write doesn't fail this read (the LDS DB is not in WAL mode).
 */
function readDriveSecret(): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(DATA_DB_PATH, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    const query = sqliteCompiler
      .selectFrom("shared_app_registry")
      .select("hmac_secret")
      .where("app_id", "=", DRIVE_APP_ID)
      .where("status", "=", "active")
      .compile();
    const row = db
      .prepare(query.sql)
      .get(...(query.parameters as string[])) as { hmac_secret: string } | undefined;
    return row?.hmac_secret ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Build the signed headers for a GET to the local-data-server as Drive. The
 * HMAC binds method + path + a timestamp (empty body for GET), matching the LDS
 * `validateAppHmac` / `@starkeep/app-client`'s `signRequest`. `path` may carry
 * a query string; the signature is over the pathname only (query stripped),
 * which is what the LDS canonicalizes too.
 */
function signedDriveGetHeaders(secret: string, path: string): Record<string, string> {
  const ts = Date.now();
  const pathname = path.split("?")[0]!;
  const input = `${DRIVE_APP_ID}:GET:${pathname}:${ts}:`;
  const sig = createHmac("sha256", secret).update(input).digest("hex");
  return {
    "X-Starkeep-App-Id": DRIVE_APP_ID,
    "X-Starkeep-App-Sig": sig,
    "X-Starkeep-App-Ts": String(ts),
  };
}

export class DriveNotInstalledError extends Error {
  constructor() {
    super(
      "Starkeep Drive is not installed locally (no hmac_secret in the local-data-server registry). Is the local-data-server running?",
    );
    this.name = "DriveNotInstalledError";
  }
}

/**
 * GET a local-data-server `/data/*` path signed as Starkeep Drive. The HMAC
 * binds method + path + timestamp (empty body for GET), matching the LDS
 * `validateAppHmac`.
 */
async function ldsGet<T>(path: string): Promise<T> {
  const secret = readDriveSecret();
  if (!secret) throw new DriveNotInstalledError();
  const res = await fetch(`${LDS_URL}${path}`, {
    headers: signedDriveGetHeaders(secret, path),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`local-data-server ${path} → ${res.status} ${res.statusText} ${body}`);
  }
  return (await res.json()) as T;
}

export interface DriveRecord {
  id: string;
  kind: string;
  /** The record's file extension (e.g. "jpg", "md", "xyz"). */
  type: string;
  /** Derived organizational category (e.g. "image", "document", "other"). */
  category: string;
  origin_app_id: string;
  created_at: string;
  updated_at: string;
  version: number;
  content_hash: string | null;
  object_storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  original_filename: string | null;
  parent_id: string | null;
}

export interface DriveTypeSummary {
  record_type: string;
  count: number;
  latest_updated: string;
}

export async function listRecords(type?: string): Promise<DriveRecord[]> {
  const qs = new URLSearchParams({ limit: "1000" });
  if (type) qs.set("type", type);
  const { records } = await ldsGet<{ records: DriveRecord[] }>(
    `/data/records?${qs.toString()}`,
  );
  return records;
}

export async function listTypes(): Promise<DriveTypeSummary[]> {
  const { types } = await ldsGet<{ types: DriveTypeSummary[] }>("/data/types");
  return types;
}

export interface FileUrl {
  url: string;
  source: "local" | "remote";
  mimeType: string | null;
  sizeBytes: number | null;
  expiresIn: number;
}

/**
 * Resolve a record's bytes to a fetchable URL via the LDS `file-url` route,
 * signed as Drive. The LDS returns a short-lived token URL when the file is on
 * this device (`source: "local"`) or a signed remote URL when it lives only in
 * object storage. Either way the returned URL needs no further auth, so the
 * browser can follow it directly. Throws if the record has no attached file.
 */
export async function getFileUrl(id: string): Promise<FileUrl> {
  return ldsGet<FileUrl>(`/data/records/${encodeURIComponent(id)}/file-url`);
}

/**
 * The cloud-data-server's record shape is a subset of the local one — notably
 * it omits `origin_app_id`, `kind` and the local file `path`. For a merge we
 * only rely on the fields both sides share (`id`, `type`, sizes, hashes).
 */
export type CloudRecord = Pick<
  DriveRecord,
  | "id"
  | "type"
  | "category"
  | "created_at"
  | "updated_at"
  | "version"
  | "content_hash"
  | "object_storage_key"
  | "mime_type"
  | "size_bytes"
  | "original_filename"
  | "parent_id"
>;

/** Thrown when the cloud is unreachable/unconfigured (LDS replied 5xx). */
export class CloudUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudUnavailableError";
  }
}

async function ldsGetCloud<T>(path: string): Promise<T> {
  const secret = readDriveSecret();
  if (!secret) throw new DriveNotInstalledError();
  const res = await fetch(`${LDS_URL}${path}`, {
    headers: signedDriveGetHeaders(secret, path),
    cache: "no-store",
  });
  const body = await res.text();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* non-JSON body */
    }
    // 5xx here means "cloud not configured / not signed in / unreachable" —
    // surface it softly so the caller can still render the local view.
    if (res.status >= 500) throw new CloudUnavailableError(message);
    throw new Error(message);
  }
  return JSON.parse(body) as T;
}

export async function listCloudRecords(type?: string): Promise<CloudRecord[]> {
  const qs = new URLSearchParams({ limit: "1000" });
  if (type) qs.set("type", type);
  const { records } = await ldsGetCloud<{ records: CloudRecord[] }>(
    `/cloud/data/records?${qs.toString()}`,
  );
  return records;
}

/** The cloud type summary omits `latest_updated` that the local one carries. */
export type CloudTypeSummary = Pick<DriveTypeSummary, "record_type" | "count">;

export async function listCloudTypes(): Promise<CloudTypeSummary[]> {
  const { types } = await ldsGetCloud<{ types: CloudTypeSummary[] }>(
    "/cloud/data/types",
  );
  return types;
}
