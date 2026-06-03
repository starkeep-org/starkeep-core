import { describe, it, expect } from "vitest";
import { generateBootstrapTemplate, generateExternalId } from "../src/bootstrap-template";
import { TEST_DATA } from "./test-helpers";

describe("Bootstrap Template Generation", () => {
  describe("generateBootstrapTemplate", () => {
    it("should generate a valid CloudFormation template with required resources", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      // Should be valid YAML/CloudFormation
      expect(template).toContain("AWSTemplateFormatVersion: '2010-09-09'");
      expect(template).toContain("Description:");

      // Should have required parameters
      expect(template).toContain("ControlPlaneAccountId:");
      expect(template).toContain("ExternalId:");
      expect(template).toContain("StackPrefix:");

      // Should create all three IAM resources
      expect(template).toContain("StarkeeperPermissionBoundary:");
      expect(template).toContain("Type: AWS::IAM::ManagedPolicy");
      expect(template).toContain("StarkeeperCloudFormationExecutionRole:");
      expect(template).toContain("StarkeeperRole:");
      expect(template).toContain("Type: AWS::IAM::Role");

      // Should have outputs
      expect(template).toContain("Outputs:");
      expect(template).toContain("RoleArn:");
      expect(template).toContain("ExecutionRoleArn:");
      expect(template).toContain("PermissionBoundaryArn:");
    });

    it("should include control plane account ID in parameters", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      expect(template).toContain(`Default: ${TEST_DATA.controlPlaneAccountId}`);
    });

    it("should include external ID in parameters", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      expect(template).toContain(`Default: ${TEST_DATA.externalId}`);
    });

    it("should use default stack prefix when not provided", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      expect(template).toContain("Default: app");
    });

    it("should use custom stack prefix when provided", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
        stackPrefix: "myapp",
      });

      expect(template).toContain("Default: myapp");
    });

    it("should include region restrictions when allowedRegions provided", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
        allowedRegions: ["us-east-1", "us-west-2"],
      });

      expect(template).toContain("aws:RequestedRegion:");
      expect(template).toContain("'us-east-1'");
      expect(template).toContain("'us-west-2'");
    });

    it("should not include region restrictions when allowedRegions not provided", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      // Should have CloudFormation operations but no region condition
      expect(template).toContain("CloudFormationChangeSetOperations");
      expect(template).not.toContain("aws:RequestedRegion:");
    });

    it("should enforce permission boundary on IAM role creation", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      // CloudFormation execution role should require permission boundary
      expect(template).toContain("iam:PermissionsBoundary: !Ref StarkeeperPermissionBoundary");
    });

    it("should scope CloudFormation operations to stack prefix", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
        stackPrefix: "testapp",
      });

      // Should scope to stack prefix pattern
      expect(template).toContain("arn:aws:cloudformation:*:${AWS::AccountId}:stack/${StackPrefix}-*/*");
    });

    it("should only allow PassRole to CloudFormation execution role", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      expect(template).toContain("PassRoleToCloudFormation");
      expect(template).toContain("Resource: !GetAtt StarkeeperCloudFormationExecutionRole.Arn");
      expect(template).toContain("iam:PassedToService: cloudformation.amazonaws.com");
    });

    it("should include permission boundary denials for privilege escalation", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      expect(template).toContain("Effect: Deny");
      expect(template).toContain("iam:CreateUser");
      expect(template).toContain("iam:CreateAccessKey");
      expect(template).toContain("iam:PassRole");
    });
  });

  describe("generateExternalId", () => {
    it("should generate a random external ID", () => {
      const externalId = generateExternalId();
      expect(externalId).toBeDefined();
      expect(externalId.length).toBe(32);
    });

    it("should generate alphanumeric characters only", () => {
      const externalId = generateExternalId();
      expect(externalId).toMatch(/^[A-Za-z0-9]+$/);
    });

    it("should generate unique IDs", () => {
      const id1 = generateExternalId();
      const id2 = generateExternalId();
      expect(id1).not.toBe(id2);
    });
  });
});
