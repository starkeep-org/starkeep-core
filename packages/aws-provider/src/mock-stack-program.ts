import type { StackProgram } from "./types.js";

/**
 * Create an in-memory mock implementation of StackProgram for testing.
 */
export function createMockStackProgram(): StackProgram {
  const stacks = new Map<string, Record<string, string>>();

  return {
    async up(
      stackName: string,
      config: Record<string, string>,
    ): Promise<Record<string, string>> {
      const outputs: Record<string, string> = {
        auroraEndpoint: `${stackName}.cluster.us-east-1.rds.amazonaws.com`,
        s3BucketName: `${stackName}-data`,
        apiGatewayUrl: `https://${stackName}.execute-api.us-east-1.amazonaws.com`,
        region: config["region"] ?? "us-east-1",
        userId: config["userId"] ?? "unknown",
      };

      stacks.set(stackName, outputs);
      return outputs;
    },

    async destroy(stackName: string): Promise<void> {
      stacks.delete(stackName);
    },

    async getOutputs(
      stackName: string,
    ): Promise<Record<string, string> | null> {
      return stacks.get(stackName) ?? null;
    },

    async listStacks(): Promise<string[]> {
      return Array.from(stacks.keys());
    },
  };
}
