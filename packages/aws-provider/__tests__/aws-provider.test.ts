import { describe, it, expect, beforeEach } from "vitest";
import { createAwsProvider } from "../src/aws-provider.js";
import { createMockStackProgram } from "../src/mock-stack-program.js";
import type { AwsProvider, StackProgram } from "../src/types.js";

describe("createAwsProvider", () => {
  let stackProgram: StackProgram;
  let provider: AwsProvider;

  beforeEach(() => {
    stackProgram = createMockStackProgram();
    provider = createAwsProvider(
      { projectName: "starkeep", region: "us-east-1" },
      stackProgram,
    );
  });

  it("provisionUser creates resources and returns them", async () => {
    const resources = await provider.provisionUser({
      userId: "user-abc-123",
      region: "us-east-1",
    });

    expect(resources.userId).toBe("user-abc-123");
    expect(resources.region).toBe("us-east-1");
    expect(resources.auroraEndpoint).toContain("rds.amazonaws.com");
    expect(resources.s3BucketName).toBeTruthy();
    expect(resources.apiGatewayUrl).toContain("execute-api");
    expect(resources.provisionedAt).toBeInstanceOf(Date);
    expect(resources.stackOutputs).toBeDefined();
  });

  it("getResources returns provisioned resources", async () => {
    await provider.provisionUser({
      userId: "user-abc-123",
      region: "us-east-1",
    });

    const resources = await provider.getResources("user-abc-123");

    expect(resources).not.toBeNull();
    expect(resources!.userId).toBe("user-abc-123");
    expect(resources!.auroraEndpoint).toContain("rds.amazonaws.com");
  });

  it("getResources returns null for unknown user", async () => {
    const resources = await provider.getResources("nonexistent-user");

    expect(resources).toBeNull();
  });

  it("listUsers returns all provisioned user IDs", async () => {
    await provider.provisionUser({
      userId: "user-alpha",
      region: "us-east-1",
    });
    await provider.provisionUser({
      userId: "user-beta",
      region: "us-west-2",
    });

    const users = await provider.listUsers();

    expect(users).toHaveLength(2);
    expect(users).toContain("user-alpha");
    expect(users).toContain("user-beta");
  });

  it("deprovisionUser removes resources", async () => {
    await provider.provisionUser({
      userId: "user-abc-123",
      region: "us-east-1",
    });

    const result = await provider.deprovisionUser("user-abc-123");

    expect(result.userId).toBe("user-abc-123");
    expect(result.resourcesRemoved.length).toBeGreaterThan(0);
    expect(result.resourcesRemoved.some((resource) => resource.startsWith("aurora:"))).toBe(true);
    expect(result.resourcesRemoved.some((resource) => resource.startsWith("s3:"))).toBe(true);
    expect(result.resourcesRemoved.some((resource) => resource.startsWith("apigateway:"))).toBe(true);

    const resources = await provider.getResources("user-abc-123");
    expect(resources).toBeNull();
  });

  it("deprovisionUser for unknown user handles gracefully", async () => {
    const result = await provider.deprovisionUser("nonexistent-user");

    expect(result.userId).toBe("nonexistent-user");
    expect(result.resourcesRemoved).toHaveLength(0);
  });
});
