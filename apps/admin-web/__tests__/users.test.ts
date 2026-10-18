/**
 * /api/users — the deployment's accounts and their two groups.
 *
 * Pins what the route refuses as much as what it does: removing the last
 * admin, and disabling the signed-in operator. Disabling also signs the user
 * out and deletes their device records, so their machines stop syncing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { jsonRequest, makeDataDir } from "./helpers";

const listDeviceRecords = vi.fn();
const deleteDeviceKeyParameter = vi.fn();
const roleChain = vi.fn();

vi.mock("@starkeep/admin-installer/app-creds", () => ({
  listDeviceRecords: (...args: unknown[]) => listDeviceRecords(...args),
  deleteDeviceKeyParameter: (...args: unknown[]) => deleteDeviceKeyParameter(...args),
}));
vi.mock("@starkeep/admin-installer/session", () => ({
  roleChain: (...args: unknown[]) => roleChain(...args),
}));

const cognito = mockClient(CognitoIdentityProviderClient);
let route: typeof import("../src/routes/users");

const SESSION = {
  credentials: { accessKeyId: "AKIA-ADMIN", secretAccessKey: "s", sessionToken: "t", expiration: "x" },
  stackPrefix: "sktest",
  region: "us-east-2",
  userSub: "sub-admin",
};

/** The pool's users and group memberships, as Cognito would hold them. */
let users: Array<{ Username: string; email: string; Enabled?: boolean }>;
let groups: Record<string, Set<string>>;

beforeAll(async () => {
  const dir = makeDataDir("adminweb-users-");
  process.env.STARKEEP_DIR = dir;
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      stackPrefix: "sktest",
      accountId: "123456789012",
      userPoolId: "us-east-2_POOL",
      managerRoleArn: "arn:aws:iam::123456789012:role/sktest-manager-role",
    }),
  );
  route = await import("../src/routes/users");
});

beforeEach(() => {
  users = [
    { Username: "sub-admin", email: "admin@example.com" },
    { Username: "sub-sam", email: "sam@example.com" },
  ];
  groups = { "starkeep-admins": new Set(["sub-admin"]), "starkeep-users": new Set(["sub-admin", "sub-sam"]) };
  cognito.reset();
  cognito.on(ListUsersCommand).callsFake(async () => ({
    Users: users.map((u) => ({
      Username: u.Username,
      Enabled: u.Enabled ?? true,
      UserStatus: "CONFIRMED",
      Attributes: [{ Name: "email", Value: u.email }],
    })),
  }));
  cognito.on(ListUsersInGroupCommand).callsFake(async (input: { GroupName: string }) => ({
    Users: [...(groups[input.GroupName] ?? [])].map((Username) => ({ Username })),
  }));
  cognito.on(AdminAddUserToGroupCommand).callsFake(async (input: { GroupName: string; Username: string }) => {
    groups[input.GroupName]!.add(input.Username);
    return {};
  });
  cognito.on(AdminRemoveUserFromGroupCommand).callsFake(async (input: { GroupName: string; Username: string }) => {
    groups[input.GroupName]!.delete(input.Username);
    return {};
  });
  cognito.on(AdminCreateUserCommand).callsFake(async (input: { Username: string }) => {
    users.push({ Username: `sub-${input.Username.split("@")[0]}`, email: input.Username });
    return { User: { Username: `sub-${input.Username.split("@")[0]}` } };
  });
  cognito.on(AdminDisableUserCommand).callsFake(async (input: { Username: string }) => {
    users.find((u) => u.Username === input.Username)!.Enabled = false;
    return {};
  });
  cognito.on(AdminUserGlobalSignOutCommand).resolves({});
  listDeviceRecords.mockReset().mockResolvedValue([
    { deviceId: "dev-sam-phone", userId: "sub-sam" },
    { deviceId: "dev-admin-laptop", userId: "sub-admin" },
  ]);
  deleteDeviceKeyParameter.mockReset().mockResolvedValue(undefined);
  roleChain.mockReset().mockResolvedValue({ accessKeyId: "ASIA-MANAGER", secretAccessKey: "s", sessionToken: "t", expiration: new Date() });
});

const post = (fn: (req: Request) => Promise<Response>, body: unknown) => fn(jsonRequest("/api/users", body));

describe("listing", () => {
  it("shows each account with its two memberships", async () => {
    const res = await post(route.LIST, SESSION);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { users: unknown[] }).users).toEqual([
      { username: "sub-admin", email: "admin@example.com", enabled: true, status: "CONFIRMED", admin: true, data: true },
      { username: "sub-sam", email: "sam@example.com", enabled: true, status: "CONFIRMED", admin: false, data: true },
    ]);
    // As the operator, not Manager: user management is the admin role's own grant.
    expect(roleChain).not.toHaveBeenCalled();
  });
});

describe("creating an account", () => {
  it("creates the user with an emailed invitation and adds the chosen groups", async () => {
    const res = await post(route.CREATE, { ...SESSION, email: "kim@example.com", data: true });
    expect(res.status).toBe(200);
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toMatchObject({
      UserPoolId: "us-east-2_POOL",
      Username: "kim@example.com",
      DesiredDeliveryMediums: ["EMAIL"],
    });
    expect(groups["starkeep-users"]!.has("sub-kim")).toBe(true);
    expect(groups["starkeep-admins"]!.has("sub-kim")).toBe(false);
  });

  it("refuses something that is not an email address", async () => {
    const res = await post(route.CREATE, { ...SESSION, email: "kim" });
    expect(res.status).toBe(400);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});

describe("changing groups", () => {
  it("adds and removes a membership", async () => {
    await post(route.SET_GROUP, { ...SESSION, username: "sub-sam", group: "starkeep-admins", member: true });
    expect(groups["starkeep-admins"]!.has("sub-sam")).toBe(true);
    await post(route.SET_GROUP, { ...SESSION, username: "sub-sam", group: "starkeep-users", member: false });
    expect(groups["starkeep-users"]!.has("sub-sam")).toBe(false);
  });

  it("refuses to remove the last admin", async () => {
    const res = await post(route.SET_GROUP, { ...SESSION, username: "sub-admin", group: "starkeep-admins", member: false });
    expect(res.status).toBe(409);
    expect(groups["starkeep-admins"]!.has("sub-admin")).toBe(true);
  });

  it("refuses a group that is not one of the two", async () => {
    const res = await post(route.SET_GROUP, { ...SESSION, username: "sub-sam", group: "root", member: true });
    expect(res.status).toBe(400);
  });
});

describe("disabling an account", () => {
  it("disables, signs out everywhere, and deletes that user's device records only", async () => {
    const res = await post(route.SET_ENABLED, { ...SESSION, username: "sub-sam", enabled: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { devicesRevoked: string[] }).devicesRevoked).toEqual(["dev-sam-phone"]);
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)[0]!.args[0].input).toMatchObject({ Username: "sub-sam" });
    expect(deleteDeviceKeyParameter).toHaveBeenCalledTimes(1);
    const [args] = deleteDeviceKeyParameter.mock.calls[0] as [{ deviceId: string; awsCreds: { accessKeyId: string } }];
    expect(args.deviceId).toBe("dev-sam-phone");
    expect(args.awsCreds.accessKeyId).toBe("ASIA-MANAGER");
  });

  it("refuses to disable the signed-in operator", async () => {
    const res = await post(route.SET_ENABLED, { ...SESSION, username: "sub-admin", enabled: false });
    expect(res.status).toBe(409);
    expect(cognito.commandCalls(AdminDisableUserCommand)).toHaveLength(0);
  });
});

describe("the temporary password's fit to the pool", () => {
  it("always satisfies the password policy the bootstrap template gives the pool", async () => {
    // Cognito refuses a temporary password that breaks the pool's policy, and
    // "Reset password" would then fail for that one draw. The policy lives in
    // the bootstrap template, so check every draw against it there.
    const { generateBootstrapTemplate } = await import("@starkeep/aws-bootstrap");
    const template = generateBootstrapTemplate();
    const policy = template.match(/PasswordPolicy:\s*\n((?:\s+\w+: .+\n)+)/)?.[1] ?? "";
    const field = (name: string) => policy.match(new RegExp(`${name}: (\\S+)`))?.[1];
    const minimum = Number(field("MinimumLength"));
    expect(minimum).toBeGreaterThan(0);

    for (let i = 0; i < 2_000; i++) {
      const password = route.temporaryPassword();
      expect(password.length).toBeGreaterThanOrEqual(minimum);
      if (field("RequireUppercase") === "true") expect(password).toMatch(/[A-Z]/);
      if (field("RequireLowercase") === "true") expect(password).toMatch(/[a-z]/);
      if (field("RequireNumbers") === "true") expect(password).toMatch(/[0-9]/);
      if (field("RequireSymbols") === "true") expect(password).toMatch(/[^A-Za-z0-9]/);
    }
  });
});

describe("resetting a password", () => {
  it("sets a temporary password the person must replace, and answers it once", async () => {
    cognito.on(AdminSetUserPasswordCommand).resolves({});
    const res = await route.RESET_PASSWORD(jsonRequest("/api/users/password", { ...SESSION, username: "sub-sam" }));
    expect(res.status).toBe(200);
    const { temporaryPassword } = (await res.json()) as { temporaryPassword: string };
    expect(temporaryPassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    const sent = cognito.commandCalls(AdminSetUserPasswordCommand)[0]!.args[0].input;
    expect(sent).toEqual({ UserPoolId: "us-east-2_POOL", Username: "sub-sam", Password: temporaryPassword, Permanent: false });
  });

  it("leaves the account enabled and its sessions alone", async () => {
    cognito.on(AdminSetUserPasswordCommand).resolves({});
    await route.RESET_PASSWORD(jsonRequest("/api/users/password", { ...SESSION, username: "sub-sam" }));
    expect(cognito.commandCalls(AdminDisableUserCommand)).toHaveLength(0);
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(0);
  });

  it("draws a fresh password each time", async () => {
    cognito.on(AdminSetUserPasswordCommand).resolves({});
    const passwords = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await route.RESET_PASSWORD(jsonRequest("/api/users/password", { ...SESSION, username: "sub-sam" }));
      passwords.add(((await res.json()) as { temporaryPassword: string }).temporaryPassword);
    }
    expect(passwords.size).toBe(5);
  });

  it("refuses a request that names no account", async () => {
    const res = await route.RESET_PASSWORD(jsonRequest("/api/users/password", { ...SESSION }));
    expect(res.status).toBe(400);
  });
});
