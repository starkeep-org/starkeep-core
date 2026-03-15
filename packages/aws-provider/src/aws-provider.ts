import type {
  AwsProvider,
  AwsProviderOptions,
  DeprovisionResult,
  ProvisionedResources,
  StackProgram,
  UserProvisioningOptions,
} from "./types.js";
import { buildStackName, parseStackName } from "./resource-naming.js";

function mapOutputsToResources(
  userId: string,
  outputs: Record<string, string>,
): ProvisionedResources {
  return {
    userId,
    auroraEndpoint: outputs["auroraEndpoint"] ?? "",
    s3BucketName: outputs["s3BucketName"] ?? "",
    apiGatewayUrl: outputs["apiGatewayUrl"] ?? "",
    region: outputs["region"] ?? "",
    provisionedAt: new Date(),
    stackOutputs: outputs,
  };
}

/**
 * Create an AWS provider that orchestrates per-user infrastructure
 * using a pluggable stack program (Pulumi Automation API compatible).
 */
export function createAwsProvider(
  options: AwsProviderOptions,
  stackProgram: StackProgram,
): AwsProvider {
  const { projectName, region } = options;

  return {
    async provisionUser(
      provisioningOptions: UserProvisioningOptions,
    ): Promise<ProvisionedResources> {
      const { userId } = provisioningOptions;
      const effectiveRegion = provisioningOptions.region ?? region;
      const stackName =
        provisioningOptions.stackName ??
        buildStackName(projectName, userId);

      const config: Record<string, string> = {
        region: effectiveRegion,
        userId,
      };

      const outputs = await stackProgram.up(stackName, config);

      return mapOutputsToResources(userId, outputs);
    },

    async deprovisionUser(userId: string): Promise<DeprovisionResult> {
      const stackName = buildStackName(projectName, userId);
      const outputs = await stackProgram.getOutputs(stackName);

      const resourcesRemoved: string[] = [];

      if (outputs !== null) {
        if (outputs["auroraEndpoint"]) {
          resourcesRemoved.push(`aurora:${outputs["auroraEndpoint"]}`);
        }
        if (outputs["s3BucketName"]) {
          resourcesRemoved.push(`s3:${outputs["s3BucketName"]}`);
        }
        if (outputs["apiGatewayUrl"]) {
          resourcesRemoved.push(`apigateway:${outputs["apiGatewayUrl"]}`);
        }
      }

      await stackProgram.destroy(stackName);

      return { userId, resourcesRemoved };
    },

    async getResources(
      userId: string,
    ): Promise<ProvisionedResources | null> {
      const stackName = buildStackName(projectName, userId);
      const outputs = await stackProgram.getOutputs(stackName);

      if (outputs === null) {
        return null;
      }

      return mapOutputsToResources(userId, outputs);
    },

    async listUsers(): Promise<string[]> {
      const stackNames = await stackProgram.listStacks();
      const userIds: string[] = [];

      for (const stackName of stackNames) {
        const parsed = parseStackName(stackName);
        if (parsed !== null && parsed.projectName === projectName) {
          userIds.push(parsed.userId);
        }
      }

      return userIds;
    },
  };
}
