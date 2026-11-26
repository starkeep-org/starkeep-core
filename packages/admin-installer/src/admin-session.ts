/**
 * The Starkeep admin's session, shared by admin-web, the CLI and the install
 * scripts: `~/.starkeep/admin-session.json`, mode 0600. `@starkeep/operator`
 * re-exports this module; it lives here so the scripts in this package can use
 * it without a dependency cycle.
 *
 * A sign-in in either tool writes the file, and a sign-out in either tool
 * revokes the refresh token and deletes it, so the person signs in once for
 * both. The file holds the admin client's refresh token; credentials are
 * minted from it for each privileged action and never stored.
 *
 * After {@link ADMIN_IDLE_EXPIRY_MS} without a privileged action, the session
 * ends and the next action needs a new sign-in. An admin can install an app
 * that grants itself every shared type, so the admin token gets this bound
 * while the ten-year device token does not.
 *
 * Any local process can read the file, as it could read admin-web's browser
 * storage before. Browser pages from other sites stay out through admin-web's
 * same-origin and `Host` checks.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CognitoIdentityClient,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
} from "@aws-sdk/client-cognito-identity";
import { starkeepDir } from "@starkeep/app-client";
import {
  createCognitoClient,
  idTokenClaims,
  isRejection,
  type AuthTokens,
} from "@starkeep/protocol-primitives";
import type { AwsCredentials } from "./app-creds";
import { regionFromUserPoolId } from "./cognito-auth";

/** `~/.starkeep/config.json`, or null when it is missing or unreadable. */
function readConfig(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(starkeepDir(), "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** Twelve hours without a privileged action ends the session. */
export const ADMIN_IDLE_EXPIRY_MS = 12 * 60 * 60 * 1000;

/**
 * The admin client's refresh tokens last one day at the pool
 * (`RefreshTokenValidity` in the bootstrap template), so no session outlives
 * its sign-in by more than this.
 */
export const ADMIN_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The group whose members administer the deployment. */
export const ADMINS_GROUP = "starkeep-admins";

/** The session ended, or never began: the person must sign in as the admin. */
export class SignInRequired extends Error {
  readonly code = "NOT_SIGNED_IN";
  constructor(
    message = "Sign in as the Starkeep admin first: run `starkeep login --admin`, or sign in in admin-web.",
  ) {
    super(message);
    this.name = "SignInRequired";
  }
}

interface SessionFile {
  refreshToken: string;
  email: string | null;
  sub: string;
  /** The pool and client that issued the token, so a session never outlives a switch to another cloud. */
  userPoolId: string;
  clientId: string;
  signedInAt: string;
  lastUsedAt: string;
}

/** Where the session lives. */
export function adminSessionFile(): string {
  return join(starkeepDir(), "admin-session.json");
}

/** The cloud's sign-in settings from `config.json`, or null before cloud setup. */
export interface AdminPool {
  region: string;
  userPoolId: string;
  clientId: string;
  identityPoolId: string;
  cognitoDomain: string | null;
  stackPrefix: string | null;
}

export function adminPool(): AdminPool | null {
  const config = readConfig();
  const userPoolId = config?.userPoolId;
  const clientId = config?.userPoolClientId;
  const identityPoolId = config?.identityPoolId;
  if (
    typeof userPoolId !== "string" ||
    typeof clientId !== "string" ||
    typeof identityPoolId !== "string"
  ) {
    return null;
  }
  return {
    region: regionFromUserPoolId(userPoolId),
    userPoolId,
    clientId,
    identityPoolId,
    cognitoDomain: typeof config?.cognitoDomain === "string" ? config.cognitoDomain : null,
    stackPrefix: typeof config?.stackPrefix === "string" ? config.stackPrefix : null,
  };
}

function readFile(): SessionFile | null {
  try {
    const parsed = JSON.parse(readFileSync(adminSessionFile(), "utf8")) as Partial<SessionFile>;
    if (
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.sub !== "string" ||
      typeof parsed.userPoolId !== "string" ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.lastUsedAt !== "string"
    ) {
      return null;
    }
    return parsed as SessionFile;
  } catch {
    return null;
  }
}

/** Write through a temporary file and a rename, so neither tool reads half a file. */
function writeFile(session: SessionFile): void {
  const path = adminSessionFile();
  mkdirSync(starkeepDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function removeFile(): void {
  rmSync(adminSessionFile(), { force: true });
}

function idle(session: SessionFile, now: number): boolean {
  const last = Date.parse(session.lastUsedAt);
  return !Number.isFinite(last) || now - last > ADMIN_IDLE_EXPIRY_MS;
}

function tooOld(session: SessionFile, now: number): boolean {
  const start = Date.parse(session.signedInAt);
  return !Number.isFinite(start) || now - start > ADMIN_MAX_LIFETIME_MS;
}

/** When the session ends: twelve hours after its last use, and never later than a day after its sign-in. */
function endsAt(session: SessionFile): number {
  return Math.min(
    Date.parse(session.lastUsedAt) + ADMIN_IDLE_EXPIRY_MS,
    Date.parse(session.signedInAt) + ADMIN_MAX_LIFETIME_MS,
  );
}

export interface AdminSessionStatus {
  signedIn: boolean;
  email: string | null;
  sub: string | null;
  /** When the session ends: after twelve hours without use, or a day after its sign-in. */
  expiresAt: string | null;
}

/** Whether a session exists and has not gone idle. Reads the file only. */
export function adminSessionStatus(now = Date.now()): AdminSessionStatus {
  const session = readFile();
  const pool = adminPool();
  if (
    !session ||
    idle(session, now) ||
    tooOld(session, now) ||
    !pool ||
    session.userPoolId !== pool.userPoolId ||
    session.clientId !== pool.clientId
  ) {
    return { signedIn: false, email: null, sub: null, expiresAt: null };
  }
  return {
    signedIn: true,
    email: session.email,
    sub: session.sub,
    expiresAt: new Date(endsAt(session)).toISOString(),
  };
}

/**
 * Keep the tokens of a sign-in that just happened on the managed login page.
 * Refuses an account outside the admin group, after revoking its token.
 */
export async function saveAdminSignIn(
  tokens: AuthTokens,
  now = Date.now(),
): Promise<AdminSessionStatus> {
  const pool = adminPool();
  if (!pool) throw new Error("This computer has no cloud setup yet (~/.starkeep/config.json).");
  const claims = idTokenClaims(tokens.idToken);
  if (!claims.sub) throw new Error("The sign-in token names no user.");
  if (!claims.groups.includes(ADMINS_GROUP)) {
    await cognitoClient(pool)
      .revoke(tokens.refreshToken)
      .catch(() => undefined);
    throw new Error(
      "This account has no admin rights on this cloud. Ask an admin to make you one.",
    );
  }
  const stamp = new Date(now).toISOString();
  // A previous session on this computer ends at the pool too.
  const previous = readFile();
  if (previous && previous.refreshToken !== tokens.refreshToken) {
    await cognitoClient(pool)
      .revoke(previous.refreshToken)
      .catch(() => undefined);
  }
  writeFile({
    refreshToken: tokens.refreshToken,
    email: claims.email,
    sub: claims.sub,
    userPoolId: pool.userPoolId,
    clientId: pool.clientId,
    signedInAt: stamp,
    lastUsedAt: stamp,
  });
  return adminSessionStatus(now);
}

function cognitoClient(pool: AdminPool) {
  return createCognitoClient({
    region: pool.region,
    userPoolClientId: pool.clientId,
    // Test seam, as the local data server has.
    ...(process.env.STARKEEP_COGNITO_ENDPOINT
      ? { endpoint: process.env.STARKEEP_COGNITO_ENDPOINT }
      : {}),
  });
}

export interface AdminCredentials {
  credentials: AwsCredentials;
  /** The admin-app role's credentials as admin-web's routes pass them: an ISO expiration. */
  stsCredentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: string;
  };
  idToken: string;
  email: string | null;
  sub: string;
  region: string;
  stackPrefix: string | null;
}

/** Exchange an ID token at the identity pool for the admin-app role's credentials. */
export type IdentityPoolExchange = (pool: AdminPool, idToken: string) => Promise<AwsCredentials>;

export const exchangeAtIdentityPool: IdentityPoolExchange = async (pool, idToken) => {
  // GetId and GetCredentialsForIdentity are unsigned calls; the ID token is
  // the credential. No ambient AWS credential is read.
  const client = new CognitoIdentityClient({ region: pool.region });
  const logins = { [`cognito-idp.${pool.region}.amazonaws.com/${pool.userPoolId}`]: idToken };
  const id = await client.send(
    new GetIdCommand({ IdentityPoolId: pool.identityPoolId, Logins: logins }),
  );
  if (!id.IdentityId) throw new Error("The identity pool returned no identity.");
  const out = await client.send(
    new GetCredentialsForIdentityCommand({ IdentityId: id.IdentityId, Logins: logins }),
  );
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken || !c.Expiration) {
    throw new Error("The identity pool returned incomplete credentials.");
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
};

/**
 * Credentials for one privileged action, as the signed-in admin. Refreshes the
 * tokens, exchanges the ID token at the identity pool, and marks the session
 * used. Throws {@link SignInRequired} when no live session exists.
 */
export async function adminCredentials(
  options: { now?: number; exchange?: IdentityPoolExchange } = {},
): Promise<AdminCredentials> {
  const now = options.now ?? Date.now();
  const pool = adminPool();
  if (!pool)
    throw new SignInRequired("This computer has no cloud setup yet, so no admin can sign in.");
  const session = readFile();
  if (!session) throw new SignInRequired();
  if (session.userPoolId !== pool.userPoolId || session.clientId !== pool.clientId) {
    // The session belongs to another cloud than the one config.json names now.
    removeFile();
    throw new SignInRequired();
  }
  if (idle(session, now)) {
    await cognitoClient(pool)
      .revoke(session.refreshToken)
      .catch(() => undefined);
    removeFile();
    throw new SignInRequired("The admin session ended after 12 hours without use. Sign in again.");
  }
  if (tooOld(session, now)) {
    await cognitoClient(pool)
      .revoke(session.refreshToken)
      .catch(() => undefined);
    removeFile();
    throw new SignInRequired("The admin session ended a day after its sign-in. Sign in again.");
  }
  let tokens: AuthTokens;
  try {
    tokens = await cognitoClient(pool).refresh(session.refreshToken);
  } catch (err) {
    if (isRejection(err)) {
      // Revoked, expired, or the account was disabled: this session is over.
      removeFile();
      throw new SignInRequired("The admin session was ended at the pool. Sign in again.");
    }
    throw err;
  }
  const claims = idTokenClaims(tokens.idToken);
  if (!claims.groups.includes(ADMINS_GROUP)) {
    removeFile();
    throw new SignInRequired("This account is no longer an admin of this cloud.");
  }
  const credentials = await (options.exchange ?? exchangeAtIdentityPool)(pool, tokens.idToken);
  // Re-read before writing: a sign-out or a new sign-in in the other tool may
  // have landed during the refresh, and must not be undone.
  const current = readFile();
  if (current && current.refreshToken === session.refreshToken) {
    writeFile({ ...current, lastUsedAt: new Date(now).toISOString() });
  }
  return {
    credentials,
    stsCredentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiration: (credentials.expiration ?? new Date(now + 3600_000)).toISOString(),
    },
    idToken: tokens.idToken,
    email: claims.email,
    sub: session.sub,
    region: pool.region,
    stackPrefix: pool.stackPrefix,
  };
}

/** End the session: revoke the refresh token at the pool, and delete the file. */
export async function signOutAdmin(): Promise<{ revoked: boolean }> {
  const session = readFile();
  if (!session) {
    removeFile();
    return { revoked: false };
  }
  const pool = adminPool();
  let revoked = false;
  if (pool && pool.clientId === session.clientId) {
    revoked = await cognitoClient(pool)
      .revoke(session.refreshToken)
      .then(() => true)
      .catch(() => false);
  }
  removeFile();
  return { revoked };
}

export function hasAdminSessionFile(): boolean {
  return existsSync(adminSessionFile());
}
