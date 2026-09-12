/**
 * POST /api/costs — month-to-date spend, read out of the Cost and Usage Report
 * the stack delivers to its own billing bucket.
 *
 * The dashboard renders three distinct states from this one route, and telling
 * them apart is the whole job: real numbers, "no report yet" (which is what a
 * stack younger than a billing period looks like, and must not read as an
 * error), and a genuine failure. The S3 and STS clients are mocked so the
 * report parsing runs for real — the gzip, the CSV, the line-item filter — with
 * only the network replaced.
 */
import { gzipSync } from "node:zlib";
import { mockClient } from "aws-sdk-client-mock";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { jsonRequest, makeDataDir, type RouteHandler } from "./helpers";

const s3 = mockClient(S3Client);
const sts = mockClient(STSClient);

let POST: RouteHandler;

const CREDENTIALS = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: new Date(Date.now() + 3_600_000).toISOString(),
};

beforeAll(async () => {
  process.env.STARKEEP_DIR = makeDataDir("adminweb-costs-");
  const route = await import("../app/api/costs/route");
  POST = route.POST as unknown as RouteHandler;
});

afterEach(() => {
  s3.reset();
  sts.reset();
});

const call = () =>
  POST(
    jsonRequest("/api/costs", {
      credentials: CREDENTIALS,
      stackPrefix: "sktest",
      region: "us-east-2",
    }),
  );

/** A CUR chunk as S3 serves it: gzipped CSV with the three columns that matter. */
function reportChunk(rows: Array<[string, string, string]>): Uint8Array {
  const header = "lineItem/ProductCode,lineItem/UnblendedCost,lineItem/LineItemType";
  const body = rows.map(([code, cost, type]) => `${code},${cost},${type}`).join("\n");
  return new Uint8Array(gzipSync(Buffer.from(`${header}\n${body}\n`, "utf-8")));
}

function bodyOf(bytes: Uint8Array) {
  return { transformToByteArray: async () => bytes, transformToString: async () => "" };
}

function textBody(text: string) {
  return { transformToString: async () => text, transformToByteArray: async () => new Uint8Array() };
}

function stubReport(rows: Array<[string, string, string]>): void {
  sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012" });
  s3.on(ListObjectsV2Command).resolves({
    Contents: [{ Key: "reports/sktest-billing/20260901-20261001/sktest-billing-Manifest.json" }],
  });
  s3.on(GetObjectCommand, {
    Key: "reports/sktest-billing/20260901-20261001/sktest-billing-Manifest.json",
  }).resolves({
    Body: textBody(JSON.stringify({ reportKeys: ["reports/chunk-1.csv.gz"] })),
  } as never);
  s3.on(GetObjectCommand, { Key: "reports/chunk-1.csv.gz" }).resolves({
    Body: bodyOf(reportChunk(rows)),
  } as never);
}

describe("a stack with a delivered report", () => {
  it("totals the report by service, under the names the dashboard shows", async () => {
    stubReport([
      ["AWSLambda", "1.25", "Usage"],
      ["AWSLambda", "0.75", "Usage"],
      ["AmazonS3", "0.50", "Usage"],
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    const { costs } = (await res.json()) as { costs: Array<{ service: string; amount: number }> };
    expect(costs).toEqual([
      { service: "Lambda", amount: 2 },
      { service: "S3", amount: 0.5 },
    ]);
  });

  it("leaves tax and credits out, which are not what the stack costs to run", async () => {
    stubReport([
      ["AWSLambda", "1.00", "Usage"],
      ["AWSLambda", "0.10", "Tax"],
      ["AWSLambda", "-0.50", "Credit"],
    ]);
    const { costs } = (await (await call()).json()) as {
      costs: Array<{ service: string; amount: number }>;
    };
    expect(costs).toEqual([{ service: "Lambda", amount: 1 }]);
  });

  it("reports a service it has no label for rather than dropping it", async () => {
    // An unlabelled service is spend the operator is paying for. Showing it
    // under its raw code is worse copy and a correct total.
    stubReport([
      ["AWSLambda", "1.00", "Usage"],
      ["AmazonCloudWatch", "3.00", "Usage"],
    ]);
    const { costs } = (await (await call()).json()) as {
      costs: Array<{ service: string; amount: number }>;
    };
    expect(costs).toEqual([
      { service: "Lambda", amount: 1 },
      { service: "AmazonCloudWatch", amount: 3 },
    ]);
  });
});

describe("a stack with no report yet", () => {
  it("answers costs: null when the billing bucket does not exist", async () => {
    // The first weeks of a new stack. Not an error, and the dashboard must not
    // render one — it says "no data yet".
    sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012" });
    const noSuchBucket = Object.assign(new Error("The specified bucket does not exist"), {
      name: "NoSuchBucket",
      Code: "NoSuchBucket",
    });
    s3.on(ListObjectsV2Command).rejects(noSuchBucket);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ costs: null });
  });

  it("answers costs: null when the prefix is empty", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012" });
    s3.on(ListObjectsV2Command).resolves({ Contents: [] });
    expect(await (await call()).json()).toEqual({ costs: null });
  });

  it("answers costs: null when the period holds no manifest", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012" });
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: "reports/whatever.csv.gz" }] });
    expect(await (await call()).json()).toEqual({ costs: null });
  });
});

describe("a genuine failure", () => {
  it("answers 500 naming the error, so a denied read is not read as zero spend", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012" });
    const denied = Object.assign(new Error("not authorized"), {
      name: "AccessDenied",
      Code: "AccessDenied",
    });
    s3.on(ListObjectsV2Command).rejects(denied);
    const res = await call();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain("AccessDenied");
    expect(body.code).toBe("AccessDenied");
  });

  it("answers 500 when the account id cannot be determined", async () => {
    sts.on(GetCallerIdentityCommand).resolves({});
    expect((await call()).status).toBe(500);
  });
});
