/**
 * `createCapabilityBrokerRole` / `deleteCapabilityBrokerRole` (plan §3.3).
 *
 * This role is the ONLY identity in the system that carries Bedrock invoke, and
 * its standing S3 grant is what the broker's per-assume session policy narrows
 * (a session policy can only trim — see the §7 PoC TC3). So three things are
 * load-bearing and asserted here: the boundary that caps it, the trust policy
 * that decides who may borrow it, and the inline grant's exact contents.
 *
 * The create path also carries a live-only race: the trust policy names the CDS
 * role minted moments earlier, and IAM's validator is eventually consistent
 * about brand-new principals. The propagation retry (and its 120s ceiling) is
 * exercised here with fake timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  EntityAlreadyExistsException,
  MalformedPolicyDocumentException,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";
import { createCapabilityBrokerRole, deleteCapabilityBrokerRole } from "../src/iam";

const iamMock = mockClient(IAMClient);

const ACCOUNT = "111122223333";
const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/starkeep-capability-broker-permissions-boundary`;
const ROLE_NAME = "starkeep-app-capability-broker-role";

function input() {
  return {
    stackPrefix: "starkeep",
    accountId: ACCOUNT,
    capabilityBrokerPermissionsBoundaryArn: BOUNDARY_ARN,
    managerCreds: { accessKeyId: "AKIA", secretAccessKey: "secret" },
  };
}

function createInput() {
  return iamMock.commandCalls(CreateRoleCommand)[0]!.args[0].input;
}

interface Statement {
  Sid?: string;
  Effect: string;
  Action?: string | string[];
  Resource?: string | string[];
  Principal?: { Service?: string; AWS?: string };
}

/** The `capability-invoke` inline policy document, parsed. */
function inlinePolicy(): { Version: string; Statement: Statement[] } {
  const put = iamMock.commandCalls(PutRolePolicyCommand)[0]!.args[0].input;
  expect(put.PolicyName).toBe("capability-invoke");
  expect(put.RoleName).toBe(ROLE_NAME);
  return JSON.parse(put.PolicyDocument!);
}

function statement(sid: string): Statement {
  const s = inlinePolicy().Statement.find((x) => x.Sid === sid);
  if (!s) throw new Error(`no statement ${sid}`);
  return s;
}

function propagationError(): MalformedPolicyDocumentException {
  return new MalformedPolicyDocumentException({
    message:
      "Invalid principal in policy: \"AWS\":\"arn:aws:iam::111122223333:role/starkeep-app-cloud-data-server-role\"",
    $metadata: {},
  });
}

beforeEach(() => {
  iamMock.reset();
  iamMock.onAnyCommand().resolves({});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createCapabilityBrokerRole — role shape", () => {
  it("mints the role under the Bedrock-invoke-only capability boundary", async () => {
    const arn = await createCapabilityBrokerRole(input());
    expect(arn).toBe(`arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`);
    expect(createInput().RoleName).toBe(ROLE_NAME);
    // The boundary is the ceiling; the inline policy below is only the grant.
    expect(createInput().PermissionsBoundary).toBe(BOUNDARY_ARN);
  });

  it("tags the role as managed, under the capability-broker app id", async () => {
    await createCapabilityBrokerRole(input());
    expect(createInput().Tags).toContainEqual({
      Key: "starkeep:appId",
      Value: "capability-broker",
    });
    expect(createInput().Tags).toContainEqual({ Key: "starkeep:managed", Value: "true" });
  });

  it("names the CDS role as a trust principal (the single-hop assume)", async () => {
    await createCapabilityBrokerRole(input());
    const trust = JSON.parse(createInput().AssumeRolePolicyDocument!) as { Statement: Statement[] };
    const principals = trust.Statement.map((s) => s.Principal?.AWS ?? s.Principal?.Service);
    expect(principals).toContain(`arn:aws:iam::${ACCOUNT}:role/starkeep-app-cloud-data-server-role`);
    // Manager (for management) and Lambda (exec identity) are the other two.
    expect(principals).toContain(`arn:aws:iam::${ACCOUNT}:role/starkeep-manager-role`);
    expect(principals).toContain("lambda.amazonaws.com");
    expect(trust.Statement.every((s) => s.Action === "sts:AssumeRole")).toBe(true);
  });

  it("trusts no principal outside this account", async () => {
    await createCapabilityBrokerRole(input());
    const doc = JSON.parse(createInput().AssumeRolePolicyDocument!) as { Statement: Statement[] };
    for (const s of doc.Statement) {
      expect(s.Principal?.AWS).not.toBe("*");
      if (s.Principal?.AWS) expect(s.Principal.AWS).toContain(`:${ACCOUNT}:`);
    }
  });
});

describe("createCapabilityBrokerRole — the capability-invoke inline policy", () => {
  beforeEach(async () => {
    await createCapabilityBrokerRole(input());
  });

  it("attaches exactly one inline policy, with the two expected statements", () => {
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(1);
    const doc = inlinePolicy();
    expect(doc.Version).toBe("2012-10-17");
    expect(doc.Statement.map((s) => s.Sid)).toEqual([
      "CapabilityBedrockInvoke",
      "CapabilitySessionScopedS3IO",
    ]);
  });

  it("Allows the sync, streaming AND async Bedrock invoke verbs", () => {
    const s = statement("CapabilityBedrockInvoke");
    expect(s.Effect).toBe("Allow");
    expect(s.Action).toEqual([
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:StartAsyncInvoke",
      "bedrock:GetAsyncInvoke",
      "bedrock:ListAsyncInvokes",
    ]);
  });

  it("scopes the Bedrock resources to this account's profiles and async jobs", () => {
    // Model restriction lives in the usage-limitation framework, not IAM — so
    // foundation-model/* is deliberate. The account-scoped ARNs are not.
    expect(statement("CapabilityBedrockInvoke").Resource).toEqual([
      "arn:aws:bedrock:*::foundation-model/*",
      `arn:aws:bedrock:*:${ACCOUNT}:inference-profile/*`,
      `arn:aws:bedrock:*:${ACCOUNT}:application-inference-profile/*`,
      `arn:aws:bedrock:*:${ACCOUNT}:async-invoke/*`,
    ]);
  });

  it("grants NOTHING but Bedrock and the files-bucket S3 I/O", () => {
    const actions = inlinePolicy()
      .Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action!]))
      .filter(Boolean);
    expect(actions.every((a) => a.startsWith("bedrock:") || a.startsWith("s3:"))).toBe(true);
    // No IAM, STS, DSQL, SSM, Lambda reach from this identity.
    expect(actions.some((a) => /^(iam|sts|dsql|ssm|lambda):/.test(a))).toBe(false);
  });

  it("carries the standing S3 grant the session policy narrows — scoped to the files bucket", () => {
    const s = statement("CapabilitySessionScopedS3IO");
    expect(s.Effect).toBe("Allow");
    expect(s.Action).toEqual(["s3:GetObject", "s3:PutObject"]);
    // A session policy can only TRIM this, so it must exist — but the blast
    // radius of a forgotten session policy stays the files bucket, never `*`.
    expect(s.Resource).toBe("arn:aws:s3:::starkeep-files-*/*");
    expect(s.Resource).not.toBe("*");
  });

  it("grants no S3 bucket-level or delete reach", () => {
    const s = statement("CapabilitySessionScopedS3IO");
    expect(s.Action).not.toContain("s3:DeleteObject");
    expect(s.Action).not.toContain("s3:ListBucket");
  });

  it("derives every resource ARN from the stack prefix and account", async () => {
    iamMock.reset();
    iamMock.onAnyCommand().resolves({});
    await createCapabilityBrokerRole({ ...input(), stackPrefix: "other", accountId: "444455556666" });
    const put = iamMock.commandCalls(PutRolePolicyCommand)[0]!.args[0].input;
    expect(put.RoleName).toBe("other-app-capability-broker-role");
    expect(put.PolicyDocument).toContain("arn:aws:s3:::other-files-*/*");
    expect(put.PolicyDocument).toContain("arn:aws:bedrock:*:444455556666:inference-profile/*");
    expect(put.PolicyDocument).not.toContain(ACCOUNT);
  });
});

describe("createCapabilityBrokerRole — re-install (role already exists)", () => {
  beforeEach(() => {
    iamMock.on(CreateRoleCommand).rejects(
      new EntityAlreadyExistsException({ message: "exists", $metadata: {} }),
    );
  });

  it("heals trust drift instead of failing", async () => {
    const arn = await createCapabilityBrokerRole(input());
    expect(arn).toBe(`arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`);
    const updates = iamMock.commandCalls(UpdateAssumeRolePolicyCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args[0].input.RoleName).toBe(ROLE_NAME);
    const trust = JSON.parse(updates[0]!.args[0].input.PolicyDocument!) as { Statement: Statement[] };
    expect(JSON.stringify(trust)).toContain("starkeep-app-cloud-data-server-role");
  });

  it("still re-puts the inline policy (so a policy change lands on re-install)", async () => {
    await createCapabilityBrokerRole(input());
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(1);
    expect(inlinePolicy().Statement.map((s) => s.Sid)).toEqual([
      "CapabilityBedrockInvoke",
      "CapabilitySessionScopedS3IO",
    ]);
  });

  it("does NOT retry on the already-exists path (the CDS role long propagated)", async () => {
    await createCapabilityBrokerRole(input());
    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(1);
  });
});

describe("createCapabilityBrokerRole — IAM principal-propagation retry", () => {
  it("retries a not-yet-visible CDS principal and succeeds once it propagates", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    iamMock.on(CreateRoleCommand).callsFake(async () => {
      if (++attempts < 3) throw propagationError();
      return {};
    });
    const p = createCapabilityBrokerRole(input());
    // Backoff is 1s, then 2s.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe(`arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`);
    expect(attempts).toBe(3);
    // Having created it fresh, there is no trust-heal update.
    expect(iamMock.commandCalls(UpdateAssumeRolePolicyCommand)).toHaveLength(0);
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(1);
  });

  it("backs off exponentially, capped at 8s", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    iamMock.on(CreateRoleCommand).rejects(propagationError());
    const p = createCapabilityBrokerRole(input()).catch(() => "rejected");
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(8000);
    await p;
    for (const call of setTimeoutSpy.mock.calls) {
      const ms = call[1] as number;
      delays.push(ms);
    }
    expect(delays.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(Math.max(...delays)).toBe(8000);
  });

  it("gives up at the 120s ceiling and rethrows the IAM error", async () => {
    vi.useFakeTimers();
    iamMock.on(CreateRoleCommand).rejects(propagationError());
    const settled = createCapabilityBrokerRole(input()).then(
      () => "resolved",
      (e: Error) => e,
    );
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(8000);
    const result = await settled;
    expect(result).toBeInstanceOf(MalformedPolicyDocumentException);
    // Bounded: ~1+2+4+8×n over 120s, not an unbounded spin.
    const attempts = iamMock.commandCalls(CreateRoleCommand).length;
    expect(attempts).toBeGreaterThan(3);
    expect(attempts).toBeLessThan(30);
    // Nothing was attached to a role that was never created.
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });

  it("does NOT retry a malformed-policy error that is not about a principal", async () => {
    iamMock.on(CreateRoleCommand).rejects(
      new MalformedPolicyDocumentException({ message: "Syntax errors in policy", $metadata: {} }),
    );
    await expect(createCapabilityBrokerRole(input())).rejects.toThrow(/Syntax errors/);
    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(1);
  });

  it("propagates any other IAM error immediately", async () => {
    iamMock.on(CreateRoleCommand).rejects(new Error("throttled"));
    await expect(createCapabilityBrokerRole(input())).rejects.toThrow("throttled");
    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(1);
    expect(iamMock.commandCalls(PutRolePolicyCommand)).toHaveLength(0);
  });
});

describe("deleteCapabilityBrokerRole", () => {
  it("removes the inline policy before the role", async () => {
    await deleteCapabilityBrokerRole({
      stackPrefix: "starkeep",
      managerCreds: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
    const delPolicy = iamMock.commandCalls(DeleteRolePolicyCommand);
    const delRole = iamMock.commandCalls(DeleteRoleCommand);
    expect(delPolicy).toHaveLength(1);
    expect(delPolicy[0]!.args[0].input).toMatchObject({
      RoleName: ROLE_NAME,
      PolicyName: "capability-invoke",
    });
    expect(delRole).toHaveLength(1);
    expect(delRole[0]!.args[0].input.RoleName).toBe(ROLE_NAME);
  });

  it("is idempotent when the role and its policy are already gone", async () => {
    iamMock
      .on(DeleteRolePolicyCommand)
      .rejects(new NoSuchEntityException({ message: "gone", $metadata: {} }));
    iamMock.on(DeleteRoleCommand).rejects(new NoSuchEntityException({ message: "gone", $metadata: {} }));
    await expect(
      deleteCapabilityBrokerRole({
        stackPrefix: "starkeep",
        managerCreds: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      }),
    ).resolves.toBeUndefined();
  });

  it("still deletes the role when only the inline policy is missing", async () => {
    iamMock
      .on(DeleteRolePolicyCommand)
      .rejects(new NoSuchEntityException({ message: "gone", $metadata: {} }));
    await deleteCapabilityBrokerRole({
      stackPrefix: "starkeep",
      managerCreds: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
    expect(iamMock.commandCalls(DeleteRoleCommand)).toHaveLength(1);
  });

  it("propagates a non-NoSuchEntity failure rather than reporting a clean teardown", async () => {
    iamMock.on(DeleteRoleCommand).rejects(new Error("DeleteConflict"));
    await expect(
      deleteCapabilityBrokerRole({
        stackPrefix: "starkeep",
        managerCreds: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      }),
    ).rejects.toThrow("DeleteConflict");
  });

  it("targets the role for the given stack prefix", async () => {
    await deleteCapabilityBrokerRole({
      stackPrefix: "other",
      managerCreds: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    });
    expect(iamMock.commandCalls(DeleteRoleCommand)[0]!.args[0].input.RoleName).toBe(
      "other-app-capability-broker-role",
    );
  });
});
