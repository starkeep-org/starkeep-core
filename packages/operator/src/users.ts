/**
 * Managing the deployment's accounts: listing them, creating one, moving one
 * in and out of the two groups, resetting a password, signing one out of every
 * device, and disabling one. admin-web's Users routes and `starkeep user` both
 * call these functions.
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
 * `admin-app-policy.ts`), so these calls run as the signed-in admin. A
 * device's only credential is its owner's sign-in, so every act on devices is
 * an act on the account in the pool, and nothing here reaches SSM.
 *
 * ## What it refuses
 *
 * Removing the last enabled admin from the admins group, disabling it, and
 * disabling the signed-in admin. Each would leave nobody able to administer
 * the deployment. A disabled admin cannot sign in, so the count leaves
 * disabled admins out. A refusal throws {@link UserRefusal}.
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
import type { AdminCredentials } from "./admin-session";

export const ADMINS_GROUP = "starkeep-admins";
export const DATA_GROUP = "starkeep-users";
export const GROUPS = [ADMINS_GROUP, DATA_GROUP] as const;
export type Group = (typeof GROUPS)[number];

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

/** A change the deployment's state forbids. admin-web answers it with 409. */
export class UserRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserRefusal";
  }
}

/** Bad input, such as an email that is not one. admin-web answers it with 400. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

export const LAST_ADMIN_ERROR = "This is the last admin. Make someone else an admin first.";
export const DISABLE_SELF_ERROR = "You cannot disable your own account.";

/** The pool and the admin acting on it. */
export interface UserPool {
  client: Pick<CognitoIdentityProviderClient, "send">;
  poolId: string;
  /** The signed-in admin's username (`sub`), which may not disable itself. */
  actingAs: string;
}

export function userPool(admin: AdminCredentials, poolId: string): UserPool {
  return {
    client: new CognitoIdentityProviderClient({
      region: admin.region,
      credentials: {
        accessKeyId: admin.stsCredentials.accessKeyId,
        secretAccessKey: admin.stsCredentials.secretAccessKey,
        sessionToken: admin.stsCredentials.sessionToken,
      },
    }),
    poolId,
    actingAs: admin.sub,
  };
}

async function allUsers(pool: UserPool): Promise<UserType[]> {
  const users: UserType[] = [];
  let token: string | undefined;
  do {
    const page = await pool.client.send(
      new ListUsersCommand({ UserPoolId: pool.poolId, PaginationToken: token }),
    );
    users.push(...(page.Users ?? []));
    token = page.PaginationToken;
  } while (token);
  return users;
}

async function membersOf(
  pool: UserPool,
  group: Group,
  { enabledOnly = false } = {},
): Promise<Set<string>> {
  const members = new Set<string>();
  let token: string | undefined;
  do {
    const page = await pool.client.send(
      new ListUsersInGroupCommand({ UserPoolId: pool.poolId, GroupName: group, NextToken: token }),
    );
    for (const user of page.Users ?? [])
      if (user.Username && !(enabledOnly && user.Enabled === false)) members.add(user.Username);
    token = page.NextToken;
  } while (token);
  return members;
}

/** Whether taking `username` out of the enabled admins would leave none. */
async function isLastEnabledAdmin(pool: UserPool, username: string): Promise<boolean> {
  // A disabled admin cannot sign in, so only enabled admins count.
  const admins = await membersOf(pool, ADMINS_GROUP, { enabledOnly: true });
  if (!admins.has(username)) return false;
  admins.delete(username);
  return admins.size === 0;
}

/** Every account, with its two group memberships, by email. */
export async function listUsers(pool: UserPool): Promise<UserView[]> {
  const [users, admins, data] = await Promise.all([
    allUsers(pool),
    membersOf(pool, ADMINS_GROUP),
    membersOf(pool, DATA_GROUP),
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

/** Create an account in the chosen groups. Cognito emails the invitation. */
export async function createUser(
  pool: UserPool,
  input: { email: string; admin?: boolean; data?: boolean },
): Promise<void> {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new UserInputError("Enter the person's email address.");
  }
  const created = await pool.client.send(
    new AdminCreateUserCommand({
      UserPoolId: pool.poolId,
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
    [ADMINS_GROUP, input.admin],
    [DATA_GROUP, input.data],
  ] as const) {
    if (wanted) {
      await pool.client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: pool.poolId,
          Username: username,
          GroupName: group,
        }),
      );
    }
  }
}

/** Add an account to a group or take it out. */
export async function setGroup(
  pool: UserPool,
  username: string,
  group: Group,
  member: boolean,
): Promise<void> {
  if (member) {
    await pool.client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: pool.poolId,
        Username: username,
        GroupName: group,
      }),
    );
    return;
  }
  if (group === ADMINS_GROUP && (await isLastEnabledAdmin(pool, username))) {
    throw new UserRefusal(LAST_ADMIN_ERROR);
  }
  await pool.client.send(
    new AdminRemoveUserFromGroupCommand({
      UserPoolId: pool.poolId,
      Username: username,
      GroupName: group,
    }),
  );
}

/**
 * Sign an account out of every device, without disabling it.
 *
 * Revokes every refresh token the account holds, so each of its devices stops
 * syncing once its 15-minute ID token expires and asks for a new sign-in. A
 * lost phone is cut off this way: per-user, because the pool tracks no single
 * device's session.
 */
export async function signOutEverywhere(pool: UserPool, username: string): Promise<void> {
  await pool.client.send(
    new AdminUserGlobalSignOutCommand({ UserPoolId: pool.poolId, Username: username }),
  );
}

/**
 * Disable an account, or enable it again.
 *
 * Disabling also signs the user out everywhere, which revokes their refresh
 * tokens, so their devices stop syncing once their 15-minute ID tokens expire.
 * Enabling restores sign-in only; each device asks for a new sign-in.
 */
export async function setEnabled(
  pool: UserPool,
  username: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await pool.client.send(
      new AdminEnableUserCommand({ UserPoolId: pool.poolId, Username: username }),
    );
    return;
  }
  if (username === pool.actingAs) throw new UserRefusal(DISABLE_SELF_ERROR);
  if (await isLastEnabledAdmin(pool, username)) throw new UserRefusal(LAST_ADMIN_ERROR);
  await pool.client.send(
    new AdminDisableUserCommand({ UserPoolId: pool.poolId, Username: username }),
  );
  await signOutEverywhere(pool, username);
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
 * Returns the password once, for the admin to send; it is stored nowhere.
 *
 * The account returns to `FORCE_CHANGE_PASSWORD`, so the person chooses a new
 * password at their next sign-in, on any device. Existing sessions are left
 * alone: a person who only forgot a password keeps syncing on the devices
 * still signed in.
 */
export async function resetPassword(pool: UserPool, username: string): Promise<string> {
  const password = temporaryPassword();
  await pool.client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: pool.poolId,
      Username: username,
      Password: password,
      Permanent: false,
    }),
  );
  return password;
}

/**
 * The account an email or a username names. Throws {@link UserInputError}
 * when none does.
 */
export async function findUser(pool: UserPool, ref: string): Promise<UserView> {
  const users = await listUsers(pool);
  const wanted = ref.trim().toLowerCase();
  const user =
    users.find((u) => u.username === ref) ?? users.find((u) => u.email?.toLowerCase() === wanted);
  if (!user) throw new UserInputError(`No account has the email or username "${ref}".`);
  return user;
}
