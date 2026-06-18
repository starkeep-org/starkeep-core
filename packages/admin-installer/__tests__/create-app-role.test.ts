import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
  EntityAlreadyExistsException,
} from "@aws-sdk/client-iam";
import { createAppRole, type CreateAppRoleInput } from "../src/iam";

const iamMock = mockClient(IAMClient);

const BOUNDARIES = {
  permissionsBoundaryArn: "arn:aws:iam::111122223333:policy/starkeep-app-permissions-boundary",
  foundationalPermissionsBoundaryArn:
    "arn:aws:iam::111122223333:policy/starkeep-foundational-permissions-boundary",
  userDataOwnerPermissionsBoundaryArn:
    "arn:aws:iam::111122223333:policy/starkeep-user-data-owner-permissions-boundary",
};

function input(over: Partial<CreateAppRoleInput> = {}): CreateAppRoleInput {
  return {
    stackPrefix: "starkeep",
    appId: "photos",
    accountId: "111122223333",
    ...BOUNDARIES,
    fileAccess: [
      { types: ["image/jpeg", "image/png"], access: "readwrite", metadataWrite: true, rationale: "t" },
    ],
    fileAccessAll: false,
    brokerPower: false,
    managerCreds: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    ...over,
  };
}

beforeEach(() => {
  iamMock.reset();
  iamMock.onAnyCommand().resolves({});
});

function createRoleInput() {
  return iamMock.commandCalls(CreateRoleCommand)[0].args[0].input;
}

describe("boundary routing — the magic-string check", () => {
  it("ordinary apps are born under the per-app boundary", async () => {
    const arn = await createAppRole(input());
    expect(arn).toBe("arn:aws:iam::111122223333:role/starkeep-app-photos-role");
    expect(createRoleInput().PermissionsBoundary).toBe(BOUNDARIES.permissionsBoundaryArn);
    expect(createRoleInput().RoleName).toBe("starkeep-app-photos-role");
  });

  it("cloud-data-server (and only it) gets the foundational boundary", async () => {
    await createAppRole(input({ appId: "cloud-data-server" }));
    expect(createRoleInput().PermissionsBoundary).toBe(
      BOUNDARIES.foundationalPermissionsBoundaryArn,
    );
    // ...and its trust policy must not name its own (not-yet-existing) role.
    const trust = JSON.parse(createRoleInput().AssumeRolePolicyDocument!);
    expect(JSON.stringify(trust)).not.toContain("app-cloud-data-server-role");
  });

  it("starkeep-drive (and only it) gets the user-data-owner boundary", async () => {
    await createAppRole(input({ appId: "starkeep-drive", fileAccess: [], fileAccessAll: true }));
    expect(createRoleInput().PermissionsBoundary).toBe(
      BOUNDARIES.userDataOwnerPermissionsBoundaryArn,
    );
  });

  it("an app id merely resembling a built-in stays on the per-app boundary", async () => {
    await createAppRole(input({ appId: "cloud-data-server2" }));
    expect(createRoleInput().PermissionsBoundary).toBe(BOUNDARIES.permissionsBoundaryArn);
  });

  it("tags the role with the app id (drives PrincipalTag scoping)", async () => {
    await createAppRole(input());
    expect(createRoleInput().Tags).toContainEqual({ Key: "starkeep:appId", Value: "photos" });
  });
});

describe("re-install (role already exists)", () => {
  it("heals the trust policy instead of failing", async () => {
    iamMock.on(CreateRoleCommand).rejects(
      new EntityAlreadyExistsException({ message: "exists", $metadata: {} }),
    );
    await createAppRole(input());
    const update = iamMock.commandCalls(UpdateAssumeRolePolicyCommand);
    expect(update).toHaveLength(1);
    expect(update[0].args[0].input.RoleName).toBe("starkeep-app-photos-role");
  });

  it("propagates non-already-exists errors", async () => {
    iamMock.on(CreateRoleCommand).rejects(new Error("throttled"));
    await expect(createAppRole(input())).rejects.toThrow("throttled");
  });
});

describe("inline policies", () => {
  it("always attaches the runtime policy", async () => {
    await createAppRole(input());
    const puts = iamMock.commandCalls(PutRolePolicyCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0].args[0].input.PolicyName).toBe("runtime");
    const doc = JSON.parse(puts[0].args[0].input.PolicyDocument!);
    expect(doc.Version).toBe("2012-10-17");
  });

  it("attaches broker-power only when the manifest claims it", async () => {
    await createAppRole(input({ appId: "cloud-data-server", brokerPower: true }));
    const puts = iamMock.commandCalls(PutRolePolicyCommand);
    const names = puts.map((c) => c.args[0].input.PolicyName);
    expect(names).toEqual(["runtime", "broker-power"]);
    const broker = JSON.parse(puts[1].args[0].input.PolicyDocument!);
    const sids = broker.Statement.map((s: { Sid: string }) => s.Sid);
    expect(sids).toEqual([
      "BrokerAssumeAppRoles",
      "BrokerReadAppCreds",
      "BrokerReadAppCredsKmsDecrypt",
    ]);
    expect(broker.Statement[0].Resource).toBe(
      "arn:aws:iam::111122223333:role/starkeep-app-*",
    );
  });
});
