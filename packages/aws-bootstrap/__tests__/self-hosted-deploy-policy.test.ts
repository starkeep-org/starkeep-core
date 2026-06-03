import { describe, it, expect } from "vitest";
import {
  deployPermissionStatements,
  renderStatementsYaml,
  statementMetadata,
  type IamStatement,
} from "../src/self-hosted-deploy-policy";

describe("deployPermissionStatements", () => {
  const statements = deployPermissionStatements();
  const sids = statements.map((s) => s.Sid);

  it("includes the SST bootstrap permissions that fail on fresh accounts", () => {
    expect(sids).toContain("SstBootstrapEcr");
    expect(sids).toContain("SstBootstrapSSM");
    expect(sids).toContain("IAMServiceLinkedRoleDsql");
  });

  it("includes the user-data deploy permissions", () => {
    for (const sid of [
      "AuroraDsqlDeploy",
      "LambdaDeploy",
      "ApiGatewayDeploy",
      "S3DeployAccess",
      "CloudFormationDeploy",
      "IAMDeployRoles",
      "IAMPassRoleDeploy",
    ]) {
      expect(sids).toContain(sid);
    }
  });

  it("scopes ECR permissions to sst-asset-* repos only", () => {
    const ecr = statements.find((s) => s.Sid === "SstBootstrapEcr")!;
    expect(ecr).toBeDefined();
    expect(JSON.stringify(ecr.Resource)).toContain("repository/sst-asset-*");
    expect(ecr.Action).not.toContain("ecr:PutImage");
    expect(ecr.Action).not.toContain("ecr:UploadLayerPart");
  });

  it("scopes the DSQL service-linked role create to dsql.amazonaws.com", () => {
    const slr = statements.find((s) => s.Sid === "IAMServiceLinkedRoleDsql")!;
    expect(slr).toBeDefined();
    expect(slr.Action).toBe("iam:CreateServiceLinkedRole");
    expect(slr.Condition?.StringLike?.["iam:AWSServiceName"]).toBe("dsql.amazonaws.com");
  });

  it("constrains iam:PassRole to the expected services", () => {
    const pass = statements.find((s) => s.Sid === "IAMPassRoleDeploy")!;
    const services = pass.Condition?.StringLike?.["iam:PassedToService"];
    expect(services).toContain("lambda.amazonaws.com");
    expect(services).toContain("cloudformation.amazonaws.com");
    expect(services).toContain("apigateway.amazonaws.com");
  });

  it("has metadata for every statement", () => {
    for (const sid of sids) {
      expect(statementMetadata[sid], `missing metadata for ${sid}`).toBeDefined();
      expect(statementMetadata[sid]!.label.length).toBeGreaterThan(0);
      expect(statementMetadata[sid]!.reason.length).toBeGreaterThan(0);
      expect(statementMetadata[sid]!.requiredBy.length).toBeGreaterThan(0);
    }
  });

  it("does not have metadata for unknown SIDs", () => {
    for (const sid of Object.keys(statementMetadata)) {
      expect(sids, `metadata refers to unknown SID ${sid}`).toContain(sid);
    }
  });
});

describe("renderStatementsYaml", () => {
  it("renders a plain string Resource as a quoted scalar", () => {
    const stmt: IamStatement = {
      Sid: "Test",
      Effect: "Allow",
      Action: "s3:ListAllMyBuckets",
      Resource: "*",
    };
    const yaml = renderStatementsYaml([stmt], 0);
    expect(yaml).toContain("- Sid: Test");
    expect(yaml).toContain("Effect: Allow");
    expect(yaml).toContain("Action: 's3:ListAllMyBuckets'");
    expect(yaml).toContain("Resource: '*'");
  });

  it("renders a Sub CFN intrinsic as !Sub", () => {
    const stmt: IamStatement = {
      Sid: "Test",
      Effect: "Allow",
      Action: "lambda:*",
      Resource: { Sub: "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:foo*" },
    };
    const yaml = renderStatementsYaml([stmt], 0);
    expect(yaml).toContain(
      "Resource: !Sub 'arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:foo*'",
    );
  });

  it("renders multiple resources as a YAML list", () => {
    const stmt: IamStatement = {
      Sid: "Test",
      Effect: "Allow",
      Action: "s3:*",
      Resource: ["arn:aws:s3:::a", "arn:aws:s3:::b"],
    };
    const yaml = renderStatementsYaml([stmt], 0);
    expect(yaml).toContain("Resource:");
    expect(yaml).toContain("- 'arn:aws:s3:::a'");
    expect(yaml).toContain("- 'arn:aws:s3:::b'");
  });

  it("renders multiple actions as a YAML list", () => {
    const stmt: IamStatement = {
      Sid: "Test",
      Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:PutLogEvents"],
      Resource: "*",
    };
    const yaml = renderStatementsYaml([stmt], 0);
    expect(yaml).toContain("Action:");
    expect(yaml).toContain("- 'logs:CreateLogGroup'");
    expect(yaml).toContain("- 'logs:PutLogEvents'");
  });

  it("renders Condition with quoted keys and CFN intrinsics", () => {
    const stmt: IamStatement = {
      Sid: "Test",
      Effect: "Allow",
      Action: "iam:AttachRolePolicy",
      Resource: "arn:aws:iam::*:role/foo",
      Condition: {
        ArnLike: {
          "iam:PolicyARN": { Sub: "arn:aws:iam::${AWS::AccountId}:policy/foo*" },
        },
        StringLike: {
          "iam:PassedToService": ["lambda.amazonaws.com", "apigateway.amazonaws.com"],
        },
      },
    };
    const yaml = renderStatementsYaml([stmt], 0);
    expect(yaml).toContain("Condition:");
    expect(yaml).toContain("ArnLike:");
    expect(yaml).toContain(
      "'iam:PolicyARN': !Sub 'arn:aws:iam::${AWS::AccountId}:policy/foo*'",
    );
    expect(yaml).toContain("StringLike:");
    expect(yaml).toContain("'iam:PassedToService':");
    expect(yaml).toContain("- 'lambda.amazonaws.com'");
  });

  it("respects the indentSpaces argument", () => {
    const stmt: IamStatement = {
      Sid: "Test",
      Effect: "Allow",
      Action: "s3:GetObject",
      Resource: "*",
    };
    const yaml = renderStatementsYaml([stmt], 4);
    expect(yaml.startsWith("    - Sid: Test")).toBe(true);
  });

  it("escapes single quotes inside !Sub strings", () => {
    const stmt: IamStatement = {
      Sid: "Test",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: { Sub: "arn:aws:s3:::it's-a-bucket" },
    };
    const yaml = renderStatementsYaml([stmt], 0);
    expect(yaml).toContain("!Sub 'arn:aws:s3:::it''s-a-bucket'");
  });
});
