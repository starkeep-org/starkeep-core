/**
 * Managing the deployment's accounts: listing them, creating one, moving one
 * in and out of the two groups, and disabling one.
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
 * `admin-app-policy.ts`), so these calls run as the signed-in operator. Only
 * disabling a user touches SSM, to delete the user's device records, and that
 * hops to Manager as the device routes do.
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
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { deleteDeviceKeyParameter, listDeviceRecords } from "@starkeep/admin-installer/app-creds";
import { managerCredentials, readStarkeepConfig } from "../lib/manager-credentials";
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
  if (!config.userPoolId) throw new Error("~/.starkeep/config.json has no userPoolId — complete the cloud setup first");
  return config.userPoolId;
}

async function allUsers(client: CognitoIdentityProviderClient, poolId: string): Promise<UserType[]> {
  const users: UserType[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListUsersCommand({ UserPoolId: poolId, PaginationToken: token }));
    users.push(...(page.Users ?? []));
    token = page.PaginationToken;
  } while (token);
  return users;
}

async function membersOf(client: CognitoIdentityProviderClient, poolId: string, group: Group): Promise<Set<string>> {
  const members = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.send(new ListUsersInGroupCommand({ UserPoolId: poolId, GroupName: group, NextToken: token }));
    for (const user of page.Users ?? []) if (user.Username) members.add(user.Username);
    token = page.NextToken;
  } while (token);
  return members;
}

async function listUsers(client: CognitoIdentityProviderClient, poolId: string): Promise<UserView[]> {
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
  const body = (await req.json()) as SessionBody & { email?: string; admin?: boolean; data?: boolean };
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
    for (const [group, wanted] of [[ADMINS_GROUP, body.admin], [DATA_GROUP, body.data]] as const) {
      if (wanted) {
        await client.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
      }
    }
    return Response.json({ users: await listUsers(client, poolId) });
  } catch (err) {
    return failed(err, "create");
  }
}

/** Add an account to a group or take it out. Body: session plus `{ username, group, member }`. */
export async function SET_GROUP(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody & { username?: string; group?: string; member?: boolean };
  const { username, group, member } = body;
  if (!username || !GROUPS.includes(group as Group) || typeof member !== "boolean") {
    return Response.json({ error: "username, group and member are required" }, { status: 400 });
  }
  try {
    const client = cognito(body);
    const poolId = userPoolId();
    if (member) {
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
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
      await client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
    }
    return Response.json({ users: await listUsers(client, poolId) });
  } catch (err) {
    return failed(err, "set group");
  }
}

/**
 * Disable an account, or enable it again. Body: session plus
 * `{ username, enabled }`.
 *
 * Disabling also signs the user out everywhere, which revokes their refresh
 * tokens, and deletes their device records, so their machines stop syncing
 * within the cloud's five-minute cache. Enabling restores sign-in only; the
 * user's devices pair again.
 */
export async function SET_ENABLED(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody & { username?: string; enabled?: boolean };
  const { username, enabled, stackPrefix, region } = body;
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
      return Response.json({ users: await listUsers(client, poolId), devicesRevoked: [] });
    }
    await client.send(new AdminDisableUserCommand({ UserPoolId: poolId, Username: username }));
    await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: username }));
    const awsCreds = await managerCredentials(readStarkeepConfig(), body.credentials, region, "starkeep-disable-user");
    const devices = await listDeviceRecords({ stackPrefix, region, awsCreds });
    const revoked: string[] = [];
    for (const device of devices.filter((d) => d.userId === username)) {
      await deleteDeviceKeyParameter({ stackPrefix, deviceId: device.deviceId, region, awsCreds });
      revoked.push(device.deviceId);
    }
    return Response.json({ users: await listUsers(client, poolId), devicesRevoked: revoked });
  } catch (err) {
    return failed(err, "set enabled");
  }
}
