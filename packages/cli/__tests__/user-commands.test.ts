/**
 * The `user` commands through `main`: what each prints, the refusals and
 * their exit codes. Cognito is mocked, and the admin session is a stand-in.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const dir = mkdtempSync(join(tmpdir(), "cli-users-"));
process.env.STARKEEP_DIR = dir;
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify({ stackPrefix: "sk", userPoolId: "us-east-2_POOL" }),
);

vi.mock("@starkeep/operator/admin-session", async (original) => ({
  ...(await original<typeof import("@starkeep/operator/admin-session")>()),
  adminCredentials: async () => ({
    stsCredentials: {
      accessKeyId: "AKIA",
      secretAccessKey: "s",
      sessionToken: "t",
      expiration: "2030-01-01T00:00:00Z",
    },
    sub: "sub-admin",
    region: "us-east-2",
    email: "admin@example.com",
  }),
}));

const { main } = await import("../src/main");
const cognito = mockClient(CognitoIdentityProviderClient);

let users: Array<{ Username: string; email: string; Enabled?: boolean; status?: string }>;
let groups: Record<string, Set<string>>;

beforeEach(() => {
  users = [
    { Username: "sub-admin", email: "admin@example.com" },
    { Username: "sub-sam", email: "sam@example.com" },
    { Username: "sub-kim", email: "kim@example.com", status: "FORCE_CHANGE_PASSWORD" },
  ];
  groups = {
    "starkeep-admins": new Set(["sub-admin"]),
    "starkeep-users": new Set(["sub-admin", "sub-sam"]),
  };
  cognito.reset();
  cognito.on(ListUsersCommand).callsFake(async () => ({
    Users: users.map((u) => ({
      Username: u.Username,
      Enabled: u.Enabled ?? true,
      UserStatus: u.status ?? "CONFIRMED",
      Attributes: [{ Name: "email", Value: u.email }],
    })),
  }));
  cognito.on(ListUsersInGroupCommand).callsFake(async (input: { GroupName: string }) => ({
    Users: [...(groups[input.GroupName] ?? [])].map((name) => ({
      Username: name,
      Enabled: users.find((u) => u.Username === name)?.Enabled ?? true,
    })),
  }));
  cognito.on(AdminCreateUserCommand).resolves({ User: { Username: "sub-new" } });
  cognito.on(AdminAddUserToGroupCommand).resolves({});
  cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
  cognito.on(AdminDisableUserCommand).resolves({});
  cognito.on(AdminUserGlobalSignOutCommand).resolves({});
  cognito.on(AdminSetUserPasswordCommand).resolves({});
});

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    cwd: dir,
    interactive: false,
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
  });
  return { code, out, err };
}

describe("starkeep user", () => {
  it("lists every account with its groups and state", async () => {
    const { code, out } = await run("user", "list");
    expect(code).toBe(0);
    expect(out).toMatch(/EMAIL\s+ADMIN\s+DATA\s+STATE/);
    expect(out).toMatch(/admin@example\.com\s+yes\s+yes\s+active/);
    expect(out).toMatch(/kim@example\.com\s+—\s+—\s+invited/);
    expect(out).toMatch(/sam@example\.com\s+—\s+yes\s+active/);
  });

  it("invites a person into the groups named, and says Cognito emailed the password", async () => {
    const { code, out } = await run("user", "add", "lee@example.com", "--data");
    expect(code).toBe(0);
    expect(out).toContain("Created lee@example.com. Cognito has emailed a temporary password.");
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toMatchObject({
      Username: "lee@example.com",
      DesiredDeliveryMediums: ["EMAIL"],
    });
    expect(
      cognito.commandCalls(AdminAddUserToGroupCommand).map((c) => c.args[0].input.GroupName),
    ).toEqual(["starkeep-users"]);
  });

  it("refuses an address that is not an email with exit status 2", async () => {
    const { code, err } = await run("user", "add", "lee", "--data");
    expect(code).toBe(2);
    expect(err).toContain("Enter the person's email address.");
  });

  it("grants and revokes a group by email", async () => {
    expect((await run("user", "grant", "sam@example.com", "--admin")).out).toContain(
      "Updated sam@example.com.",
    );
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0]!.args[0].input).toMatchObject({
      Username: "sub-sam",
      GroupName: "starkeep-admins",
    });
    await run("user", "revoke", "sam@example.com", "--data");
    expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand)[0]!.args[0].input).toMatchObject({
      Username: "sub-sam",
      GroupName: "starkeep-users",
    });
  });

  it("asks which group when neither --admin nor --data is given", async () => {
    const { code, err } = await run("user", "grant", "sam@example.com");
    expect(code).toBe(2);
    expect(err).toContain("--admin (cloud operator rights) or --data (a synced library)");
  });

  it("refuses to take the last enabled admin's rights away, and changes nothing", async () => {
    const { code, err } = await run("user", "revoke", "admin@example.com", "--admin");
    expect(code).toBe(1);
    expect(err).toContain("This is the last admin. Make someone else an admin first.");
    expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand)).toHaveLength(0);
  });

  it("refuses to disable the signed-in admin's own account", async () => {
    groups["starkeep-admins"]!.add("sub-sam");
    const { code, err } = await run("user", "disable", "admin@example.com");
    expect(code).toBe(1);
    expect(err).toContain("You cannot disable your own account.");
    expect(cognito.commandCalls(AdminDisableUserCommand)).toHaveLength(0);
  });

  it("disables a member and signs them out of every device", async () => {
    const { code, out } = await run("user", "disable", "sam@example.com");
    expect(code).toBe(0);
    expect(out).toContain("Disabled sam@example.com and signed them out of every device.");
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)[0]!.args[0].input.Username).toBe(
      "sub-sam",
    );
  });

  it("signs a member out of every device and keeps the account", async () => {
    const { out } = await run("user", "sign-out", "sam@example.com");
    expect(out).toContain(
      "Signed sam@example.com out of every device. Each one stops syncing within 15 minutes and asks them to sign in again.",
    );
    expect(cognito.commandCalls(AdminDisableUserCommand)).toHaveLength(0);
  });

  it("shows a reset's temporary password once, and sets it as temporary", async () => {
    const { out } = await run("user", "reset-password", "sam@example.com");
    const match =
      /New temporary password for sam@example\.com: ([A-HJ-NP-Za-km-z2-9]{16})\. Send it to them; they choose their own at their next sign-in\. It is not shown again\./.exec(
        out,
      );
    expect(match).not.toBeNull();
    expect(cognito.commandCalls(AdminSetUserPasswordCommand)[0]!.args[0].input).toMatchObject({
      Username: "sub-sam",
      Password: match![1],
      Permanent: false,
    });
  });

  it("says no account has an email it does not know, with exit status 1 and no usage text (ACCESS-226)", async () => {
    const { code, err } = await run("user", "disable", "nobody@example.com");
    expect(code).toBe(1);
    expect(err).toContain('No account has the email or username "nobody@example.com".');
    expect(err).not.toContain("Usage:");
  });

  it("refuses an email that already has an account, and changes nothing", async () => {
    cognito.on(AdminCreateUserCommand).rejects(
      Object.assign(new Error("User account already exists"), {
        name: "UsernameExistsException",
      }),
    );
    const { code, err } = await run("user", "add", "sam@example.com", "--data");
    expect(code).toBe(1);
    expect(err).toContain("An account with the email sam@example.com already exists.");
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
  });

  it("refuses an account in no group, before it creates anything", async () => {
    const { code, err } = await run("user", "add", "lee@example.com");
    expect(code).toBe(2);
    expect(err).toContain(
      "Name the group: starkeep user add <email> --admin (cloud operator rights) or --data (a synced library).",
    );
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it("says the account exists when its group step fails, and names the grant", async () => {
    cognito.on(AdminAddUserToGroupCommand).rejects(new Error("Rate exceeded"));
    const { code, err } = await run("user", "add", "lee@example.com", "--admin");
    expect(code).toBe(1);
    expect(err).toContain(
      "Created lee@example.com, but could not add it to the starkeep-admins group: Rate exceeded",
    );
    expect(err).toContain(
      "The account exists. Add the group with `starkeep user grant lee@example.com --admin`.",
    );
  });

  it("lists the user commands for `starkeep user`", async () => {
    const { code, err } = await run("user");
    expect(code).toBe(2);
    expect(err).toContain("Usage: starkeep user <command> [options]");
    expect(err).toContain("user reset-password");
  });
});
