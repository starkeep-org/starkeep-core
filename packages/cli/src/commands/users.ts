/**
 * The `user` commands: the deployment's accounts, as admin-web's Users
 * section manages them, through `@starkeep/operator/users`. Every command
 * runs as the signed-in admin and names an account by its email or its
 * username. The messages are admin-web's.
 */
import { readConfig } from "@starkeep/operator/config";
import {
  ADMINS_GROUP,
  createUser,
  DATA_GROUP,
  findUser,
  GroupStepFailed,
  listUsers,
  resetPassword,
  setEnabled,
  setGroup,
  signOutEverywhere,
  userPool,
  UserInputError,
  UserNotFound,
  UserRefusal,
  type Group,
  type UserPool,
  type UserView,
} from "@starkeep/operator/users";
import { adminCredentialsOrSignIn } from "../cloud";
import { flag, type Command, type ParsedArgs } from "../command";
import { CliError, EXIT_USAGE, usageError } from "../errors";
import type { Io } from "../io";

async function pool(io: Io): Promise<UserPool> {
  const poolId = readConfig()?.userPoolId;
  if (typeof poolId !== "string") {
    throw new CliError("This computer has no cloud. Run `starkeep setup --cloud` first.");
  }
  return userPool(await adminCredentialsOrSignIn(io), poolId);
}

/**
 * Run `act`, turning a refusal or an unknown account into exit 1 and bad
 * input into exit 2.
 */
async function acting<T>(act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (err) {
    if (err instanceof UserRefusal) throw new CliError(err.message, 1, "REFUSED");
    if (err instanceof UserNotFound) throw new CliError(err.message, 1, "NOT_FOUND");
    if (err instanceof GroupStepFailed) {
      const flagName = err.group === ADMINS_GROUP ? "--admin" : "--data";
      throw new CliError(
        `${err.message}\nThe account exists. Add the group with \`starkeep user grant ${err.email} ${flagName}\`.`,
        1,
        "PARTIAL",
      );
    }
    if (err instanceof UserInputError) throw new CliError(err.message, EXIT_USAGE, "INVALID_INPUT");
    throw err;
  }
}

const name = (u: UserView) => u.email ?? u.username;

function oneAccount(args: ParsedArgs, verb: string): string {
  if (args.positionals.length !== 1) {
    throw usageError(`Name one account by its email: starkeep user ${verb} <email>`);
  }
  return args.positionals[0]!;
}

/** The groups `--admin` and `--data` name. */
function groupsOf(args: ParsedArgs, verb: string): Group[] {
  const groups: Group[] = [
    ...(flag(args, "admin") ? [ADMINS_GROUP as Group] : []),
    ...(flag(args, "data") ? [DATA_GROUP as Group] : []),
  ];
  if (groups.length === 0) {
    throw usageError(
      `Name the group: starkeep user ${verb} <email> --admin (cloud operator rights) or --data (a synced library).`,
    );
  }
  return groups;
}

function state(u: UserView): string {
  if (!u.enabled) return "disabled";
  if (u.status === "FORCE_CHANGE_PASSWORD") return "invited";
  return "active";
}

const GROUP_FLAGS = {
  admin: {
    type: "boolean" as const,
    description: "The admins group: cloud operator rights in admin-web and the CLI.",
  },
  data: { type: "boolean" as const, description: "The data group: a library that syncs." },
};

export const userListCommand: Command = {
  name: "user list",
  summary: "List the deployment's accounts and their groups",
  usage: "",
  lane: "admin",
  flags: {},
  async run(io) {
    const users = await acting(async () => listUsers(await pool(io)));
    if (io.json) {
      io.event({ type: "result", ok: true, data: { users } });
      return;
    }
    if (users.length === 0) {
      io.print("No accounts.");
      return;
    }
    const width = Math.max(5, ...users.map((u) => name(u).length)) + 2;
    io.print(`${"EMAIL".padEnd(width)}${"ADMIN".padEnd(7)}${"DATA".padEnd(6)}STATE`);
    for (const u of users) {
      io.print(
        `${name(u).padEnd(width)}${(u.admin ? "yes" : "—").padEnd(7)}${(u.data ? "yes" : "—").padEnd(6)}${state(u)}`,
      );
    }
  },
};

export const userAddCommand: Command = {
  name: "user add",
  summary: "Invite a person, in the groups you name",
  usage: "<email> (--admin | --data)...",
  lane: "admin",
  flags: GROUP_FLAGS,
  details:
    "Cognito emails the person a temporary password, which they replace at their first\n" +
    "sign-in. --data gives the account a library that syncs; --admin gives it cloud\n" +
    "operator rights. An account needs one of them, and may have both.",
  async run(io, args) {
    const email = oneAccount(args, "add").trim();
    // An account in no group can neither sync nor manage the cloud.
    groupsOf(args, "add");
    await acting(async () =>
      createUser(await pool(io), { email, admin: flag(args, "admin"), data: flag(args, "data") }),
    );
    io.event({
      type: "progress",
      message: `Created ${email}. Cognito has emailed a temporary password.`,
    });
    io.event({ type: "result", ok: true, data: { email } });
  },
};

function membershipCommand(verb: "grant" | "revoke"): Command {
  return {
    name: `user ${verb}`,
    summary:
      verb === "grant"
        ? "Add an account to the admins or the data group"
        : "Take an account out of the admins or the data group",
    usage: "<email> (--admin | --data)",
    lane: "admin",
    flags: GROUP_FLAGS,
    details:
      verb === "revoke"
        ? "Taking the last enabled admin out of the admins group is refused. A member taken out\n" +
          "of the data group stops syncing within fifteen minutes."
        : undefined,
    async run(io, args) {
      const ref = oneAccount(args, verb);
      const groups = groupsOf(args, verb);
      const user = await acting(async () => {
        const p = await pool(io);
        const found = await findUser(p, ref);
        for (const group of groups) await setGroup(p, found.username, group, verb === "grant");
        return found;
      });
      io.event({ type: "progress", message: `Updated ${name(user)}.` });
      io.event({ type: "result", ok: true, data: { username: user.username, groups } });
    },
  };
}

export const userGrantCommand = membershipCommand("grant");
export const userRevokeCommand = membershipCommand("revoke");

export const userResetPasswordCommand: Command = {
  name: "user reset-password",
  summary: "Give an account a new temporary password, shown once",
  usage: "<email>",
  lane: "admin",
  flags: {},
  details:
    "The person chooses their own password at their next sign-in, on any device. Their\n" +
    "devices that are signed in stay signed in. Nothing stores the temporary password.",
  async run(io, args) {
    const ref = oneAccount(args, "reset-password");
    const { user, password } = await acting(async () => {
      const p = await pool(io);
      const found = await findUser(p, ref);
      return { user: found, password: await resetPassword(p, found.username) };
    });
    io.event({
      type: "progress",
      message:
        `New temporary password for ${name(user)}: ${password}. ` +
        "Send it to them; they choose their own at their next sign-in. It is not shown again.",
    });
    io.event({
      type: "result",
      ok: true,
      data: { username: user.username, temporaryPassword: password },
    });
  },
};

export const userSignOutCommand: Command = {
  name: "user sign-out",
  summary: "Sign an account out of every device, keeping the account",
  usage: "<email>",
  lane: "admin",
  flags: {},
  async run(io, args) {
    const ref = oneAccount(args, "sign-out");
    const user = await acting(async () => {
      const p = await pool(io);
      const found = await findUser(p, ref);
      await signOutEverywhere(p, found.username);
      return found;
    });
    io.event({
      type: "progress",
      message:
        `Signed ${name(user)} out of every device. Each one stops syncing within ` +
        "15 minutes and asks them to sign in again.",
    });
    io.event({ type: "result", ok: true, data: { username: user.username } });
  },
};

function enabledCommand(enabled: boolean): Command {
  const verb = enabled ? "enable" : "disable";
  return {
    name: `user ${verb}`,
    summary: enabled
      ? "Let a disabled account sign in again"
      : "Stop an account signing in, and sign it out of every device",
    usage: "<email>",
    lane: "admin",
    flags: {},
    details: enabled
      ? undefined
      : "Disabling your own account, or the last enabled admin, is refused.",
    async run(io, args) {
      const ref = oneAccount(args, verb);
      const user = await acting(async () => {
        const p = await pool(io);
        const found = await findUser(p, ref);
        await setEnabled(p, found.username, enabled);
        return found;
      });
      io.event({
        type: "progress",
        message: enabled
          ? `Enabled ${name(user)}. They sign in again on each device.`
          : `Disabled ${name(user)} and signed them out of every device.`,
      });
      io.event({ type: "result", ok: true, data: { username: user.username, enabled } });
    },
  };
}

export const userEnableCommand = enabledCommand(true);
export const userDisableCommand = enabledCommand(false);

export const USER_COMMANDS: Command[] = [
  userListCommand,
  userAddCommand,
  userGrantCommand,
  userRevokeCommand,
  userResetPasswordCommand,
  userSignOutCommand,
  userDisableCommand,
  userEnableCommand,
];
