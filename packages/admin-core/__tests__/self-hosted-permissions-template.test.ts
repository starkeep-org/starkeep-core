import { describe, it, expect } from "vitest";
import { generateSelfHostedPermissionsTemplate } from "../src/self-hosted-permissions-template";
import { deployPermissionStatements } from "../src/self-hosted-deploy-policy";

describe("generateSelfHostedPermissionsTemplate", () => {
  it("generates a syntactically reasonable CloudFormation YAML template", () => {
    const yaml = generateSelfHostedPermissionsTemplate();
    expect(yaml).toContain("AWSTemplateFormatVersion: '2010-09-09'");
    expect(yaml).toContain("Type: AWS::IAM::ManagedPolicy");
    expect(yaml).toContain("ManagedPolicyName: !Sub '${StackPrefix}-deploy-permissions'");
    expect(yaml).toContain("Outputs:");
    expect(yaml).toContain("ManagedPolicyArn:");
  });

  it("attaches the managed policy to both bootstrap roles", () => {
    const yaml = generateSelfHostedPermissionsTemplate();
    expect(yaml).toContain("- !Sub '${StackPrefix}-admin-desktop-role'");
    expect(yaml).toContain("- !Sub '${StackPrefix}-codebuild-deploy-role'");
  });

  it("uses the default stack prefix when none provided", () => {
    const yaml = generateSelfHostedPermissionsTemplate();
    expect(yaml).toContain("Default: starkeep");
  });

  it("uses the provided stack prefix", () => {
    const yaml = generateSelfHostedPermissionsTemplate({ stackPrefix: "myproj" });
    expect(yaml).toContain("Default: myproj");
  });

  it("includes every Sid from deployPermissionStatements()", () => {
    const yaml = generateSelfHostedPermissionsTemplate();
    for (const stmt of deployPermissionStatements()) {
      expect(yaml).toContain(`Sid: ${stmt.Sid}`);
    }
  });

  it("includes the new permissions identified as missing on fresh accounts", () => {
    const yaml = generateSelfHostedPermissionsTemplate();
    expect(yaml).toContain("Sid: SstBootstrapEcr");
    expect(yaml).toContain("Sid: IAMServiceLinkedRoleDsql");
    expect(yaml).toContain("'ecr:CreateRepository'");
    expect(yaml).toContain("'iam:CreateServiceLinkedRole'");
    expect(yaml).toContain("'dsql.amazonaws.com'");
  });
});
