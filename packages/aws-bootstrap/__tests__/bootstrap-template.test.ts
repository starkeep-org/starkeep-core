import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import {
  generateBootstrapTemplate,
  getCloudFormationCreateStackUrl,
  getBootstrapStackOutputsUrl,
  MAX_STACK_PREFIX_LENGTH,
} from "../src/bootstrap/index.js";

// CFN short-form intrinsics (!Sub / !Ref / !GetAtt) parsed into plain objects
// so the template is assertable as data.
const cfnTags = [
  { tag: "!Sub", resolve: (s: string) => ({ "Fn::Sub": s }) },
  { tag: "!Ref", resolve: (s: string) => ({ Ref: s }) },
  { tag: "!GetAtt", resolve: (s: string) => ({ "Fn::GetAtt": s }) },
];

interface CfnTemplate {
  Parameters: Record<string, Record<string, unknown>>;
  Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  Outputs: Record<string, unknown>;
}

function parseTemplate(stackPrefix?: string): CfnTemplate {
  const raw = generateBootstrapTemplate(stackPrefix ? { stackPrefix } : {});
  return parse(raw, { customTags: cfnTags }) as CfnTemplate;
}

const template = parseTemplate();
const resources = template.Resources;

function resourcesOfType(type: string): string[] {
  return Object.entries(resources)
    .filter(([, r]) => r.Type === type)
    .map(([name]) => name);
}

describe("bootstrap template structure", () => {
  it("is valid YAML with CFN short-form intrinsics", () => {
    expect(template.Parameters.StackPrefix).toMatchObject({
      Type: "String",
      Default: "starkeep",
      MaxLength: MAX_STACK_PREFIX_LENGTH,
      AllowedPattern: "^[a-z][a-z0-9-]*$",
    });
  });

  it("creates exactly the six permissions boundaries plus the Bedrock freeze policy", () => {
    expect(resourcesOfType("AWS::IAM::ManagedPolicy").sort()).toEqual([
      "AppFoundationalPermissionsBoundary",
      "AppPermissionsBoundary",
      // Not a boundary — the Deny document an action-enabled budget attaches to
      // the capability-broker role on breach.
      "BedrockFreezePolicy",
      "CapabilityBrokerPermissionsBoundary",
      "InstallDdlPermissionsBoundary",
      "InstallInfraPermissionsBoundary",
      "UserDataOwnerPermissionsBoundary",
    ]);
  });

  it("creates exactly the four install-time roles plus the budget-action role", () => {
    expect(resourcesOfType("AWS::IAM::Role").sort()).toEqual([
      "AdminAppRole",
      "BedrockBudgetActionRole",
      "InstallDdlRole",
      "InstallInfraRole",
      "ManagerRole",
    ]);
  });

  it("creates the Cognito auth chain and the two buckets", () => {
    expect(resources.UserPool.Type).toBe("AWS::Cognito::UserPool");
    expect(resources.UserPoolClient.Type).toBe("AWS::Cognito::UserPoolClient");
    expect(resources.IdentityPool.Type).toBe("AWS::Cognito::IdentityPool");
    expect(resources.IdentityPoolRoleAttachment.Type).toBe(
      "AWS::Cognito::IdentityPoolRoleAttachment",
    );
    expect(resourcesOfType("AWS::S3::Bucket").sort()).toEqual([
      "ArtifactsBucket",
      "PulumiStateBucket",
    ]);
  });

  it("interpolates a custom stack prefix into generation-time strings", () => {
    const raw = generateBootstrapTemplate({ stackPrefix: "teststk" });
    expect(raw).toContain("arn:aws:s3:::teststk-files-*/shared/*");
    expect(raw).not.toContain("arn:aws:s3:::starkeep-files-*");
  });
});

describe("trust policies (who can assume which role)", () => {
  function trustStatements(roleName: string): Array<Record<string, unknown>> {
    const role = resources[roleName].Properties as unknown as {
      AssumeRolePolicyDocument: { Statement: Array<Record<string, unknown>> };
    };
    return role.AssumeRolePolicyDocument.Statement;
  }

  it("AdminAppRole is assumable only via Cognito federation, gated on the identity pool", () => {
    const [stmt] = trustStatements("AdminAppRole");
    expect(trustStatements("AdminAppRole")).toHaveLength(1);
    expect(stmt).toMatchObject({
      Effect: "Allow",
      Principal: { Federated: "cognito-identity.amazonaws.com" },
      Action: "sts:AssumeRoleWithWebIdentity",
    });
    expect(stmt.Condition).toMatchObject({
      StringEquals: { "cognito-identity.amazonaws.com:aud": { Ref: "IdentityPool" } },
      "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
    });
  });

  it("ManagerRole is assumable only by AdminAppRole", () => {
    const [stmt] = trustStatements("ManagerRole");
    expect(trustStatements("ManagerRole")).toHaveLength(1);
    expect(stmt).toMatchObject({
      Effect: "Allow",
      Principal: { AWS: { "Fn::GetAtt": "AdminAppRole.Arn" } },
      Action: "sts:AssumeRole",
    });
  });

  it.each(["InstallDdlRole", "InstallInfraRole"])(
    "%s is assumable only by ManagerRole and is born under its boundary",
    (roleName) => {
      const [stmt] = trustStatements(roleName);
      expect(trustStatements(roleName)).toHaveLength(1);
      expect(stmt).toMatchObject({
        Effect: "Allow",
        Principal: { AWS: { "Fn::GetAtt": "ManagerRole.Arn" } },
        Action: "sts:AssumeRole",
      });
      const props = resources[roleName].Properties as unknown as {
        PermissionsBoundary: unknown;
      };
      expect(props.PermissionsBoundary).toEqual({
        Ref: roleName.replace("Role", "PermissionsBoundary"),
      });
    },
  );

  it("BedrockBudgetActionRole is assumable only by Budgets, with both confused-deputy conditions", () => {
    const [stmt] = trustStatements("BedrockBudgetActionRole");
    expect(trustStatements("BedrockBudgetActionRole")).toHaveLength(1);
    expect(stmt).toMatchObject({
      Effect: "Allow",
      Principal: { Service: "budgets.amazonaws.com" },
      Action: "sts:AssumeRole",
    });
    // Both conditions, not just the principal: a service principal alone lets
    // ANY account's budget assume this role.
    expect(stmt.Condition).toEqual({
      StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
      ArnLike: {
        "aws:SourceArn": {
          "Fn::Sub": "arn:aws:budgets::${AWS::AccountId}:budget/${StackPrefix}-*",
        },
      },
    });
  });

  it("BedrockBudgetActionRole's attach power is scoped to the broker role and the freeze policy", () => {
    const props = resources.BedrockBudgetActionRole.Properties as unknown as {
      PermissionsBoundary?: unknown;
      Policies: Array<{ PolicyDocument: { Statement: Array<Record<string, unknown>> } }>;
    };
    // Bootstrap-created, like Manager and admin-app — no boundary.
    expect(props.PermissionsBoundary).toBeUndefined();
    const statements = props.Policies[0].PolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    const [stmt] = statements;
    expect(stmt.Action).toEqual(["iam:AttachRolePolicy", "iam:DetachRolePolicy"]);
    // Enumerated role ARNs, never a `-app-*-role` wildcard.
    expect(stmt.Resource).toEqual([
      {
        "Fn::Sub":
          "arn:aws:iam::${AWS::AccountId}:role/${StackPrefix}-app-capability-broker-role",
      },
    ]);
    // The condition IS the security argument: without it this is "attach any
    // policy to the broker role", which is an escalation, not a guardrail.
    expect(stmt.Condition).toEqual({
      ArnEquals: { "iam:PolicyARN": { Ref: "BedrockFreezePolicy" } },
    });
  });

  it("the federated identity pool maps authenticated users to AdminAppRole", () => {
    const props = resources.IdentityPoolRoleAttachment.Properties as unknown as {
      Roles: Record<string, unknown>;
    };
    expect(props.Roles).toEqual({ authenticated: { "Fn::GetAtt": "AdminAppRole.Arn" } });
  });
});

describe("stack outputs", () => {
  it("exposes every output the wizard and installer consume", () => {
    expect(Object.keys(template.Outputs).sort()).toEqual(
      [
        "UserPoolId",
        "UserPoolClientId",
        "IdentityPoolId",
        "AdminAppRoleArn",
        "ManagerRoleArn",
        "AppPermissionsBoundaryArn",
        "AppFoundationalPermissionsBoundaryArn",
        "UserDataOwnerPermissionsBoundaryArn",
        "CapabilityBrokerPermissionsBoundaryArn",
        "BedrockFreezePolicyArn",
        "BedrockBudgetActionRoleArn",
        "InstallDdlRoleArn",
        "InstallInfraRoleArn",
        "PulumiStateBucketName",
        "ArtifactsBucketName",
        "Region",
        "StackPrefix",
        "ConsoleLink",
      ].sort(),
    );
  });
});

describe("console URL helpers", () => {
  it("builds the create-stack URL with an optional stack name", () => {
    expect(getCloudFormationCreateStackUrl("us-east-1")).toBe(
      "https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/template",
    );
    expect(getCloudFormationCreateStackUrl("us-east-1", { stackName: "my stack" })).toContain(
      "stackName=my%20stack",
    );
  });

  it("builds the stack-outputs URL filtered to the stack name", () => {
    const url = getBootstrapStackOutputsUrl("eu-west-1");
    expect(url).toContain("eu-west-1.console.aws.amazon.com/cloudformation");
    expect(url).toContain("filteringText=starkeep-bootstrap");
  });
});
