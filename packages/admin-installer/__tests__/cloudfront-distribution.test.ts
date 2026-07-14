/**
 * buildCloudDataServerProgram's CloudFront distribution under Pulumi's runtime
 * mocks — no cloud, no engine.
 *
 * The distribution's behavior/policy wiring is otherwise only asserted by the
 * tier-3 AWS journey (opt-in, real account, tens of minutes). These are the
 * regressions that journey would catch but nothing else would, made cheap:
 *
 *   - the default behavior's Managed-AllViewerExceptHostHeader origin request
 *     policy, which is the ONLY reason Authorization (Cognito JWT) and the HMAC
 *     signature headers survive the edge with caching disabled — and the only
 *     reason the viewer Host header is stripped so the HTTP API accepts the
 *     origin request at all;
 *   - the shared/* cache policy excluding query strings from the cache key,
 *     without which every freshly-signed URL is a distinct key and Part B's edge
 *     cache never hits (a silent perf regression — everything still *works*);
 *   - the structural confinement Part B's trust analysis rests on: `shared/*` is
 *     the only path that routes to the S3 files origin, and the bucket policy
 *     admits the distribution to `shared/*` only, so apps/* private bytes are
 *     unreachable through the edge no matter what gets signed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { buildCloudDataServerProgram } from "../src/builtin-programs/cloud-data-server-program";
import type { CloudDataServerProgramContext } from "../src/builtin-programs/cloud-data-server-program";

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
      const extra: Record<string, unknown> = {};
      if (args.type.endsWith("apigatewayv2/api:Api")) {
        extra.apiEndpoint = "https://mockapi.execute-api.us-east-2.amazonaws.com";
      }
      if (args.type.endsWith("cloudfront/distribution:Distribution")) {
        extra.domainName = `${args.name}.cloudfront.net`;
      }
      return { id: `${args.name}-id`, state: { ...args.inputs, arn: `arn:fake:${args.name}`, ...extra } };
    },
    // The managed cache / origin-request policies are looked up by NAME through
    // data-source calls, so the mock echoes the name back as the id. That makes
    // each behavior's policy id assertable as the managed policy it asked for —
    // which is the actual contract here (AWS's opaque uuids are not).
    call(args: pulumi.runtime.MockCallArgs) {
      if (args.token === "aws:cloudfront/getCachePolicy:getCachePolicy") {
        return { id: `cache:${args.inputs.name}` };
      }
      if (args.token === "aws:cloudfront/getOriginRequestPolicy:getOriginRequestPolicy") {
        return { id: `originRequest:${args.inputs.name}` };
      }
      return args.inputs;
    },
  },
  "starkeep-test-project",
  "starkeep-test-stack",
  false,
);

const distZipPath = mkdtempSync(join(tmpdir(), "cds-cdn-dist-"));

const ctx: CloudDataServerProgramContext = {
  stackPrefix: "starkeep",
  region: "us-east-2",
  accountId: "111122223333",
  appRoleArn: "arn:aws:iam::111122223333:role/starkeep-app-cloud-data-server-role",
  distZipPath,
  bundleHash: "abc123hash",
  userPoolId: "us-east-2_pool",
  userPoolClientId: "client123",
  ephemeral: false,
};

interface CacheBehavior {
  pathPattern?: string;
  targetOriginId: string;
  cachePolicyId?: string;
  originRequestPolicyId?: string;
  trustedKeyGroups?: string[];
  allowedMethods: string[];
  viewerProtocolPolicy: string;
}

let distribution: CreatedResource;
let defaultBehavior: CacheBehavior;
let orderedBehaviors: CacheBehavior[];
let programOutputs: Record<string, unknown>;

/** The one behavior whose pathPattern matches, or undefined. */
const behaviorFor = (pattern: string): CacheBehavior | undefined =>
  orderedBehaviors.find((b) => b.pathPattern === pattern);

beforeAll(async () => {
  const outputs = await buildCloudDataServerProgram(ctx)();
  // Force resolution of every output so all resource registrations settle.
  programOutputs = {};
  for (const [key, value] of Object.entries(outputs)) {
    programOutputs[key] = pulumi.Output.isInstance(value)
      ? await new Promise((resolve) => (value as pulumi.Output<unknown>).apply(resolve))
      : value;
  }

  distribution = created.find((r) => r.type.endsWith("cloudfront/distribution:Distribution"))!;
  defaultBehavior = distribution.inputs.defaultCacheBehavior as CacheBehavior;
  orderedBehaviors = distribution.inputs.orderedCacheBehaviors as CacheBehavior[];
});

describe("default behavior — auth headers must survive the edge", () => {
  it("forwards all viewer headers except Host (Authorization + HMAC signatures reach the origin)", () => {
    // Drop this policy and browser JWT calls and Lambda→gateway HMAC calls both
    // break in production, while every unauthenticated test still passes.
    expect(defaultBehavior.originRequestPolicyId).toBe(
      "originRequest:Managed-AllViewerExceptHostHeader",
    );
  });

  it("disables caching so authenticated API responses are never served from the edge", () => {
    expect(defaultBehavior.cachePolicyId).toBe("cache:Managed-CachingDisabled");
  });

  it("allows write verbs — the SPA POSTs/PUTs through the distribution", () => {
    // A GET/HEAD-only default behavior 405s every write the browser makes.
    expect(defaultBehavior.allowedMethods).toEqual(
      expect.arrayContaining(["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]),
    );
  });

  it("sends everything else to the gateway origin", () => {
    expect(defaultBehavior.targetOriginId).toBe("api-gateway");
  });
});

describe("/apps/*/_next/static/* — immutable Next assets", () => {
  it("uses CachingOptimized against the gateway origin", () => {
    const behavior = behaviorFor("/apps/*/_next/static/*");
    expect(behavior).toBeDefined();
    expect(behavior!.cachePolicyId).toBe("cache:Managed-CachingOptimized");
    expect(behavior!.targetOriginId).toBe("api-gateway");
  });
});

describe("shared/* — Part B signed shared bytes", () => {
  it("requires CloudFront-signed requests from the key group", () => {
    const behavior = behaviorFor("shared/*");
    expect(behavior).toBeDefined();
    // No trusted key group ⇒ the S3 origin is openly readable through the edge.
    expect(behavior!.trustedKeyGroups?.length).toBeGreaterThan(0);
  });

  it("excludes query strings from the cache key, or the edge never hits", () => {
    // The signed-URL params (Expires/Signature/Key-Pair-Id) are validated by
    // CloudFront and then dropped from the cache key, so a freshly-signed URL
    // for an already-cached path still hits. `queryStringBehavior: "all"` would
    // keep every response correct and make Part B pointless — no test that only
    // re-fetches one signed URL can tell the difference, so assert it here.
    const behavior = behaviorFor("shared/*")!;
    const policy = created.find(
      (r) =>
        r.type.endsWith("cloudfront/cachePolicy:CachePolicy") &&
        `${r.name}-id` === behavior.cachePolicyId,
    );
    expect(policy, "shared/* must use the custom path-keyed cache policy").toBeDefined();

    const params = policy!.inputs.parametersInCacheKeyAndForwardedToOrigin as {
      queryStringsConfig: { queryStringBehavior: string };
      headersConfig: { headerBehavior: string };
      cookiesConfig: { cookieBehavior: string };
    };
    expect(params.queryStringsConfig.queryStringBehavior).toBe("none");
    // Headers/cookies in the cache key would fragment it the same way.
    expect(params.headersConfig.headerBehavior).toBe("none");
    expect(params.cookiesConfig.cookieBehavior).toBe("none");
  });

  it("is the ONLY path that routes to the S3 files origin", () => {
    // Part B's blast-radius argument is structural: apps/* private bytes are
    // unreachable through the distribution because no behavior routes there.
    const filesOriginId = "shared-files-s3";
    const toFiles = [defaultBehavior, ...orderedBehaviors].filter(
      (b) => b.targetOriginId === filesOriginId,
    );
    expect(toFiles).toHaveLength(1);
    expect(toFiles[0].pathPattern).toBe("shared/*");
  });

  it("locks the S3 origin behind Origin Access Control", () => {
    const origins = distribution.inputs.origins as Array<{
      originId: string;
      originAccessControlId?: string;
    }>;
    const filesOrigin = origins.find((o) => o.originId === "shared-files-s3");
    expect(filesOrigin?.originAccessControlId).toBeTruthy();
  });
});

describe("files bucket policy — the distribution can only ever read shared/*", () => {
  it("scopes the CloudFront Allow to shared/* under the distribution's SourceArn", () => {
    const bucketPolicy = created.find(
      (r) => r.type.endsWith("s3/bucketPolicy:BucketPolicy") && r.name === "starkeep-files-policy",
    );
    expect(bucketPolicy).toBeDefined();

    const doc = JSON.parse(bucketPolicy!.inputs.policy as string) as {
      Statement: Array<{
        Sid?: string;
        Effect: string;
        Resource: string | string[];
        Condition?: { StringEquals?: Record<string, string> };
      }>;
    };
    const allow = doc.Statement.find((s) => s.Sid === "AllowCloudFrontSharedRead");
    expect(allow).toBeDefined();
    expect(allow!.Effect).toBe("Allow");
    // The second, independent line of defense behind the behavior's path
    // pattern: even a mis-added apps/* behavior could not read apps/* bytes.
    expect(allow!.Resource).toMatch(/\/shared\/\*$/);
    expect(allow!.Condition?.StringEquals?.["AWS:SourceArn"]).toBeTruthy();
  });
});

describe("stack outputs", () => {
  it("exports publicBaseUrl as the distribution domain (the browser-facing base)", () => {
    expect(programOutputs.publicBaseUrl).toBe(`https://${distribution.name}.cloudfront.net`);
  });

  it("still exports apiGatewayUrl — server-to-server traffic stays off the edge", () => {
    expect(programOutputs.apiGatewayUrl).toMatch(/^https:\/\/mockapi\.execute-api\./);
  });
});
