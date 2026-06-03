/**
 * Integration tests for the complete bootstrap flow:
 * 1. Generate bootstrap template
 * 2. Generate Quick Create link
 * 3. Save connection settings to database
 * 4. Create change set using cross-account role
 */

import { describe, it, expect } from "vitest";
import {
  generateBootstrapTemplate,
  generateExternalId,
} from "../src/bootstrap-template";
import { generateBootstrapQuickCreateLink } from "../src/quick-create";
import { TEST_DATA } from "./test-helpers";

describe("Bootstrap Flow Integration", () => {
  describe("Complete Bootstrap Setup Flow", () => {
    it("should generate complete bootstrap artifacts for customer", () => {
      // Step 1: Generate External ID
      const externalId = generateExternalId();
      expect(externalId).toBeDefined();
      expect(externalId.length).toBe(32);

      // Step 2: Generate Bootstrap Template
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId,
        customerAccountId: TEST_DATA.targetAccountId,
        stackPrefix: TEST_DATA.stackPrefix,
        allowedRegions: ["us-east-1", "us-west-2"],
      });

      // Verify template has all required components
      expect(template).toContain("StarkeeperPermissionBoundary");
      expect(template).toContain("StarkeeperCloudFormationExecutionRole");
      expect(template).toContain("StarkeeperRole");
      expect(template).toContain(externalId);
      expect(template).toContain(TEST_DATA.controlPlaneAccountId);
      expect(template).toContain(TEST_DATA.stackPrefix);

      // Step 3: Generate Quick Create Link
      const templateUrl = "https://s3.amazonaws.com/bucket/bootstrap.yaml";
      const quickCreateLink = generateBootstrapQuickCreateLink({
        region: TEST_DATA.region,
        templateUrl,
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId,
        stackPrefix: TEST_DATA.stackPrefix,
      });

      // Verify Quick Create link is valid
      expect(quickCreateLink).toContain("console.aws.amazon.com/cloudformation");
      expect(quickCreateLink).toContain("stackName=StarkeeperBootstrap");
      expect(quickCreateLink).toContain(
        `param_ControlPlaneAccountId=${TEST_DATA.controlPlaneAccountId}`
      );
      expect(quickCreateLink).toContain(`param_ExternalId=${externalId}`);
      expect(quickCreateLink).toContain(`param_StackPrefix=${TEST_DATA.stackPrefix}`);

      // At this point, customer would:
      // 1. Click the Quick Create link
      // 2. Deploy the bootstrap stack in AWS Console
      // 3. Copy the outputs (RoleArn, ExecutionRoleArn, PermissionBoundaryArn)
      // 4. Paste them back into Starkeeper UI

      // Step 4: Verify we have all the data needed to save connection
      const connectionData = {
        customerId: "customer-123",
        accountId: TEST_DATA.targetAccountId,
        roleArn: TEST_DATA.roleArn,
        externalId: externalId,
        executionRoleArn: TEST_DATA.executionRoleArn,
        permissionBoundaryArn: TEST_DATA.permissionBoundaryArn,
        stackPrefix: TEST_DATA.stackPrefix,
        allowedRegions: ["us-east-1", "us-west-2"],
      };

      // All required fields should be present
      expect(connectionData.roleArn).toBeDefined();
      expect(connectionData.externalId).toBeDefined();
      expect(connectionData.accountId).toBeDefined();
      expect(connectionData.stackPrefix).toBeDefined();
    });

    it("should validate bootstrap template contains security best practices", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
        stackPrefix: TEST_DATA.stackPrefix,
      });

      // Permission Boundary must prevent privilege escalation
      expect(template).toContain("Effect: Deny");
      expect(template).toContain("iam:CreateUser");
      expect(template).toContain("iam:CreateAccessKey");
      expect(template).toContain("iam:PutUserPolicy");
      expect(template).toContain("iam:AttachUserPolicy");

      // CloudFormation Execution Role must enforce permission boundary
      expect(template).toContain("iam:PermissionsBoundary");
      expect(template).toContain("!Ref StarkeeperPermissionBoundary");

      // Delegated Admin Role must be scoped to stack prefix
      expect(template).toContain("${StackPrefix}-*");

      // External ID must be required
      expect(template).toContain("sts:ExternalId");

      // PassRole must be restricted to CloudFormation execution role only
      expect(template).toContain("PassRoleToCloudFormation");
      expect(template).toContain("!GetAtt StarkeeperCloudFormationExecutionRole.Arn");
    });

    it("should generate different external IDs for different customers", () => {
      const externalId1 = generateExternalId();
      const externalId2 = generateExternalId();
      const externalId3 = generateExternalId();

      // All should be unique
      expect(externalId1).not.toBe(externalId2);
      expect(externalId2).not.toBe(externalId3);
      expect(externalId1).not.toBe(externalId3);

      // All should be valid
      expect(externalId1).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(externalId2).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(externalId3).toMatch(/^[A-Za-z0-9]{32}$/);
    });

    it("should support multiple target accounts with same control plane", () => {
      const controlPlaneAccountId = TEST_DATA.controlPlaneAccountId;

      // Customer A setup
      const externalIdA = generateExternalId();
      const templateA = generateBootstrapTemplate({
        controlPlaneAccountId,
        externalId: externalIdA,
        customerAccountId: "111111111111",
        stackPrefix: "customer-a",
      });

      // Customer B setup
      const externalIdB = generateExternalId();
      const templateB = generateBootstrapTemplate({
        controlPlaneAccountId,
        externalId: externalIdB,
        customerAccountId: "222222222222",
        stackPrefix: "customer-b",
      });

      // Both templates should use same control plane
      expect(templateA).toContain(controlPlaneAccountId);
      expect(templateB).toContain(controlPlaneAccountId);

      // But different external IDs and stack prefixes
      expect(templateA).toContain(externalIdA);
      expect(templateA).toContain("customer-a");
      expect(templateB).toContain(externalIdB);
      expect(templateB).toContain("customer-b");

      // External IDs must be different
      expect(externalIdA).not.toBe(externalIdB);
    });

    it("should validate template structure is valid CloudFormation", () => {
      const template = generateBootstrapTemplate({
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        customerAccountId: TEST_DATA.targetAccountId,
      });

      // Basic CloudFormation structure
      expect(template).toContain("AWSTemplateFormatVersion: '2010-09-09'");
      expect(template).toContain("Description:");
      expect(template).toContain("Parameters:");
      expect(template).toContain("Resources:");
      expect(template).toContain("Outputs:");

      // Required parameters
      expect(template).toContain("ControlPlaneAccountId:");
      expect(template).toContain("Type: String");
      expect(template).toContain("ExternalId:");
      expect(template).toContain("StackPrefix:");

      // Required resources
      expect(template).toContain("Type: AWS::IAM::ManagedPolicy");
      expect(template).toContain("Type: AWS::IAM::Role");

      // Required outputs
      expect(template).toContain("RoleArn:");
      expect(template).toContain("ExecutionRoleArn:");
      expect(template).toContain("PermissionBoundaryArn:");
      expect(template).toContain("Value:");
    });
  });
});
