/**
 * Test helpers and utilities for Starkeeper tests
 */

import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";

/**
 * Create mock CloudFormation client
 */
export function createMockCloudFormationClient() {
  return mockClient(CloudFormationClient);
}

/**
 * Create mock STS client
 */
export function createMockSTSClient() {
  return mockClient(STSClient);
}

/**
 * Sample test data
 */
export const TEST_DATA = {
  controlPlaneAccountId: "123456789012",
  targetAccountId: "210987654321",
  externalId: "test-external-id-12345678",
  roleArn: "arn:aws:iam::210987654321:role/StarkeeperAccess",
  executionRoleArn: "arn:aws:iam::210987654321:role/StarkeeperCloudFormationExecution",
  permissionBoundaryArn: "arn:aws:iam::210987654321:policy/StarkeeperPermissionBoundary",
  stackPrefix: "testapp",
  region: "us-east-1",
  stackName: "testapp-dev-webapp",
  templateUrl: "https://s3.amazonaws.com/test-bucket/template.yaml",
  changeSetName: "starkeeper-plan-1234567890",
  changeSetId: "arn:aws:cloudformation:us-east-1:210987654321:changeSet/starkeeper-plan-1234567890/abc-123",
};

/**
 * Create a mock CloudFormation change set response
 */
export function createMockChangeSet(overrides?: any) {
  return {
    ChangeSetName: TEST_DATA.changeSetName,
    ChangeSetId: TEST_DATA.changeSetId,
    StackName: TEST_DATA.stackName,
    Status: "CREATE_COMPLETE",
    StatusReason: undefined,
    Changes: [
      {
        Type: "Resource",
        ResourceChange: {
          Action: "Add",
          LogicalResourceId: "WebsiteBucket",
          PhysicalResourceId: undefined,
          ResourceType: "AWS::S3::Bucket",
          Replacement: undefined,
          Scope: [],
          Details: [],
        },
      },
      {
        Type: "Resource",
        ResourceChange: {
          Action: "Add",
          LogicalResourceId: "CloudFrontDistribution",
          PhysicalResourceId: undefined,
          ResourceType: "AWS::CloudFront::Distribution",
          Replacement: undefined,
          Scope: [],
          Details: [],
        },
      },
    ],
    ...overrides,
  };
}

/**
 * Create a mock stack events response
 */
export function createMockStackEvents() {
  return {
    StackEvents: [
      {
        StackId: "arn:aws:cloudformation:us-east-1:210987654321:stack/testapp-dev-webapp/abc-123",
        EventId: "event-1",
        StackName: TEST_DATA.stackName,
        LogicalResourceId: "testapp-dev-webapp",
        PhysicalResourceId: "arn:aws:cloudformation:us-east-1:210987654321:stack/testapp-dev-webapp/abc-123",
        ResourceType: "AWS::CloudFormation::Stack",
        Timestamp: new Date("2024-01-01T12:00:00Z"),
        ResourceStatus: "CREATE_IN_PROGRESS" as const,
        ResourceStatusReason: "User Initiated",
      },
      {
        StackId: "arn:aws:cloudformation:us-east-1:210987654321:stack/testapp-dev-webapp/abc-123",
        EventId: "event-2",
        StackName: TEST_DATA.stackName,
        LogicalResourceId: "WebsiteBucket",
        PhysicalResourceId: "testapp-dev-webapp-bucket",
        ResourceType: "AWS::S3::Bucket",
        Timestamp: new Date("2024-01-01T12:01:00Z"),
        ResourceStatus: "CREATE_COMPLETE" as const,
      },
    ],
  };
}

/**
 * Create a mock describe stacks response
 */
export function createMockDescribeStacks() {
  return {
    Stacks: [
      {
        StackId: "arn:aws:cloudformation:us-east-1:210987654321:stack/testapp-dev-webapp/abc-123",
        StackName: TEST_DATA.stackName,
        CreationTime: new Date("2024-01-01T12:00:00Z"),
        StackStatus: "CREATE_COMPLETE" as const,
        Tags: [
          { Key: "Environment", Value: "dev" },
          { Key: "ManagedBy", Value: "Starkeeper" },
        ],
      },
    ],
  };
}
