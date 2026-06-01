import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  ExecuteChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  type Change,
  type StackEvent,
  type Output,
} from "@aws-sdk/client-cloudformation";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type {
  Provider,
  PlanDeploymentInput,
  PlanResult,
  ApplyDeploymentInput,
  ApplyResult,
  GetDeploymentEventsInput,
  DeploymentEvent,
  ChangeSetChange,
  GetStackOutputsInput,
  StackOutput,
} from "../index.js";

export interface AwsProviderConfig {
  roleArn: string;
  externalId: string;
  permissionBoundaryArn?: string;
}

/**
 * AWS Provider for Cross-Account Infrastructure Management
 *
 * Always uses AssumeRole to access the target AWS account.
 * This provides consistent security model whether managing your own accounts
 * or customer accounts.
 */
export class AwsProvider implements Provider {
  constructor(private config: AwsProviderConfig) {}

  private getCloudFormationClient(region: string): CloudFormationClient {
    // Assume role in target account
    const credentials = fromTemporaryCredentials({
      params: {
        RoleArn: this.config.roleArn,
        RoleSessionName: `starkeeper-session-${Date.now()}`,
        ExternalId: this.config.externalId,
        DurationSeconds: 3600, // 1 hour
      },
    });
    return new CloudFormationClient({ region, credentials });
  }

  async planDeployment(input: PlanDeploymentInput): Promise<PlanResult> {
    const cfnClient = this.getCloudFormationClient(input.region);

    const changeSetName = `starkeeper-plan-${Date.now()}`;
    const changeSetType = await this.determineChangeSetType(
      cfnClient,
      input.stackName
    );

    const createChangeSetCommand = new CreateChangeSetCommand({
      StackName: input.stackName,
      ChangeSetName: changeSetName,
      ChangeSetType: changeSetType,
      TemplateURL: input.templateUrl,
      Parameters: input.parameters
        ? Object.entries(input.parameters).map(([key, value]) => ({
            ParameterKey: key,
            ParameterValue: value,
          }))
        : undefined,
      Tags: input.tags
        ? Object.entries(input.tags).map(([key, value]) => ({
            Key: key,
            Value: value,
          }))
        : undefined,
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
    });

    const createResponse = await cfnClient.send(createChangeSetCommand);

    // Poll until change set is ready
    const describeCommand = new DescribeChangeSetCommand({
      ChangeSetName: changeSetName,
      StackName: input.stackName,
    });

    let changeSetReady = false;
    let attempts = 0;
    const maxAttempts = 30;

    while (!changeSetReady && attempts < maxAttempts) {
      const describeResponse = await cfnClient.send(describeCommand);
      const status = describeResponse.Status;

      if (status === "CREATE_COMPLETE") {
        changeSetReady = true;
      } else if (status === "FAILED") {
        const statusReason = describeResponse.StatusReason || "";

        // Check if this is a "no changes" scenario (not a real error)
        if (statusReason.includes("didn't contain changes") ||
            statusReason.includes("No updates are to be performed")) {
          // Return empty change set for "no changes" case
          return {
            planId: changeSetName,
            changeSetId: describeResponse.ChangeSetId!,
            changeSetArn: createResponse.Id,
            changes: [],
            status: "READY",
          };
        }

        // Real error - throw it
        throw new Error(
          `Change set creation failed: ${statusReason}`
        );
      } else {
        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, 2000));
        attempts++;
      }
    }

    if (!changeSetReady) {
      throw new Error("Change set creation timed out");
    }

    // Get final change set details
    const finalResponse = await cfnClient.send(describeCommand);

    return {
      planId: changeSetName,
      changeSetId: finalResponse.ChangeSetId!,
      changeSetArn: createResponse.Id,
      changes: this.transformChanges(finalResponse.Changes || []),
      status: "READY",
    };
  }

  private async determineChangeSetType(
    cfnClient: CloudFormationClient,
    stackName: string
  ): Promise<"CREATE" | "UPDATE"> {
    try {
      const describeCommand = new DescribeStacksCommand({
        StackName: stackName,
      });
      const response = await cfnClient.send(describeCommand);
      const stack = response.Stacks?.[0];

      // If stack exists but is in ROLLBACK_COMPLETE or ROLLBACK_FAILED state, it must be deleted first
      if (stack?.StackStatus === "ROLLBACK_COMPLETE" || stack?.StackStatus === "ROLLBACK_FAILED") {
        throw new Error(
          `Stack ${stackName} is in ${stack.StackStatus} state and must be deleted before creating a new deployment. ` +
          `Please delete the stack first or use a different stack name.`
        );
      }

      return "UPDATE";
    } catch (error) {
      // Check for ValidationError (AWS SDK v3 sets error.name to the error code)
      const e = error as { name?: string; Code?: string; message?: string };
      if ((e.name === "ValidationError" || e.Code === "ValidationError") &&
          e.message?.includes("does not exist")) {
        return "CREATE";
      }
      throw error;
    }
  }

  private transformChanges(changes: Change[]): ChangeSetChange[] {
    return changes.map((change) => ({
      action: (change.ResourceChange?.Action as ChangeSetChange["action"]) || "Dynamic",
      resourceType: change.ResourceChange?.ResourceType || "Unknown",
      logicalResourceId: change.ResourceChange?.LogicalResourceId || "",
      physicalResourceId: change.ResourceChange?.PhysicalResourceId,
      replacement: change.ResourceChange?.Replacement as ChangeSetChange["replacement"],
      scope: change.ResourceChange?.Scope,
      details: change.ResourceChange?.Details,
    }));
  }

  async applyDeployment(input: ApplyDeploymentInput): Promise<ApplyResult> {
    const cfnClient = this.getCloudFormationClient(input.region);

    const executeCommand = new ExecuteChangeSetCommand({
      ChangeSetName: input.changeSetId,
      StackName: input.stackName,
    });

    await cfnClient.send(executeCommand);

    // Get stack ID
    const describeCommand = new DescribeStacksCommand({
      StackName: input.stackName,
    });
    const describeResponse = await cfnClient.send(describeCommand);
    const stack = describeResponse.Stacks?.[0];

    return {
      deploymentId: input.planId,
      stackId: stack?.StackId || "",
      stackArn: stack?.StackId,
      status: "IN_PROGRESS",
      events: [],
    };
  }

  async getDeploymentEvents(
    input: GetDeploymentEventsInput
  ): Promise<DeploymentEvent[]> {
    const cfnClient = this.getCloudFormationClient(input.region);

    const command = new DescribeStackEventsCommand({
      StackName: input.stackName,
    });

    const response = await cfnClient.send(command);
    const events = response.StackEvents || [];

    return events.slice(0, input.limit || 100).map((event: StackEvent) => ({
      timestamp: event.Timestamp || new Date(),
      resourceType: event.ResourceType || "Unknown",
      logicalResourceId: event.LogicalResourceId || "",
      physicalResourceId: event.PhysicalResourceId,
      resourceStatus: event.ResourceStatus || "",
      resourceStatusReason: event.ResourceStatusReason,
    }));
  }

  /**
   * Get the current status of a CloudFormation stack
   */
  async getStackStatus(input: {
    stackName: string;
    region: string;
  }): Promise<{
    status: string;
    statusReason?: string;
  }> {
    const cfnClient = this.getCloudFormationClient(input.region);

    try {
      const command = new DescribeStacksCommand({
        StackName: input.stackName,
      });

      const response = await cfnClient.send(command);
      const stack = response.Stacks?.[0];

      return {
        status: stack?.StackStatus || "UNKNOWN",
        statusReason: stack?.StackStatusReason,
      };
    } catch (error) {
      // Only return DELETED if the stack actually doesn't exist
      // Don't mask other validation errors
      const e = error as { name?: string; Code?: string; message?: string };
      if ((e.name === "ValidationError" || e.Code === "ValidationError") &&
          e.message && e.message.includes("does not exist")) {
        return { status: "DELETED" };
      }
      throw error;
    }
  }

  /**
   * Get detailed information about a change set
   */
  async getChangeSetDetails(input: {
    connectionId: string;
    changeSetId: string;
    stackName: string;
    region: string;
  }) {
    const cfnClient = this.getCloudFormationClient(input.region);

    const describeCommand = new DescribeChangeSetCommand({
      ChangeSetName: input.changeSetId,
      StackName: input.stackName,
    });

    const response = await cfnClient.send(describeCommand);

    return {
      changeSetId: response.ChangeSetId,
      changeSetName: response.ChangeSetName,
      stackName: response.StackName,
      status: response.Status,
      statusReason: response.StatusReason,
      changes: response.Changes,
      creationTime: response.CreationTime,
    };
  }

  /**
   * Execute a change set (shorthand for applyDeployment)
   */
  async executeChangeSet(input: {
    connectionId: string;
    changeSetId: string;
    stackName: string;
    region: string;
  }) {
    return this.applyDeployment({
      connectionId: input.connectionId,
      planId: input.changeSetId,
      changeSetId: input.changeSetId,
      stackName: input.stackName,
      region: input.region,
    });
  }

  /**
   * Get CloudFormation stack outputs
   */
  async getStackOutputs(input: GetStackOutputsInput): Promise<StackOutput[]> {
    const cfnClient = this.getCloudFormationClient(input.region);

    try {
      const describeCommand = new DescribeStacksCommand({
        StackName: input.stackName,
      });
      const response = await cfnClient.send(describeCommand);
      const stack = response.Stacks?.[0];

      if (!stack?.Outputs) {
        return [];
      }

      return stack.Outputs.map((output: Output) => ({
        outputKey: output.OutputKey || "",
        outputValue: output.OutputValue || "",
        description: output.Description,
        exportName: output.ExportName,
      }));
    } catch (error) {
      // Only return empty array if stack doesn't exist
      // Don't mask other validation errors
      const e = error as { name?: string; Code?: string; message?: string };
      if ((e.name === "ValidationError" || e.Code === "ValidationError") &&
          e.message && e.message.includes("does not exist")) {
        return [];
      }
      throw error;
    }
  }
}
