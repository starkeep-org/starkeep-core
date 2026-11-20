/** The owner lane: who the terminal is, and the bootstrap stack it creates. */
import { describe, expect, it } from "vitest";
import {
  CreateStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { MAX_INLINE_TEMPLATE_BYTES } from "@starkeep/aws-bootstrap";
import {
  bootstrapOutputs,
  callerIdentity,
  createBootstrapStack,
  describeBootstrapStack,
} from "../src/bootstrap";

const OUTPUTS = [
  ["UserPoolId", "us-east-2_abc"],
  ["UserPoolClientId", "admin-client"],
  ["DeviceUserPoolClientId", "device-client"],
  ["CognitoDomain", "sk.auth.us-east-2.amazoncognito.com"],
  ["IdentityPoolId", "us-east-2:pool"],
  ["ManagerRoleArn", "arn:aws:iam::1:role/sk-manager-role"],
  ["PulumiStateBucketName", "sk-pulumi-state"],
].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));

const STACK: Stack = {
  StackName: "sk-bootstrap",
  StackStatus: "CREATE_COMPLETE",
  CreationTime: new Date(),
  Outputs: OUTPUTS,
};

describe("callerIdentity", () => {
  it("names the account and the caller, and spots the root user", async () => {
    const sts = { send: async () => ({ Account: "123", Arn: "arn:aws:iam::123:root" }) };
    expect(await callerIdentity("us-east-2", { sts: sts as never })).toEqual({
      account: "123",
      arn: "arn:aws:iam::123:root",
      isRoot: true,
    });
  });

  it("says how to sign in when the terminal has no working credentials", async () => {
    const sts = {
      send: async () => {
        throw new Error("Could not load credentials from any providers");
      },
    };
    await expect(callerIdentity("us-east-2", { sts: sts as never })).rejects.toThrow(
      "aws sso login",
    );
  });
});

describe("the bootstrap stack", () => {
  it("reads a missing stack as null", async () => {
    const cf = {
      send: async () => {
        throw Object.assign(new Error("Stack with id sk-bootstrap does not exist"), {
          name: "ValidationError",
        });
      },
    };
    expect(
      await describeBootstrapStack("sk", "us-east-2", { cloudFormation: cf as never }),
    ).toBeNull();
  });

  it("creates the stack inline, with the admin's email, and returns it", async () => {
    const sent: unknown[] = [];
    const cf = {
      send: async (command: unknown) => {
        sent.push(command);
        return command instanceof DescribeStacksCommand ? { Stacks: [STACK] } : {};
      },
    };
    const stack = await createBootstrapStack(
      {
        stackPrefix: "sk",
        region: "us-east-2",
        deploymentName: "Home",
        adminEmail: "me@example.com",
      },
      { cloudFormation: cf as never, waitForCreate: async () => {} },
    );
    expect(stack).toBe(STACK);
    const create = sent.find((c) => c instanceof CreateStackCommand) as CreateStackCommand;
    expect(create.input.StackName).toBe("sk-bootstrap");
    expect(create.input.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(create.input.Parameters).toContainEqual({
      ParameterKey: "AdminEmail",
      ParameterValue: "me@example.com",
    });
    // Inline, without comments, and under the cap.
    expect(create.input.TemplateBody).not.toMatch(/^\s*#/m);
    expect(Buffer.byteLength(create.input.TemplateBody!)).toBeLessThan(MAX_INLINE_TEMPLATE_BYTES);
  });

  it("maps the outputs onto config.json's names", () => {
    expect(bootstrapOutputs(STACK)).toEqual({
      userPoolId: "us-east-2_abc",
      userPoolClientId: "admin-client",
      deviceUserPoolClientId: "device-client",
      cognitoDomain: "sk.auth.us-east-2.amazoncognito.com",
      identityPoolId: "us-east-2:pool",
      managerRoleArn: "arn:aws:iam::1:role/sk-manager-role",
      pulumiStateBucket: "sk-pulumi-state",
    });
  });

  it("names the update for a stack that predates an output setup needs", () => {
    const old = { ...STACK, Outputs: OUTPUTS.filter((o) => o.OutputKey !== "CognitoDomain") };
    expect(() => bootstrapOutputs(old)).toThrow("update-bootstrap.sh");
  });
});
