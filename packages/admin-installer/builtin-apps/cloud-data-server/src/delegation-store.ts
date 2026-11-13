/**
 * Delegation rows: one user's approval for one outside client to reach one
 * app's data in one mode.
 *
 * The table sits outside the owner-scope compiler, beside public shares,
 * because the broker finds a row by the id a token names before the row
 * names a user. Every read here therefore takes the user, the app or both,
 * and the broker compares them with the token's claims.
 *
 * Each row keeps a Cognito refresh token from the connectors client, sealed
 * under a key derived from the delegation signing key. The broker mints ID
 * tokens from it to learn whether the user may still use data, so "Sign out
 * all devices", "Disable" and removal from `starkeep-users` reach outside
 * clients through Cognito, with no hook here.
 */
import { randomBytes } from "node:crypto";
import type { DelegationChannel, DelegationMode } from "@starkeep/protocol-primitives";
import { postgresCompiler, type DatabaseClient } from "@starkeep/storage-aurora-dsql";

const GRANTS_TABLE = "delegation.grants";

/** Bound on how often a row's `last_used_at_ms` and `last_write_at_ms` are written. */
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface DelegationRow {
  id: string;
  user_id: string;
  app_id: string;
  channel: DelegationChannel;
  mode: DelegationMode;
  client_name: string;
  cognito_refresh_ciphertext: string;
  created_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  last_used_at_ms: number | null;
  last_write_at_ms: number | null;
}

const COLUMNS = [
  "id",
  "user_id",
  "app_id",
  "channel",
  "mode",
  "client_name",
  "cognito_refresh_ciphertext",
  "created_at_ms",
  "expires_at_ms",
  "revoked_at_ms",
  "last_used_at_ms",
  "last_write_at_ms",
] as const;

type Db = Record<string, Record<string, unknown>>;
const compiler = postgresCompiler as unknown as import("kysely").Kysely<Db>;

async function run(
  client: DatabaseClient,
  compiled: { sql: string; parameters: readonly unknown[] },
): Promise<Record<string, unknown>[]> {
  const result = await client.query(compiled.sql, [...compiled.parameters]);
  return result.rows as Record<string, unknown>[];
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function rowOf(raw: Record<string, unknown>): DelegationRow {
  return {
    ...(raw as unknown as DelegationRow),
    // `bigint` comes back from `pg` as a string.
    created_at_ms: Number(raw.created_at_ms),
    expires_at_ms: Number(raw.expires_at_ms),
    revoked_at_ms: nullableNumber(raw.revoked_at_ms),
    last_used_at_ms: nullableNumber(raw.last_used_at_ms),
    last_write_at_ms: nullableNumber(raw.last_write_at_ms),
  };
}

/** A fresh delegation id: 128 random bits, URL-safe. */
export function newDelegationId(): string {
  return randomBytes(16).toString("base64url");
}

/** Whether a row still admits a request at `nowMs`. */
export function isLive(row: DelegationRow, nowMs: number): boolean {
  return row.revoked_at_ms === null && row.expires_at_ms > nowMs;
}

export async function insertDelegation(client: DatabaseClient, row: DelegationRow): Promise<void> {
  await run(
    client,
    compiler
      .insertInto(GRANTS_TABLE)
      .values({ ...row })
      .compile(),
  );
}

/** The row a token names, or null. The caller compares the user and the app. */
export async function findDelegation(
  client: DatabaseClient,
  id: string,
): Promise<DelegationRow | null> {
  const rows = await run(
    client,
    compiler
      .selectFrom(GRANTS_TABLE)
      .select([...COLUMNS])
      .where("id", "=", id)
      .compile(),
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/** One user's delegations, newest first, for the connections page. */
export async function listDelegations(
  client: DatabaseClient,
  userId: string,
): Promise<DelegationRow[]> {
  const rows = await run(
    client,
    compiler
      .selectFrom(GRANTS_TABLE)
      .select([...COLUMNS])
      .where("user_id", "=", userId)
      .orderBy("created_at_ms", "desc")
      .compile(),
  );
  return rows.map(rowOf);
}

/**
 * Mark one of the user's delegations revoked. Returns the row as it stood,
 * or null when the user has no such delegation.
 */
export async function revokeDelegation(
  client: DatabaseClient,
  userId: string,
  id: string,
  nowMs: number,
): Promise<DelegationRow | null> {
  const rows = await run(
    client,
    compiler
      .updateTable(GRANTS_TABLE)
      .set({ revoked_at_ms: nowMs })
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .where("revoked_at_ms", "is", null)
      .returning([...COLUMNS])
      .compile(),
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

/**
 * Record that a delegation was used, at most once per {@link TOUCH_INTERVAL_MS}
 * for each column, so a busy client costs one write an hour rather than one
 * per call.
 */
export async function touchDelegation(
  client: DatabaseClient,
  row: DelegationRow,
  wrote: boolean,
  nowMs: number,
): Promise<void> {
  const set: Record<string, number> = {};
  if (row.last_used_at_ms === null || nowMs - row.last_used_at_ms >= TOUCH_INTERVAL_MS) {
    set.last_used_at_ms = nowMs;
  }
  if (
    wrote &&
    (row.last_write_at_ms === null || nowMs - row.last_write_at_ms >= TOUCH_INTERVAL_MS)
  ) {
    set.last_write_at_ms = nowMs;
  }
  if (Object.keys(set).length === 0) return;
  await run(client, compiler.updateTable(GRANTS_TABLE).set(set).where("id", "=", row.id).compile());
}

/**
 * Whether a manifest, as the registry stores it, declares a route an outside
 * client may call: any compute route with `auth: "delegated"`. Read by hand
 * rather than through `@starkeep/admin-manifest`, which this bundle does not
 * carry; an unreadable manifest counts as none.
 */
export function manifestServesOutsideClients(manifestJson: unknown): boolean {
  if (typeof manifestJson !== "string") return false;
  try {
    const manifest = JSON.parse(manifestJson) as {
      infraRequirements?: { compute?: { handlers?: { routes?: unknown[] }[] } };
    };
    const handlers = manifest.infraRequirements?.compute?.handlers ?? [];
    return handlers.some((h) =>
      (h.routes ?? []).some(
        (r) =>
          typeof r === "object" && r !== null && (r as { auth?: unknown }).auth === "delegated",
      ),
    );
  } catch {
    return false;
  }
}

/** The installed web apps that serve outside clients, for the consent page. */
export async function loadConnectableApps(
  client: DatabaseClient,
): Promise<{ appId: string; name: string }[]> {
  const rows = await run(
    client,
    compiler
      .selectFrom("shared.app_registry")
      .select(["app_id", "name", "manifest"])
      .where("web_app", "=", true)
      .orderBy("app_id")
      .compile(),
  );
  return rows
    .filter((r) => manifestServesOutsideClients(r.manifest))
    .map((r) => ({
      appId: String(r.app_id),
      name: typeof r.name === "string" && r.name ? r.name : String(r.app_id),
    }));
}
