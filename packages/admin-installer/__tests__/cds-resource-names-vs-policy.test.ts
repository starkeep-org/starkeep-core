/**
 * Every Lambda and log group the cloud-data-server program creates must fall
 * under the ARN patterns that govern it, and this test exists because one did
 * not: the session authorizer shipped as `${stackPrefix}-session-authorizer`
 * while all three policies scope to `${stackPrefix}-app-cloud-data-server-*`.
 *
 * The prefix is not a readability convention. It is the resource pattern in the
 * install-time temp policy, in the foundational permissions boundary, and in the
 * role's own runtime log-write grant — so a name outside it cannot be created,
 * could not write a log line if it were, and would survive the teardown that
 * sweeps by the same prefix. The 2026-08-24 live run failed on the first of
 * those, having found none of it at unit-test time.
 *
 * The patterns are read out of the policies rather than restated here, so
 * widening a policy widens what this admits and nothing has to be kept in sync
 * by hand.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { foundationalPermissionsBoundaryStatements } from "@starkeep/aws-bootstrap";
import { buildCloudDataServerProgram } from "../src/builtin-programs/cloud-data-server-program";
import type { CloudDataServerProgramContext } from "../src/builtin-programs/cloud-data-server-program";
import {
  buildTempInstallCloudDataServerPolicy,
  buildAppExecPolicy,
} from "../src/temp-policies";

const STACK_PREFIX = "starkeep";
const ACCOUNT_ID = "111122223333";
const REGION = "us-east-2";
const CDS_APP_ID = "cloud-data-server";

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
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "starkeep-test-project",
  "starkeep-test-stack",
  false,
);

const distZipPath = mkdtempSync(join(tmpdir(), "cds-names-"));

function makeCtx(): CloudDataServerProgramContext {
  return {
    stackPrefix: STACK_PREFIX,
    region: REGION,
    accountId: ACCOUNT_ID,
    appRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/${STACK_PREFIX}-app-${CDS_APP_ID}-role`,
    distZipPath,
    bundleHash: "abc123hash",
    userPoolId: "us-east-2_pool",
    userPoolClientId: "client123",
    ephemeral: false,
  };
}

interface Statement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  Resource?: string | string[];
}

const toArray = (x: string | string[] | undefined): string[] =>
  x === undefined ? [] : Array.isArray(x) ? x : [x];

/** An IAM resource pattern (`*` is the only wildcard that matters here). */
function matchesArn(pattern: string, arn: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(arn);
}

/** Resource patterns of every Allow statement granting `action`. */
function resourcesFor(statements: Statement[], action: string): string[] {
  return statements
    .filter((s) => s.Effect === "Allow" && toArray(s.Action).includes(action))
    .flatMap((s) => toArray(s.Resource));
}

const parse = (json: string): Statement[] => (JSON.parse(json) as { Statement: Statement[] }).Statement;

let lambdaNames: string[] = [];
let logGroupNames: string[] = [];

beforeAll(async () => {
  const outputs = await buildCloudDataServerProgram(makeCtx())();
  for (const value of Object.values(outputs)) {
    if (pulumi.Output.isInstance(value)) {
      await new Promise((resolve) => (value as pulumi.Output<unknown>).apply(resolve));
    }
  }
  const named = (suffix: string): string[] =>
    created
      .filter((r) => r.type.endsWith(suffix))
      .map((r) => r.inputs.name)
      .filter((n): n is string => typeof n === "string");
  lambdaNames = named("lambda/function:Function");
  logGroupNames = named("cloudwatch/logGroup:LogGroup");
});

describe("cloud-data-server resource names sit inside the policies that govern them", () => {
  it("creates the Lambdas and log groups this test is about", () => {
    // A silent zero would make every assertion below vacuously true — which is
    // the failure mode of a guard that reads its subject from a program.
    expect(lambdaNames.length).toBeGreaterThanOrEqual(2);
    expect(logGroupNames.length).toBeGreaterThanOrEqual(2);
    expect(lambdaNames).toContain(`${STACK_PREFIX}-app-${CDS_APP_ID}-session-authorizer`);
  });

  const cases: Array<[string, () => string[], string, (n: string) => string, () => Statement[]]> = [
    [
      "the install-time temp policy can create every Lambda",
      () => lambdaNames,
      "lambda:CreateFunction",
      (n) => `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${n}`,
      () => parse(buildTempInstallCloudDataServerPolicy(STACK_PREFIX, ACCOUNT_ID, REGION)),
    ],
    [
      "the foundational boundary permits creating every Lambda",
      () => lambdaNames,
      "lambda:CreateFunction",
      (n) => `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${n}`,
      () => foundationalPermissionsBoundaryStatements(STACK_PREFIX) as unknown as Statement[],
    ],
    [
      "the install-time temp policy can create every log group",
      () => logGroupNames,
      "logs:CreateLogGroup",
      (n) => `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${n}`,
      () => parse(buildTempInstallCloudDataServerPolicy(STACK_PREFIX, ACCOUNT_ID, REGION)),
    ],
    [
      "the foundational boundary permits creating every log group",
      () => logGroupNames,
      "logs:CreateLogGroup",
      (n) => `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${n}`,
      () => foundationalPermissionsBoundaryStatements(STACK_PREFIX) as unknown as Statement[],
    ],
    [
      "every Lambda can write to its own log group at runtime",
      () => logGroupNames,
      "logs:CreateLogStream",
      (n) => `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${n}`,
      () => parse(buildAppExecPolicy(STACK_PREFIX, CDS_APP_ID)),
    ],
  ];

  for (const [label, names, action, toArn, statements] of cases) {
    it(label, () => {
      const patterns = resourcesFor(statements(), action);
      expect(patterns.length, `no Allow statement grants ${action}`).toBeGreaterThan(0);
      for (const name of names()) {
        const arn = toArn(name);
        expect(
          patterns.some((p) => matchesArn(p, arn)),
          `${arn} matches none of the ${action} patterns: ${patterns.join(", ")}`,
        ).toBe(true);
      }
    });
  }

  it("the install-time temp policy can create every resource type the program declares", () => {
    // The other half of the same 2026-08-24 failure: the CloudFront function
    // was added to the program and its verbs were never added to the temp
    // policy. The foundational boundary caps CloudFront at `cloudfront:*`, so
    // the boundary said yes and the identity policy said nothing — which reads
    // as denied. The map is the create verb per Pulumi resource type; a new
    // resource type in the program with no entry here is itself the signal to
    // add one.
    const createVerbByType: Record<string, string> = {
      "cloudfront/distribution:Distribution": "cloudfront:CreateDistribution",
      "cloudfront/function:Function": "cloudfront:CreateFunction",
      "cloudfront/originAccessControl:OriginAccessControl": "cloudfront:CreateOriginAccessControl",
      "cloudfront/cachePolicy:CachePolicy": "cloudfront:CreateCachePolicy",
      "cloudfront/publicKey:PublicKey": "cloudfront:CreatePublicKey",
      "cloudfront/keyGroup:KeyGroup": "cloudfront:CreateKeyGroup",
      "lambda/function:Function": "lambda:CreateFunction",
      "cloudwatch/logGroup:LogGroup": "logs:CreateLogGroup",
      "apigatewayv2/api:Api": "apigatewayv2:CreateApi",
      "apigatewayv2/authorizer:Authorizer": "apigatewayv2:CreateAuthorizer",
      "dsql/cluster:Cluster": "dsql:CreateCluster",
    };
    const policy = parse(buildTempInstallCloudDataServerPolicy(STACK_PREFIX, ACCOUNT_ID, REGION));
    const granted = new Set(
      policy.filter((s) => s.Effect === "Allow").flatMap((s) => toArray(s.Action)),
    );
    const declared = new Set(created.map((r) => r.type.replace(/^aws:/, "")));
    for (const [type, verb] of Object.entries(createVerbByType)) {
      if (!declared.has(type)) continue;
      expect(granted.has(verb), `program creates ${type} but the temp policy lacks ${verb}`).toBe(true);
    }
  });

  it("teardown's prefix sweep reaches every Lambda and log group", () => {
    // scripts/teardown-cloud-data-server.sh deletes by this literal prefix. A
    // resource outside it survives teardown and then collides with the next
    // install by name.
    const sweep = `${STACK_PREFIX}-app-${CDS_APP_ID}-`;
    for (const name of lambdaNames) expect(name.startsWith(sweep), name).toBe(true);
    for (const name of logGroupNames) expect(name.startsWith(`/aws/lambda/${sweep}`), name).toBe(true);
  });

  it("tags the DSQL cluster with its stack prefix, the only thing that attributes it", () => {
    // A cluster identifier is assigned by AWS, so the cluster is the one
    // resource teardown cannot select by name. Without this tag, teardown for
    // one prefix cannot tell its own cluster from another deployment's — which
    // is how `--force` against the test prefix came to be aimed at the live
    // deployment's cluster.
    const cluster = created.find((r) => r.type.endsWith("dsql/cluster:Cluster"));
    expect(cluster, "the program declares no DSQL cluster").toBeDefined();
    const tags = cluster!.inputs.tags as Record<string, string>;
    expect(tags["starkeep:stackPrefix"]).toBe(STACK_PREFIX);
  });
});
