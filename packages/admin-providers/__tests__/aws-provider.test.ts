import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  DescribeStackEventsCommand,
  CloudFormationClient,
} from "@aws-sdk/client-cloudformation";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsStub } from "aws-sdk-client-mock";
import { AwsProvider } from "../src/aws";
import {
  TEST_DATA,
  createMockChangeSet,
  createMockStackEvents,
  createMockDescribeStacks,
} from "../../admin-core/__tests__/test-helpers";

describe("AwsProvider", () => {
  let cfnMock: AwsStub<any, any, any>;
  let stsMock: AwsStub<any, any, any>;
  let provider: AwsProvider;

  beforeEach(() => {
    cfnMock = mockClient(CloudFormationClient);
    stsMock = mockClient(STSClient);

    // Mock STS AssumeRole
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        SessionToken: "FwoGZXIvYXdzEBYaDH...",
        Expiration: new Date(Date.now() + 3600000),
      },
    });

    provider = new AwsProvider({
      roleArn: TEST_DATA.roleArn,
      externalId: TEST_DATA.externalId,
      executionRoleArn: TEST_DATA.executionRoleArn,
      permissionBoundaryArn: TEST_DATA.permissionBoundaryArn,
    });
  });

  afterEach(() => {
    cfnMock.reset();
    stsMock.reset();
  });

  describe("planDeployment", () => {
    it("should create a change set for a new stack", async () => {
      // Mock stack doesn't exist
      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack does not exist",
      });

      // Mock change set creation
      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: TEST_DATA.changeSetId,
        StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/test-stack/abc-123",
      });

      // Mock change set polling
      cfnMock.on(DescribeChangeSetCommand).resolves(createMockChangeSet());

      const result = await provider.planDeployment({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
      });

      expect(result).toBeDefined();
      expect(result.status).toBe("READY");
      expect(result.changeSetId).toBeDefined();
      expect(result.changes.length).toBeGreaterThan(0);

      // Verify CreateChangeSet was called with CREATE type
      const createCalls = cfnMock.commandCalls(CreateChangeSetCommand);
      expect(createCalls.length).toBe(1);
      expect(createCalls[0].args[0].input.ChangeSetType).toBe("CREATE");
    });

    it("should create a change set for an existing stack", async () => {
      // Mock stack exists
      cfnMock.on(DescribeStacksCommand).resolves(createMockDescribeStacks());

      // Mock change set creation
      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: TEST_DATA.changeSetId,
      });

      // Mock change set polling
      cfnMock.on(DescribeChangeSetCommand).resolves(createMockChangeSet());

      const result = await provider.planDeployment({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
      });

      expect(result.status).toBe("READY");

      // Verify CreateChangeSet was called with UPDATE type
      const createCalls = cfnMock.commandCalls(CreateChangeSetCommand);
      expect(createCalls.length).toBe(1);
      expect(createCalls[0].args[0].input.ChangeSetType).toBe("UPDATE");
    });

    it("should include execution role ARN when creating change set", async () => {
      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack does not exist",
      });

      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: TEST_DATA.changeSetId,
      });

      cfnMock.on(DescribeChangeSetCommand).resolves(createMockChangeSet());

      await provider.planDeployment({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
      });

      const createCalls = cfnMock.commandCalls(CreateChangeSetCommand);
      expect(createCalls[0].args[0].input.RoleARN).toBe(TEST_DATA.executionRoleArn);
    });

    it("should include parameters in change set", async () => {
      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack does not exist",
      });

      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: TEST_DATA.changeSetId,
      });

      cfnMock.on(DescribeChangeSetCommand).resolves(createMockChangeSet());

      await provider.planDeployment({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
        parameters: {
          Environment: "dev",
          Version: "1.0.0",
        },
      });

      const createCalls = cfnMock.commandCalls(CreateChangeSetCommand);
      expect(createCalls[0].args[0].input.Parameters).toEqual([
        { ParameterKey: "Environment", ParameterValue: "dev" },
        { ParameterKey: "Version", ParameterValue: "1.0.0" },
      ]);
    });

    it("should include tags in change set", async () => {
      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack does not exist",
      });

      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: TEST_DATA.changeSetId,
      });

      cfnMock.on(DescribeChangeSetCommand).resolves(createMockChangeSet());

      await provider.planDeployment({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
        tags: {
          ManagedBy: "Starkeeper",
          Environment: "dev",
        },
      });

      const createCalls = cfnMock.commandCalls(CreateChangeSetCommand);
      expect(createCalls[0].args[0].input.Tags).toEqual([
        { Key: "ManagedBy", Value: "Starkeeper" },
        { Key: "Environment", Value: "dev" },
      ]);
    });

    it("should poll until change set is ready", async () => {
      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack does not exist",
      });

      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: TEST_DATA.changeSetId,
      });

      // First call returns CREATE_PENDING, second returns CREATE_COMPLETE
      cfnMock
        .on(DescribeChangeSetCommand)
        .resolvesOnce(createMockChangeSet({ Status: "CREATE_PENDING" }))
        .resolvesOnce(createMockChangeSet({ Status: "CREATE_IN_PROGRESS" }))
        .resolves(createMockChangeSet({ Status: "CREATE_COMPLETE" }));

      const result = await provider.planDeployment({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
      });

      expect(result.status).toBe("READY");

      // Should have called DescribeChangeSet multiple times
      const describeCalls = cfnMock.commandCalls(DescribeChangeSetCommand);
      expect(describeCalls.length).toBeGreaterThan(1);
    });

    it("should throw error when change set creation fails", async () => {
      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack does not exist",
      });

      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: TEST_DATA.changeSetId,
      });

      cfnMock.on(DescribeChangeSetCommand).resolves(
        createMockChangeSet({
          Status: "FAILED",
          StatusReason: "Template error: invalid syntax",
        })
      );

      await expect(
        provider.planDeployment({
          connectionId: "connection-123",
          stackName: TEST_DATA.stackName,
          region: TEST_DATA.region,
          templateUrl: TEST_DATA.templateUrl,
        })
      ).rejects.toThrow("Change set creation failed");
    });

    it("should transform CloudFormation changes to internal format", async () => {
      cfnMock.on(DescribeStacksCommand).rejects({
        name: "ValidationError",
        message: "Stack does not exist",
      });

      cfnMock.on(CreateChangeSetCommand).resolves({
        Id: TEST_DATA.changeSetId,
      });

      cfnMock.on(DescribeChangeSetCommand).resolves(createMockChangeSet());

      const result = await provider.planDeployment({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
        templateUrl: TEST_DATA.templateUrl,
      });

      expect(result.changes).toHaveLength(2);
      expect(result.changes[0]).toEqual({
        action: "Add",
        resourceType: "AWS::S3::Bucket",
        logicalResourceId: "WebsiteBucket",
        physicalResourceId: undefined,
        replacement: undefined,
        scope: [],
        details: [],
      });
    });
  });

  describe("applyDeployment", () => {
    it("should execute a change set", async () => {
      cfnMock.on(ExecuteChangeSetCommand).resolves({});
      cfnMock.on(DescribeStacksCommand).resolves(createMockDescribeStacks());

      const result = await provider.applyDeployment({
        connectionId: "connection-123",
        planId: "plan-123",
        changeSetId: TEST_DATA.changeSetId,
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
      });

      expect(result.status).toBe("IN_PROGRESS");
      expect(result.stackId).toBeDefined();

      // Verify ExecuteChangeSet was called
      const executeCalls = cfnMock.commandCalls(ExecuteChangeSetCommand);
      expect(executeCalls.length).toBe(1);
      expect(executeCalls[0].args[0].input.ChangeSetName).toBe(TEST_DATA.changeSetId);
    });
  });

  describe("getDeploymentEvents", () => {
    it("should fetch stack events", async () => {
      cfnMock.on(DescribeStackEventsCommand).resolves(createMockStackEvents());

      const events = await provider.getDeploymentEvents({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
      });

      expect(events).toHaveLength(2);
      expect(events[0].resourceType).toBe("AWS::CloudFormation::Stack");
      expect(events[0].resourceStatus).toBe("CREATE_IN_PROGRESS");
      expect(events[1].resourceType).toBe("AWS::S3::Bucket");
      expect(events[1].resourceStatus).toBe("CREATE_COMPLETE");
    });

    it("should respect limit parameter", async () => {
      cfnMock.on(DescribeStackEventsCommand).resolves(createMockStackEvents());

      const events = await provider.getDeploymentEvents({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
        limit: 1,
      });

      expect(events).toHaveLength(1);
    });

    it("should default to 100 events when limit not specified", async () => {
      const manyEvents = {
        StackEvents: Array.from({ length: 150 }, (_, i) => ({
          StackId: "stack-id",
          EventId: `event-${i}`,
          StackName: TEST_DATA.stackName,
          LogicalResourceId: `Resource${i}`,
          ResourceType: "AWS::S3::Bucket",
          Timestamp: new Date(),
          ResourceStatus: "CREATE_COMPLETE" as const,
        })),
      };

      cfnMock.on(DescribeStackEventsCommand).resolves(manyEvents);

      const events = await provider.getDeploymentEvents({
        connectionId: "connection-123",
        stackName: TEST_DATA.stackName,
        region: TEST_DATA.region,
      });

      expect(events).toHaveLength(100);
    });
  });
});
