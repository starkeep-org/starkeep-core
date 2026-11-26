/**
 * Managing the deployment's accounts from admin-web's Users section. The
 * logic, the two groups and the refusals live in `@starkeep/operator/users`,
 * which `starkeep user` calls too. Each route here reads its body, acts as
 * the signed-in admin, and answers the account list.
 *
 * A refusal (the last enabled admin, the signed-in admin) answers 409, and
 * bad input answers 400.
 */
import { readStarkeepConfig } from "@starkeep/operator/config";
import {
  createUser,
  GROUPS,
  listUsers,
  resetPassword,
  setEnabled,
  setGroup,
  signOutEverywhere,
  userPool,
  UserInputError,
  UserRefusal,
  type Group,
  type UserPool,
} from "@starkeep/operator/users";
import { requireAdmin } from "../lib/admin-auth";

export { ADMINS_GROUP, DATA_GROUP, temporaryPassword, type UserView } from "@starkeep/operator/users";

function userPoolId(): string {
  const config = readStarkeepConfig() as { userPoolId?: string };
  if (!config.userPoolId)
    throw new Error("~/.starkeep/config.json has no userPoolId — complete the cloud setup first");
  return config.userPoolId;
}

/**
 * Run `act` as the signed-in admin, then answer the account list. A refusal
 * answers 409, bad input 400, and any other failure 500.
 */
async function acting(
  label: string,
  act: (pool: UserPool) => Promise<Record<string, unknown> | void>,
): Promise<Response> {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  try {
    const pool = userPool(admin, userPoolId());
    const extra = (await act(pool)) ?? {};
    return Response.json({ users: await listUsers(pool), ...extra });
  } catch (err) {
    if (err instanceof UserRefusal) return Response.json({ error: err.message }, { status: 409 });
    if (err instanceof UserInputError)
      return Response.json({ error: err.message }, { status: 400 });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/users] ${label} failed`, message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** Every account, with its two group memberships. */
export async function LIST(_req: Request): Promise<Response> {
  return acting("list", async () => {});
}

/** Create an account. Body: `{ email, admin?, data? }`. Cognito emails the invitation. */
export async function CREATE(req: Request): Promise<Response> {
  const body = (await req.json()) as { email?: string; admin?: boolean; data?: boolean };
  return acting("create", (pool) =>
    createUser(pool, {
      email: typeof body.email === "string" ? body.email : "",
      admin: body.admin === true,
      data: body.data === true,
    }),
  );
}

/** Add an account to a group or take it out. Body: `{ username, group, member }`. */
export async function SET_GROUP(req: Request): Promise<Response> {
  const { username, group, member } = (await req.json()) as {
    username?: string;
    group?: string;
    member?: boolean;
  };
  if (!username || !GROUPS.includes(group as Group) || typeof member !== "boolean") {
    return Response.json({ error: "username, group and member are required" }, { status: 400 });
  }
  return acting("set group", (pool) => setGroup(pool, username, group as Group, member));
}

/** Sign an account out of every device, without disabling it. Body: `{ username }`. */
export async function SIGN_OUT_EVERYWHERE(req: Request): Promise<Response> {
  const { username } = (await req.json()) as { username?: string };
  if (!username) return Response.json({ error: "username is required" }, { status: 400 });
  return acting("sign out everywhere", (pool) => signOutEverywhere(pool, username));
}

/** Disable an account, or enable it again. Body: `{ username, enabled }`. */
export async function SET_ENABLED(req: Request): Promise<Response> {
  const { username, enabled } = (await req.json()) as { username?: string; enabled?: boolean };
  if (!username || typeof enabled !== "boolean") {
    return Response.json({ error: "username and enabled are required" }, { status: 400 });
  }
  return acting("set enabled", (pool) => setEnabled(pool, username, enabled));
}

/**
 * Give an account a new temporary password. Body: `{ username }`. Answers the
 * password once, for the admin to send; it is stored nowhere.
 */
export async function RESET_PASSWORD(req: Request): Promise<Response> {
  const { username } = (await req.json()) as { username?: string };
  if (!username) return Response.json({ error: "username is required" }, { status: 400 });
  return acting("reset password", async (pool) => ({
    temporaryPassword: await resetPassword(pool, username),
  }));
}
