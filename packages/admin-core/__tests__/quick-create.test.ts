import { describe, it, expect } from "vitest";
import {
  generateQuickCreateLink,
  generateBootstrapQuickCreateLink,
  generateChangeSetApprovalLink,
} from "../src/quick-create";
import { TEST_DATA } from "./test-helpers";

describe("Quick Create Links", () => {
  describe("generateQuickCreateLink", () => {
    it("should generate a valid CloudFormation Quick Create URL", () => {
      const link = generateQuickCreateLink({
        region: TEST_DATA.region,
        stackName: TEST_DATA.stackName,
        templateUrl: TEST_DATA.templateUrl,
      });

      expect(link).toContain(`https://${TEST_DATA.region}.console.aws.amazon.com/cloudformation/home`);
      expect(link).toContain("#/stacks/quickcreate?");
      expect(link).toContain(`region=${TEST_DATA.region}`);
      expect(link).toContain(`stackName=${TEST_DATA.stackName}`);
      expect(link).toContain(`templateURL=${encodeURIComponent(TEST_DATA.templateUrl)}`);
    });

    it("should include parameters in the URL", () => {
      const link = generateQuickCreateLink({
        region: TEST_DATA.region,
        stackName: TEST_DATA.stackName,
        templateUrl: TEST_DATA.templateUrl,
        parameters: {
          Environment: "dev",
          Version: "1.0.0",
        },
      });

      expect(link).toContain("param_Environment=dev");
      expect(link).toContain("param_Version=1.0.0");
    });

    it("should include tags in the URL", () => {
      const link = generateQuickCreateLink({
        region: TEST_DATA.region,
        stackName: TEST_DATA.stackName,
        templateUrl: TEST_DATA.templateUrl,
        tags: {
          ManagedBy: "Starkeeper",
          Team: "Platform",
        },
      });

      expect(link).toContain("tag_ManagedBy=Starkeeper");
      expect(link).toContain("tag_Team=Platform");
    });

    it("should work without parameters or tags", () => {
      const link = generateQuickCreateLink({
        region: TEST_DATA.region,
        stackName: TEST_DATA.stackName,
        templateUrl: TEST_DATA.templateUrl,
      });

      expect(link).toBeDefined();
      expect(link).toContain("stackName=");
      expect(link).toContain("templateURL=");
    });
  });

  describe("generateBootstrapQuickCreateLink", () => {
    it("should generate a bootstrap-specific Quick Create link", () => {
      const link = generateBootstrapQuickCreateLink({
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
        stackPrefix: TEST_DATA.stackPrefix,
      });

      expect(link).toContain("stackName=StarkeeperBootstrap");
      expect(link).toContain(`param_ControlPlaneAccountId=${TEST_DATA.controlPlaneAccountId}`);
      expect(link).toContain(`param_ExternalId=${TEST_DATA.externalId}`);
      expect(link).toContain(`param_StackPrefix=${TEST_DATA.stackPrefix}`);
    });

    it("should include default tags", () => {
      const link = generateBootstrapQuickCreateLink({
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
      });

      expect(link).toContain("tag_ManagedBy=Starkeeper");
      expect(link).toContain("tag_Purpose=Bootstrap");
    });

    it("should use default stack prefix if not provided", () => {
      const link = generateBootstrapQuickCreateLink({
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
        controlPlaneAccountId: TEST_DATA.controlPlaneAccountId,
        externalId: TEST_DATA.externalId,
      });

      expect(link).toContain("param_StackPrefix=app");
    });
  });

  describe("generateChangeSetApprovalLink", () => {
    it("should generate a change set review link", () => {
      const link = generateChangeSetApprovalLink({
        region: TEST_DATA.region,
        stackName: TEST_DATA.stackName,
        changeSetName: TEST_DATA.changeSetName,
      });

      expect(link).toContain(`https://${TEST_DATA.region}.console.aws.amazon.com/cloudformation/home`);
      expect(link).toContain("#/stacks/changesets/changes?");
      expect(link).toContain(`region=${TEST_DATA.region}`);
      expect(link).toContain(`stackId=${encodeURIComponent(TEST_DATA.stackName)}`);
      expect(link).toContain(`changeSetId=${encodeURIComponent(TEST_DATA.changeSetName)}`);
    });

    it("should properly encode stack and change set names with special characters", () => {
      const link = generateChangeSetApprovalLink({
        region: "us-east-1",
        stackName: "my-app/stack",
        changeSetName: "change-set:123",
      });

      expect(link).toContain(encodeURIComponent("my-app/stack"));
      expect(link).toContain(encodeURIComponent("change-set:123"));
    });
  });
});
