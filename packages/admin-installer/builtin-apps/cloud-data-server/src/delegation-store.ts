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
  /** An OAuth client's `client_id` URL. Null for a pasted token. */
  client_id: string | null;
  /** The host an OAuth client's redirect URI names. Null for a pasted token. */
  redirect_host: string | null;
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
  "client_id",
  "redirect_host",
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
    client_id: typeof raw.client_id === "string" ? raw.client_id : null,
    redirect_host: typeof raw.redirect_host === "string" ? raw.redirect_host : null,
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
 * The paths of a manifest's routes an outside client may call: every compute
 * route with `auth: "delegated"`, as the manifest declares it, relative to
 * `/apps/<appId>`. Read by hand rather than through `@starkeep/admin-manifest`,
 * which this bundle does not carry; an unreadable manifest declares none.
 */
export function delegatedPathsOf(manifestJson: unknown): string[] {
  if (typeof manifestJson !== "string") return [];
  try {
    const manifest = JSON.parse(manifestJson) as {
      infraRequirements?: { compute?: { handlers?: { routes?: unknown[] }[] } };
    };
    const paths: string[] = [];
    for (const h of manifest.infraRequirements?.compute?.handlers ?? []) {
      for (const r of h.routes ?? []) {
        if (typeof r !== "object" || r === null) continue;
        const { auth, route } = r as { auth?: unknown; route?: unknown };
        if (auth !== "delegated" || typeof route !== "string") continue;
        const path = /^\S+\s+(\/\S*)$/.exec(route.trim())?.[1];
        if (path && !paths.includes(path)) paths.push(path);
      }
    }
    return paths;
  } catch {
    return [];
  }
}

/** An installed app that serves outside clients. */
export interface ConnectableApp {
  appId: string;
  name: string;
  /** Its delegated routes' paths, relative to `/apps/<appId>`. */
  delegatedPaths: string[];
}

/** The installed web apps that serve outside clients, for the consent page. */
export async function loadConnectableApps(client: DatabaseClient): Promise<ConnectableApp[]> {
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
    .map((r) => ({
      appId: String(r.app_id),
      name: typeof r.name === "string" && r.name ? r.name : String(r.app_id),
      delegatedPaths: delegatedPathsOf(r.manifest),
    }))
    .filter((app) => app.delegatedPaths.length > 0);
}

// ---------------------------------------------------------------------------
// OAuth authorizations in progress
// ---------------------------------------------------------------------------

const AUTHORIZATIONS_TABLE = "delegation.authorizations";

/** How long an authorization row lives: the sign-in, the consent and the code exchange. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/**
 * One OAuth authorization request, from the sign-in to the code exchange.
 * The id becomes the grant's id, so the sealed refresh token moves to the
 * grant unchanged.
 */
export interface AuthorizationRow {
  id: string;
  user_id: string;
  user_email: string;
  app_id: string;
  /** The `resource` the client named: the app's MCP endpoint URL. */
  resource: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  /** The client's own `state`, returned with the code. */
  state: string | null;
  code_challenge: string;
  requested_scope: string;
  /** Set by the approval. */
  mode: DelegationMode | null;
  days: number | null;
  cognito_refresh_ciphertext: string;
  code_hash: string | null;
  code_expires_at_ms: number | null;
  created_at_ms: number;
  expires_at_ms: number;
  used_at_ms: number | null;
}

const AUTHORIZATION_COLUMNS = [
  "id",
  "user_id",
  "user_email",
  "app_id",
  "resource",
  "client_id",
  "client_name",
  "redirect_uri",
  "state",
  "code_challenge",
  "requested_scope",
  "mode",
  "days",
  "cognito_refresh_ciphertext",
  "code_hash",
  "code_expires_at_ms",
  "created_at_ms",
  "expires_at_ms",
  "used_at_ms",
] as const;

function authorizationOf(raw: Record<string, unknown>): AuthorizationRow {
  return {
    ...(raw as unknown as AuthorizationRow),
    days: nullableNumber(raw.days),
    code_expires_at_ms: nullableNumber(raw.code_expires_at_ms),
    created_at_ms: Number(raw.created_at_ms),
    expires_at_ms: Number(raw.expires_at_ms),
    used_at_ms: nullableNumber(raw.used_at_ms),
  };
}

export async function insertAuthorization(
  client: DatabaseClient,
  row: AuthorizationRow,
): Promise<void> {
  await run(
    client,
    compiler
      .insertInto(AUTHORIZATIONS_TABLE)
      .values({ ...row })
      .compile(),
  );
}

/** One authorization by id, or null. The caller checks its expiry. */
export async function findAuthorization(
  client: DatabaseClient,
  id: string,
): Promise<AuthorizationRow | null> {
  const rows = await run(
    client,
    compiler
      .selectFrom(AUTHORIZATIONS_TABLE)
      .select([...AUTHORIZATION_COLUMNS])
      .where("id", "=", id)
      .compile(),
  );
  return rows[0] ? authorizationOf(rows[0]) : null;
}

/**
 * Record the user's approval: the mode, the expiry and the code's hash. Only
 * a row that is live and not yet approved changes, so a second approval of
 * the same consent page does nothing. Returns the approved row, or null.
 */
export async function approveAuthorizationRow(
  client: DatabaseClient,
  id: string,
  approval: { mode: DelegationMode; days: number; codeHash: string; codeExpiresAtMs: number },
  nowMs: number,
): Promise<AuthorizationRow | null> {
  const rows = await run(
    client,
    compiler
      .updateTable(AUTHORIZATIONS_TABLE)
      .set({
        mode: approval.mode,
        days: approval.days,
        code_hash: approval.codeHash,
        code_expires_at_ms: approval.codeExpiresAtMs,
        // The row outlives its code, so a second use of the code is still
        // recognized after the first one.
        expires_at_ms: nowMs + AUTHORIZATION_TTL_MS,
      })
      .where("id", "=", id)
      .where("code_hash", "is", null)
      .where("expires_at_ms", ">", nowMs)
      .returning([...AUTHORIZATION_COLUMNS])
      .compile(),
  );
  return rows[0] ? authorizationOf(rows[0]) : null;
}

/** Delete one authorization and return it as it stood, or null. */
export async function deleteAuthorization(
  client: DatabaseClient,
  id: string,
): Promise<AuthorizationRow | null> {
  const rows = await run(
    client,
    compiler
      .deleteFrom(AUTHORIZATIONS_TABLE)
      .where("id", "=", id)
      .returning([...AUTHORIZATION_COLUMNS])
      .compile(),
  );
  return rows[0] ? authorizationOf(rows[0]) : null;
}

/** Delete every expired authorization and return them, for the caller to revoke. */
export async function deleteExpiredAuthorizations(
  client: DatabaseClient,
  nowMs: number,
): Promise<AuthorizationRow[]> {
  const rows = await run(
    client,
    compiler
      .deleteFrom(AUTHORIZATIONS_TABLE)
      .where("expires_at_ms", "<=", nowMs)
      .returning([...AUTHORIZATION_COLUMNS])
      .compile(),
  );
  return rows.map(authorizationOf);
}

/** The authorization a code's hash names, or null. */
export async function findAuthorizationByCode(
  client: DatabaseClient,
  codeHash: string,
): Promise<AuthorizationRow | null> {
  const rows = await run(
    client,
    compiler
      .selectFrom(AUTHORIZATIONS_TABLE)
      .select([...AUTHORIZATION_COLUMNS])
      .where("code_hash", "=", codeHash)
      .compile(),
  );
  return rows[0] ? authorizationOf(rows[0]) : null;
}

/**
 * Mark an authorization's code used. True for the one caller that marks it;
 * a concurrent second exchange of the same code gets false.
 */
export async function claimAuthorization(
  client: DatabaseClient,
  id: string,
  nowMs: number,
): Promise<boolean> {
  const rows = await run(
    client,
    compiler
      .updateTable(AUTHORIZATIONS_TABLE)
      .set({ used_at_ms: nowMs })
      .where("id", "=", id)
      .where("used_at_ms", "is", null)
      .returning(["id"])
      .compile(),
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// OAuth refresh tokens
// ---------------------------------------------------------------------------

const REFRESH_TOKENS_TABLE = "delegation.refresh_tokens";

export interface RefreshTokenRow {
  token_hash: string;
  grant_id: string;
  app_id: string;
  created_at_ms: number;
  /** The grant's own expiry: a refresh token never outlives its grant. */
  expires_at_ms: number;
  rotated_at_ms: number | null;
}

const REFRESH_TOKEN_COLUMNS = [
  "token_hash",
  "grant_id",
  "app_id",
  "created_at_ms",
  "expires_at_ms",
  "rotated_at_ms",
] as const;

function refreshTokenOf(raw: Record<string, unknown>): RefreshTokenRow {
  return {
    ...(raw as unknown as RefreshTokenRow),
    created_at_ms: Number(raw.created_at_ms),
    expires_at_ms: Number(raw.expires_at_ms),
    rotated_at_ms: nullableNumber(raw.rotated_at_ms),
  };
}

export async function insertRefreshToken(
  client: DatabaseClient,
  row: RefreshTokenRow,
): Promise<void> {
  await run(
    client,
    compiler
      .insertInto(REFRESH_TOKENS_TABLE)
      .values({ ...row })
      .compile(),
  );
}

export async function findRefreshToken(
  client: DatabaseClient,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  const rows = await run(
    client,
    compiler
      .selectFrom(REFRESH_TOKENS_TABLE)
      .select([...REFRESH_TOKEN_COLUMNS])
      .where("token_hash", "=", tokenHash)
      .compile(),
  );
  return rows[0] ? refreshTokenOf(rows[0]) : null;
}

/**
 * Mark one refresh token rotated. True for the one caller that marks it; a
 * concurrent refresh with the same token gets false.
 */
export async function rotateRefreshToken(
  client: DatabaseClient,
  tokenHash: string,
  nowMs: number,
): Promise<boolean> {
  const rows = await run(
    client,
    compiler
      .updateTable(REFRESH_TOKENS_TABLE)
      .set({ rotated_at_ms: nowMs })
      .where("token_hash", "=", tokenHash)
      .where("rotated_at_ms", "is", null)
      .returning(["token_hash"])
      .compile(),
  );
  return rows.length === 1;
}

/** End every live refresh token under one grant, as a revocation does. */
export async function endRefreshTokens(
  client: DatabaseClient,
  grantId: string,
  nowMs: number,
): Promise<void> {
  await run(
    client,
    compiler
      .updateTable(REFRESH_TOKENS_TABLE)
      .set({ rotated_at_ms: nowMs })
      .where("grant_id", "=", grantId)
      .where("rotated_at_ms", "is", null)
      .compile(),
  );
}
