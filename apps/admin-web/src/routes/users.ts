/**
 * Managing the deployment's accounts: listing them, creating one, moving one
 * in and out of the two groups, resetting a password, signing one out of every
 * device, and disabling one.
 *
 * ## The two groups
 *
 * - `starkeep-admins` administers the deployment. Only its members get AWS
 *   credentials from the identity pool.
 * - `starkeep-users` has a data library that syncs through the cloud. The
 *   cloud data server checks it on every data call.
 *
 * An admin may be in either or both. Creating an account sends Cognito's
 * invitation email with a temporary password; there is no self-service sign-up.
 *
 * ## Whose credentials
 *
 * Cognito user management is the admin-app role's own grant (see
 * `admin-app-policy.ts`), so these calls run as the signed-in operator. A
 * device's only credential is its owner's sign-in, so every act on devices is
 * an act on the account in the pool, and nothing here reaches SSM.
 *
 * ## What it refuses
 *
 * Removing the last admin, and disabling the signed-in operator. Either would
 * leave nobody able to administer the deployment.
 */

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomBytes } from "node:crypto";
import { readStarkeepConfig } from "../lib/manager-credentials";
import type { STSCredentials } from "../lib/cognito-auth";

export const ADMINS_GROUP = "starkeep-admins";
export const DATA_GROUP = "starkeep-users";
const GROUPS = [ADMINS_GROUP, DATA_GROUP] as const;
type Group = (typeof GROUPS)[number];

interface SessionBody {
  credentials: STSCredentials;
  stackPrefix: string;
  region: string;
  /** The signed-in operator's `sub`, so the route can refuse acts on oneself. */
  userSub?: string;
}

export interface UserView {
  /** The Cognito username, which is the user's `sub` in a pool keyed by email. */
  readonly username: string;
  readonly email: string | null;
  readonly enabled: boolean;
  /** Cognito's account status, e.g. FORCE_CHANGE_PASSWORD until first sign-in. */
  readonly status: string | null;
  readonly admin: boolean;
  readonly data: boolean;
}

function cognito(body: SessionBody): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({
    region: body.region,
    credentials: {
      accessKeyId: body.credentials.accessKeyId,
      secretAccessKey: body.credentials.secretAccessKey,
      sessionToken: body.credentials.sessionToken,
    },
  });
}

function userPoolId(): string {
  const config = readStarkeepConfig() as { userPoolId?: string };
  if (!config.userPoolId)
    throw new Error("~/.starkeep/config.json has no userPoolId — complete the cloud setup first");
  return config.userPoolId;
}

async function allUsers(
  client: CognitoIdentityProviderClient,
  poolId: string,
): Promise<UserType[]> {
  const users: UserType[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListUsersCommand({ UserPoolId: poolId, PaginationToken: token }),
    );
    users.push(...(page.Users ?? []));
    token = page.PaginationToken;
  } while (token);
  return users;
}

async function membersOf(
  client: CognitoIdentityProviderClient,
  poolId: string,
  group: Group,
): Promise<Set<string>> {
  const members = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListUsersInGroupCommand({ UserPoolId: poolId, GroupName: group, NextToken: token }),
    );
    for (const user of page.Users ?? []) if (user.Username) members.add(user.Username);
    token = page.NextToken;
  } while (token);
  return members;
}

async function listUsers(
  client: CognitoIdentityProviderClient,
  poolId: string,
): Promise<UserView[]> {
  const [users, admins, data] = await Promise.all([
    allUsers(client, poolId),
    membersOf(client, poolId, ADMINS_GROUP),
    membersOf(client, poolId, DATA_GROUP),
  ]);
  return users
    .filter((u): u is UserType & { Username: string } => typeof u.Username === "string")
    .map((u) => ({
      username: u.Username,
      email: u.Attributes?.find((a) => a.Name === "email")?.Value ?? null,
      enabled: u.Enabled !== false,
      status: u.UserStatus ?? null,
      admin: admins.has(u.Username),
      data: data.has(u.Username),
    }))
    .sort((a, b) => (a.email ?? a.username).localeCompare(b.email ?? b.username));
}

function failed(err: unknown, act: string): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api/users] ${act} failed`, message);
  return Response.json({ error: message }, { status: 500 });
}

/** Every account, with its two group memberships. */
export async function LIST(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody;
  try {
    return Response.json({ users: await listUsers(cognito(body), userPoolId()) });
  } catch (err) {
    return failed(err, "list");
  }
}

/** Create an account. Body: session plus `{ email, admin?, data? }`. Cognito emails the invitation. */
export async function CREATE(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody & {
    email?: string;
    admin?: boolean;
    data?: boolean;
  };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    return Response.json({ error: "Enter the person's email address." }, { status: 400 });
  }
  try {
    const client = cognito(body);
    const poolId = userPoolId();
    const created = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
    const username = created.User?.Username ?? email;
    for (const [group, wanted] of [
      [ADMINS_GROUP, body.admin],
      [DATA_GROUP, body.data],
    ] as const) {
      if (wanted) {
        await client.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: poolId,
            Username: username,
            GroupName: group,
          }),
        );
      }
    }
    return Response.json({ users: await listUsers(client, poolId) });
  } catch (err) {
    return failed(err, "create");
  }
}

/** Add an account to a group or take it out. Body: session plus `{ username, group, member }`. */
export async function SET_GROUP(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody & {
    username?: string;
    group?: string;
    member?: boolean;
  };
  const { username, group, member } = body;
  if (!username || !GROUPS.includes(group as Group) || typeof member !== "boolean") {
    return Response.json({ error: "username, group and member are required" }, { status: 400 });
  }
  try {
    const client = cognito(body);
    const poolId = userPoolId();
    if (member) {
      await client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: poolId,
          Username: username,
          GroupName: group,
        }),
      );
    } else {
      if (group === ADMINS_GROUP) {
        const admins = await membersOf(client, poolId, ADMINS_GROUP);
        admins.delete(username);
        if (admins.size === 0) {
          return Response.json(
            { error: "This is the last admin. Make someone else an admin first." },
            { status: 409 },
          );
        }
      }
      await client.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: poolId,
          Username: username,
          GroupName: group,
        }),
      );
    }
    return Response.json({ users: await listUsers(client, poolId) });
  } catch (err) {
    return failed(err, "set group");
  }
}

/**
 * Sign an account out of every device, without disabling it. Body: session
 * plus `{ username }`.
 *
 * Revokes every refresh token the account holds, so each of its devices stops
 * syncing once its 15-minute ID token expires and asks for a new sign-in. A
 * lost phone is cut off this way: per-user, because the pool tracks no single
 * device's session.
 */
export async function SIGN_OUT_EVERYWHERE(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody & { username?: string };
  if (!body.username) {
    return Response.json({ error: "username is required" }, { status: 400 });
  }
  try {
    const client = cognito(body);
    const poolId = userPoolId();
    await client.send(
      new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: body.username }),
    );
    return Response.json({ users: await listUsers(client, poolId) });
  } catch (err) {
    return failed(err, "sign out everywhere");
  }
}

/**
 * Disable an account, or enable it again. Body: session plus
 * `{ username, enabled }`.
 *
 * Disabling also signs the user out everywhere, which revokes their refresh
 * tokens, so their devices stop syncing once their 15-minute ID tokens expire.
 * Enabling restores sign-in only; each device asks for a new sign-in.
 */
export async function SET_ENABLED(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody & { username?: string; enabled?: boolean };
  const { username, enabled } = body;
  if (!username || typeof enabled !== "boolean") {
    return Response.json({ error: "username and enabled are required" }, { status: 400 });
  }
  if (!enabled && body.userSub && username === body.userSub) {
    return Response.json({ error: "You cannot disable your own account." }, { status: 409 });
  }
  try {
    const client = cognito(body);
    const poolId = userPoolId();
    if (enabled) {
      await client.send(new AdminEnableUserCommand({ UserPoolId: poolId, Username: username }));
      return Response.json({ users: await listUsers(client, poolId) });
    }
    await client.send(new AdminDisableUserCommand({ UserPoolId: poolId, Username: username }));
    await client.send(
      new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: username }),
    );
    return Response.json({ users: await listUsers(client, poolId) });
  } catch (err) {
    return failed(err, "set enabled");
  }
}

/**
 * The letters a temporary password is drawn from: no 0/O or 1/l/I, because an
 * admin reads it to the person or types it into a message.
 */
const TEMPORARY_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Sixteen letters from {@link TEMPORARY_PASSWORD_ALPHABET}: about 93 bits. */
export function temporaryPassword(): string {
  const bytes = randomBytes(16);
  let out = "";
  // 256 is not a multiple of the alphabet's size, so the bias toward early
  // letters is a fraction of a bit over the whole password. Not worth a
  // rejection loop for a password the person replaces at once.
  for (const byte of bytes)
    out += TEMPORARY_PASSWORD_ALPHABET[byte % TEMPORARY_PASSWORD_ALPHABET.length];
  return out;
}

/**
 * Give an account a new temporary password, for a person who forgot theirs.
 * Body: session plus `{ username }`. Answers the password once, for the admin
 * to send; it is stored nowhere.
 *
 * The account returns to `FORCE_CHANGE_PASSWORD`, so the person chooses a new
 * password at their next sign-in, on any device. Existing sessions are left
 * alone: a person who only forgot a password keeps syncing on the devices
 * still signed in. Self-service reset waits for the managed sign-in page.
 */
export async function RESET_PASSWORD(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody & { username?: string };
  if (!body.username) {
    return Response.json({ error: "username is required" }, { status: 400 });
  }
  try {
    const client = cognito(body);
    const poolId = userPoolId();
    const password = temporaryPassword();
    await client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: poolId,
        Username: body.username,
        Password: password,
        Permanent: false,
      }),
    );
    return Response.json({ users: await listUsers(client, poolId), temporaryPassword: password });
  } catch (err) {
    return failed(err, "reset password");
  }
}
