/**
 * buildPulumiProgram under Pulumi's runtime mocks — no cloud, no engine.
 * Asserts the manifest→infrastructure translation: route prefix rewriting,
 * the reserved-subpath hard failure, the three-way auth wiring, and the env
 * block every per-app Lambda must carry.
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
  appExecRoleArn: "arn:aws:iam::111122223333:role/starkeep-app-photos-exec-role",
  apiGatewayId: "api123",
  apiGatewayExecutionArn: "arn:aws:execute-api:us-east-1:111122223333:api123",
  apiGatewayUrl: "https://api.example.com",
  authorizerId: "auth123",
  sessionAuthorizerId: "session-auth-456",
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

  it("lets a per-route override put the authorizer back in front of a subtree", async () => {
    // Postmortem 5.4: a handler used to be all-or-nothing, so an app that
    // needed an anonymously-reachable HTML shell published its data plane too.
    // API Gateway prefers the more specific route, so a jwt route for the data
    // subtree on the SAME Lambda re-gates it while the document stays open.
    await run(
      manifestWithHandlers([
        {
          name: "static",
          auth: "public",
          routes: ["GET /", "ANY /{proxy+}", { route: "ANY /api/data/{proxy+}", auth: "jwt" }],
          publicPaths: ["/", "/_next/static/*"],
        },
      ]),
    );
    const byKey = Object.fromEntries(routes().map((r) => [r.inputs.routeKey as string, r.inputs]));
    expect(byKey["GET /apps/photos"].authorizationType).toBeUndefined();
    expect(byKey["ANY /apps/photos/{proxy+}"].authorizationType).toBeUndefined();
    expect(byKey["ANY /apps/photos/api/data/{proxy+}"].authorizationType).toBe("JWT");
    expect(byKey["ANY /apps/photos/api/data/{proxy+}"].authorizerId).toBe("auth123");
  });

  it("lets a per-route override open one path on an otherwise gated handler", async () => {
    await run(
      manifestWithHandlers([
        { name: "api", routes: ["POST /api/x", { route: "GET /api/health", auth: "public" }] },
      ]),
    );
    const byKey = Object.fromEntries(routes().map((r) => [r.inputs.routeKey as string, r.inputs]));
    expect(byKey["POST /apps/photos/api/x"].authorizationType).toBe("JWT");
    expect(byKey["GET /apps/photos/api/health"].authorizationType).toBeUndefined();
  });
});

describe("auth wiring: session", () => {
  /**
   * The inversion. Under `public` the catch-all was wider than the declaration
   * beside it, so `publicPaths` stated an intention and enforced nothing — the
   * shape behind the 2026-08 exposure. Under `session` the catch-all carries
   * the platform authorizer and each declared path is emitted as its own more
   * specific unauthenticated route, so the declaration is the reach.
   */
  const sessionHandler = {
    name: "static",
    auth: "session" as const,
    routes: ["GET /", "ANY /{proxy+}"],
    publicPaths: ["/", "/_next/static/*", "/sign-in", "/api/session/*"],
  };

  it("puts the session authorizer on the catch-all", async () => {
    await run(manifestWithHandlers([sessionHandler]));
    const byKey = Object.fromEntries(routes().map((r) => [r.inputs.routeKey as string, r.inputs]));
    expect(byKey["ANY /apps/photos/{proxy+}"].authorizationType).toBe("CUSTOM");
    expect(byKey["ANY /apps/photos/{proxy+}"].authorizerId).toBe("session-auth-456");
  });

  it("emits one unauthenticated route per declared public path", async () => {
    await run(manifestWithHandlers([sessionHandler]));
    const byKey = Object.fromEntries(routes().map((r) => [r.inputs.routeKey as string, r.inputs]));
    for (const key of [
      "ANY /apps/photos",
      "ANY /apps/photos/_next/static/{proxy+}",
      "ANY /apps/photos/sign-in",
      "ANY /apps/photos/api/session/{proxy+}",
    ]) {
      expect(byKey[key], key).toBeDefined();
      expect(byKey[key].authorizationType, key).toBeUndefined();
    }
  });

  it("does not leave the declared GET / gated beside a public route for the same path", async () => {
    // API Gateway prefers a concrete method over ANY, so `GET /apps/photos`
    // (gated, inherited from the handler) would beat `ANY /apps/photos`
    // (public, derived) and the app root would come out behind the gate with a
    // public route next to it that never matched.
    await run(manifestWithHandlers([sessionHandler]));
    const atRoot = routes().filter((r) => r.inputs.routeKey === "GET /apps/photos");
    expect(atRoot).toEqual([]);
  });

  it("gates everything the declaration does not name", async () => {
    await run(manifestWithHandlers([sessionHandler]));
    const anonymous = routes()
      .filter((r) => r.inputs.authorizationType === undefined)
      .map((r) => r.inputs.routeKey);
    expect(anonymous.sort()).toEqual([
      "ANY /apps/photos",
      "ANY /apps/photos/_next/static/{proxy+}",
      "ANY /apps/photos/api/session/{proxy+}",
      "ANY /apps/photos/sign-in",
    ]);
    // The path whose exposure was the incident is not among them, and is not
    // reachable through any of them either.
    expect(anonymous).not.toContain("ANY /apps/photos/api/local-data/{proxy+}");
  });

  it("refuses to install rather than deploy ungated when the stack has no session authorizer", async () => {
    // A silent fallback to no authorizer would publish every route to the
    // internet and look like a successful install — the exact failure mode
    // this mechanism exists to prevent.
    const { sessionAuthorizerId, ...withoutAuthorizer } = ctx;
    void sessionAuthorizerId;
    await expect(
      buildPulumiProgram(manifestWithHandlers([sessionHandler]), withoutAuthorizer)(),
    ).rejects.toThrow(/would publish every route to the internet/);
  });

  it("leaves a jwt handler on the same app untouched", async () => {
    await run(manifestWithHandlers([sessionHandler, { name: "api", routes: ["POST /api/resize"] }]));
    const byKey = Object.fromEntries(routes().map((r) => [r.inputs.routeKey as string, r.inputs]));
    expect(byKey["POST /apps/photos/api/resize"].authorizationType).toBe("JWT");
    expect(byKey["POST /apps/photos/api/resize"].authorizerId).toBe("auth123");
  });
});

describe("the execution identity", () => {
  /**
   * An app's handlers run as an identity that cannot reach user data.
   *
   * Until this split, each handler ran as the app's *data* role — which holds
   * s3:GetObject on shared/<category>/* and dsql:DbConnect — so app code could
   * read every record row of every type and fetch any blob in a granted
   * category directly. The manifest was not binding on the app that wrote it,
   * and no control in @starkeep/app-client or at the broker could reach that.
   * Only which role the Lambda runs as could.
   */
  function lambdas(): CreatedResource[] {
    return created.filter((r) => r.type === "aws:lambda/function:Function");
  }

  it("runs every handler as the exec role, never the data role", async () => {
    await run(
      manifestWithHandlers([
        { name: "static", routes: ["GET /"], auth: "public" },
        { name: "api", routes: ["POST /api/resize"] },
      ]),
    );
    expect(lambdas()).toHaveLength(2);
    for (const fn of lambdas()) {
      expect(fn.inputs.role, fn.name).toBe(
        "arn:aws:iam::111122223333:role/starkeep-app-photos-exec-role",
      );
      expect(fn.inputs.role, fn.name).not.toBe(
        "arn:aws:iam::111122223333:role/starkeep-app-photos-role",
      );
    }
  });
});

describe("lambda wiring", () => {
  it("builds the function from the artifacts bundle under the exec role", async () => {
    await run(manifestWithHandlers([{ name: "api", memoryMb: 512, timeoutSeconds: 30 }]));
    const fn = created.find((r) => r.type === "aws:lambda/function:Function");
    expect(fn).toBeDefined();
    expect(fn!.inputs.name).toBe("starkeep-app-photos-api");
    expect(fn!.inputs.role).toBe(ctx.appExecRoleArn);
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
