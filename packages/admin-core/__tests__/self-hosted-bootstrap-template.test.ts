import { describe, it, expect } from "vitest";
import { generateSelfHostedBootstrapTemplate } from "../src/self-hosted-bootstrap-template";

describe("generateSelfHostedBootstrapTemplate (slim)", () => {
  const yaml = generateSelfHostedBootstrapTemplate();

  it("generates a syntactically reasonable CloudFormation template", () => {
    expect(yaml).toContain("AWSTemplateFormatVersion: '2010-09-09'");
    expect(yaml).toContain("Type: AWS::Cognito::UserPool");
    expect(yaml).toContain("Type: AWS::Cognito::UserPoolClient");
    expect(yaml).toContain("Type: AWS::Cognito::IdentityPool");
    expect(yaml).toContain("Type: AWS::IAM::Role");
    expect(yaml).toContain("Type: AWS::S3::Bucket");
    expect(yaml).toContain("Type: AWS::CodeBuild::Project");
  });

  it("does NOT include the SST-deploy permissions (those live in the permissions stack)", () => {
    // These SIDs should now ONLY appear in the permissions stack template.
    expect(yaml).not.toContain("Sid: AuroraDsqlDeploy");
    expect(yaml).not.toContain("Sid: LambdaDeploy");
    expect(yaml).not.toContain("Sid: ApiGatewayDeploy");
    expect(yaml).not.toContain("Sid: S3DeployAccess");
    expect(yaml).not.toContain("Sid: CloudFormationDeploy");
    expect(yaml).not.toContain("Sid: SstBootstrapSSM");
    expect(yaml).not.toContain("Sid: SstBootstrapEcr");
  });

  it("includes the bootstrap inline policy with permissions-stack management", () => {
    expect(yaml).toContain("Sid: BootstrapStsIdentity");
    expect(yaml).toContain("Sid: BootstrapCognitoUserMgmt");
    expect(yaml).toContain("Sid: BootstrapCodeBuildTrigger");
    expect(yaml).toContain("Sid: BootstrapArtifactsWrite");
    expect(yaml).toContain("Sid: PermissionsStackManage");
    expect(yaml).toContain("Sid: PermissionsManagedPolicyMutate");
    expect(yaml).toContain("Sid: PermissionsAttachConstrained");
  });

  it("constrains attachable policies to the deploy-permissions name prefix", () => {
    // The security boundary: a compromised admin-web cannot attach
    // AdministratorAccess (or any other arbitrary policy) to its own role.
    expect(yaml).toContain("Sid: PermissionsAttachConstrained");
    expect(yaml).toContain("ArnLike:");
    expect(yaml).toContain(
      "'iam:PolicyARN': !Sub 'arn:aws:iam::${AWS::AccountId}:policy/${StackPrefix}-deploy-permissions*'",
    );
  });

  it("scopes permissions-stack CloudFormation actions to the named stack", () => {
    expect(yaml).toContain(
      "!Sub 'arn:aws:cloudformation:*:${AWS::AccountId}:stack/${StackPrefix}-deploy-permissions/*'",
    );
  });

  it("exposes the permissions stack name and role names as outputs", () => {
    expect(yaml).toContain("PermissionsStackName:");
    expect(yaml).toContain("AuthenticatedRoleName:");
    expect(yaml).toContain("CodeBuildServiceRoleName:");
  });

  it("keeps the existing outputs needed by admin-desktop setup", () => {
    expect(yaml).toContain("UserPoolId:");
    expect(yaml).toContain("UserPoolClientId:");
    expect(yaml).toContain("IdentityPoolId:");
    expect(yaml).toContain("ConsoleLink:");
    expect(yaml).toContain("ArtifactsBucketName:");
    expect(yaml).toContain("CodeBuildProjectName:");
  });

  it("uses the default stack prefix when none provided", () => {
    expect(yaml).toContain("Default: starkeep");
  });

  it("uses the provided stack prefix", () => {
    const custom = generateSelfHostedBootstrapTemplate({ stackPrefix: "myproj" });
    expect(custom).toContain("Default: myproj");
  });
});
