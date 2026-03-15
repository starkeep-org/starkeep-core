export interface UserProvisioningOptions {
  readonly userId: string;
  readonly region: string;
  readonly stackName?: string;
}

export interface ProvisionedResources {
  readonly userId: string;
  readonly auroraEndpoint: string;
  readonly s3BucketName: string;
  readonly apiGatewayUrl: string;
  readonly region: string;
  readonly provisionedAt: Date;
  readonly stackOutputs: Record<string, string>;
}

export interface DeprovisionResult {
  readonly userId: string;
  readonly resourcesRemoved: string[];
}

export interface AwsProvider {
  provisionUser(
    options: UserProvisioningOptions,
  ): Promise<ProvisionedResources>;
  deprovisionUser(userId: string): Promise<DeprovisionResult>;
  getResources(userId: string): Promise<ProvisionedResources | null>;
  listUsers(): Promise<string[]>;
}

export interface AwsProviderOptions {
  readonly projectName: string;
  readonly region: string;
  readonly stateBackend?: "local" | "s3";
}

// Stack program interface - what Pulumi Automation API would call
export interface StackProgram {
  up(
    stackName: string,
    config: Record<string, string>,
  ): Promise<Record<string, string>>;
  destroy(stackName: string): Promise<void>;
  getOutputs(
    stackName: string,
  ): Promise<Record<string, string> | null>;
  listStacks(): Promise<string[]>;
}
