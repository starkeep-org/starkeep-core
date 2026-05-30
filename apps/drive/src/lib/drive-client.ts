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
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const DRIVE_APP_ID = "starkeep-drive";
const STARKEEP_DIR = process.env.STARKEEP_DIR || join(homedir(), ".starkeep");
const DATA_DB_PATH = join(STARKEEP_DIR, "data.db");
const LDS_URL =
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
    const row = db
      .prepare(
        "SELECT hmac_secret FROM shared_app_registry WHERE app_id = ? AND status = 'active'",
      )
      .get(DRIVE_APP_ID) as { hmac_secret: string } | undefined;
    return row?.hmac_secret ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
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
 * GET a local-data-server `/data/*` path signed as Starkeep Drive. The HMAC is
 * over `${appId}:` (empty body for GET), matching the LDS `validateAppHmac`.
 */
async function ldsGet<T>(path: string): Promise<T> {
  const secret = readDriveSecret();
  if (!secret) throw new DriveNotInstalledError();
  const sig = createHmac("sha256", secret).update(`${DRIVE_APP_ID}:`).digest("hex");
  const res = await fetch(`${LDS_URL}${path}`, {
    headers: {
      "X-Starkeep-App-Id": DRIVE_APP_ID,
      "X-Starkeep-App-Sig": sig,
    },
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
  owner_id: string;
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
