/**
 * buildPulumiProgram under Pulumi's runtime mocks — no cloud, no engine.
 * Asserts the manifest→infrastructure translation: route prefix rewriting,
 * the reserved-subpath hard failure, JWT-vs-public wiring, and the env block
 * every per-app Lambda must carry.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { buildPulumiProgram } from "../src/pulumi-program";
import type { ComputeContext } from "../src/compute-stack";
import type { AppManifest, AppComputeHandler } from "@starkeep/admin-manifest";
import { appManifestSchema } from "@starkeep/admin-manifest";

interface CreatedResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const created: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } {
      created.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: { ...args.inputs, arn: `arn:fake:${args.name}` } };
    },
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "starkeep-test-project",
  "starkeep-test-stack",
  true,
);

const ctx: ComputeContext = {
  stackPrefix: "starkeep",
  appId: "photos",
  appRoleArn: "arn:aws:iam::111122223333:role/starkeep-app-photos-role",
  apiGatewayId: "api123",
  apiGatewayExecutionArn: "arn:aws:execute-api:us-east-1:111122223333:api123",
  apiGatewayUrl: "https://api.example.com",
  authorizerId: "auth123",
  region: "us-east-1",
  accountId: "111122223333",
  pulumiStateBucket: "starkeep-pulumi-state",
  artifactsBucket: "starkeep-artifacts",
  dsqlHostname: "fake.dsql",
  filesBucket: "starkeep-files",
  infraCreds: {
    accessKeyId: "AK",
    secretAccessKey: "SK",
    sessionToken: "token",
    expiration: new Date(Date.now() + 3_600_000),
  },
  bundleHash: "abc123hash",
};

function manifestWithHandlers(handlers: Partial<AppComputeHandler>[]): AppManifest {
  return appManifestSchema.parse({
    id: "photos",
    name: "Photos",
    version: "0.1.0",
    tier: "official",
    infraRequirements: {
      compute: {
        enabled: true,
        handlers: handlers.map((h) => ({ name: "h", handler: "index.handler", ...h })),
      },
    },
  });
}

async function run(manifest: AppManifest): Promise<Record<string, unknown>> {
  const outputs = await buildPulumiProgram(manifest, ctx)();
  // Force resolution of every output so all resource registrations settle.
  for (const value of Object.values(outputs)) {
    if (pulumi.Output.isInstance(value)) {
      await new Promise((resolve) => (value as pulumi.Output<unknown>).apply(resolve));
    }
  }
  return outputs;
}

function routes(): CreatedResource[] {
  return created.filter((r) => r.type === "aws:apigatewayv2/route:Route");
}

beforeEach(() => {
  created.length = 0;
});

describe("route prefix rewriting", () => {
  it("rewrites GET / to the bare app prefix and nested paths underneath it", async () => {
    await run(
      manifestWithHandlers([
        { name: "static", routes: ["GET /", "GET /{proxy+}"], auth: "public" },
        { name: "api", routes: ["POST /api/resize"] },
      ]),
    );
    const keys = routes().map((r) => r.inputs.routeKey);
    expect(keys).toContain("GET /apps/photos");
    expect(keys).toContain("GET /apps/photos/{proxy+}");
    expect(keys).toContain("POST /apps/photos/api/resize");
  });

  it("passes $default through unprefixed", async () => {
    await run(manifestWithHandlers([{ name: "h" }])); // routes default to ["$default"]
    expect(routes().map((r) => r.inputs.routeKey)).toEqual(["$default"]);
  });

  it("hard-fails on a literal route claiming a reserved sub-path", async () => {
    for (const reserved of ["data", "files", "sync", "health", "app-data"]) {
      await expect(
        run(manifestWithHandlers([{ name: "h", routes: [`GET /${reserved}/x`] }])),
        reserved,
      ).rejects.toThrow(/reserved for the cloud-data-server/);
    }
  });

  it("allows {proxy+} even though it would shadow reserved paths (APIGW specificity wins)", async () => {
    await expect(
      run(manifestWithHandlers([{ name: "h", routes: ["GET /{proxy+}"] }])),
    ).resolves.toBeDefined();
  });
});

describe("auth wiring", () => {
  it("attaches the JWT authorizer to jwt handlers and none to public ones", async () => {
    await run(
      manifestWithHandlers([
        { name: "api", routes: ["POST /api/x"] }, // auth defaults to jwt
        { name: "static", routes: ["GET /"], auth: "public" },
      ]),
    );
    const byKey = Object.fromEntries(routes().map((r) => [r.inputs.routeKey as string, r.inputs]));
    expect(byKey["POST /apps/photos/api/x"].authorizationType).toBe("JWT");
    expect(byKey["POST /apps/photos/api/x"].authorizerId).toBe("auth123");
    expect(byKey["GET /apps/photos"].authorizationType).toBeUndefined();
    expect(byKey["GET /apps/photos"].authorizerId).toBeUndefined();
  });
});

describe("lambda wiring", () => {
  it("builds the function from the artifacts bundle under the app role", async () => {
    await run(manifestWithHandlers([{ name: "api", memoryMb: 512, timeoutSeconds: 30 }]));
    const fn = created.find((r) => r.type === "aws:lambda/function:Function");
    expect(fn).toBeDefined();
    expect(fn!.inputs.name).toBe("starkeep-app-photos-api");
    expect(fn!.inputs.role).toBe(ctx.appRoleArn);
    expect(fn!.inputs.s3Bucket).toBe("starkeep-artifacts");
    expect(fn!.inputs.s3Key).toBe("apps/photos/latest/dist.zip");
    expect(fn!.inputs.sourceCodeHash).toBe("abc123hash");
    expect(fn!.inputs.memorySize).toBe(512);
    expect(fn!.inputs.timeout).toBe(30);
  });

  it("always injects the cloud-client env trio plus platform context", async () => {
    await run(
      manifestWithHandlers([
        { name: "api", env: { MY_CUSTOM: "value", STARKEEP_USER_POOL_ID: "filled-by-cli" } },
      ]),
    );
    const fn = created.find((r) => r.type === "aws:lambda/function:Function");
    const env = (fn!.inputs.environment as { variables: Record<string, string> }).variables;
    expect(env).toMatchObject({
      STARKEEP_APP_ID: "photos",
      STARKEEP_STACK_PREFIX: "starkeep",
      STARKEEP_DSQL_HOSTNAME: "fake.dsql",
      STARKEEP_FILES_BUCKET: "starkeep-files",
      STARKEEP_APP_CLIENT_MODE: "cloud",
      STARKEEP_CLOUD_DATA_BASE: "https://api.example.com",
      STARKEEP_APP_CREDS_PARAMETER_NAME: "/starkeep/app-creds/photos",
      MY_CUSTOM: "value",
      STARKEEP_USER_POOL_ID: "filled-by-cli",
    });
  });

  it("grants API Gateway invoke permission scoped to the gateway execution ARN", async () => {
    await run(manifestWithHandlers([{ name: "api" }]));
    const perm = created.find((r) => r.type === "aws:lambda/permission:Permission");
    expect(perm).toBeDefined();
    expect(perm!.inputs.principal).toBe("apigateway.amazonaws.com");
    expect(perm!.inputs.sourceArn).toBe(`${ctx.apiGatewayExecutionArn}/*/*`);
  });

  it("creates a 14-day log group per handler before the function", async () => {
    await run(manifestWithHandlers([{ name: "api" }]));
    const lg = created.find((r) => r.type === "aws:cloudwatch/logGroup:LogGroup");
    expect(lg!.inputs.name).toBe("/aws/lambda/starkeep-app-photos-api");
    expect(lg!.inputs.retentionInDays).toBe(14);
  });
});
