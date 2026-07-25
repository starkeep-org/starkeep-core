/**
 * `getCapabilityBrokerCreds` — the per-assume inline session policy the whole
 * S3-location design rests on (plan §3.4 / §3.8, open question 10).
 *
 * Two properties are load-bearing and neither fails loudly if it regresses:
 *
 *  1. A session policy is an INTERSECTION over the session, so it must re-Allow
 *     the Bedrock verbs — omit them and the invoke itself is denied. The S3
 *     statements must stay narrowed to exactly the referenced key / output
 *     prefix, because the standing role holds broad access on the files bucket.
 *  2. The unscoped assume is cached under a fixed key; the SCOPED assume must
 *     never be cached and must never be served FROM that cache — otherwise a
 *     scoped request silently runs with un-narrowed credentials.
 *
 * STS is mocked, so what's asserted is the exact `Policy` document handed to
 * AssumeRole and how many times AssumeRole is called.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const stsMock = mockClient(STSClient);
const ACCOUNT_ID = "123456789012";

interface PolicyStatement {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
}
interface PolicyDoc {
  Version: string;
  Statement: PolicyStatement[];
}

type HandlerModule = typeof import("../src/api-handler.js");
let getCapabilityBrokerCreds: HandlerModule["getCapabilityBrokerCreds"];
let resetCache: HandlerModule["__resetCapabilityCredsCacheForTests"];

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AWS_REGION = "us-east-1";
  process.env.AURORA_ENDPOINT = "invalid.test.localdomain";
  process.env.S3_BUCKET = "fake-bucket";
  const mod = await import("../src/api-handler.js");
  getCapabilityBrokerCreds = mod.getCapabilityBrokerCreds;
  resetCache = mod.__resetCapabilityCredsCacheForTests;
});

beforeEach(() => {
  stsMock.reset();
  resetCache();
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIAFAKE",
      SecretAccessKey: "fake-secret",
      SessionToken: "fake-token",
      Expiration: new Date(Date.now() + 900_000),
    },
  });
});

/** The session policy attached to the Nth AssumeRole call (undefined if none). */
function policyOf(n = 0): PolicyDoc | undefined {
  const raw = stsMock.commandCalls(AssumeRoleCommand)[n]!.args[0].input.Policy;
  return raw ? (JSON.parse(raw) as PolicyDoc) : undefined;
}

function sids(doc: PolicyDoc): string[] {
  return doc.Statement.map((s) => s.Sid);
}

function statement(doc: PolicyDoc, sid: string): PolicyStatement {
  const s = doc.Statement.find((x) => x.Sid === sid);
  if (!s) throw new Error(`no statement ${sid} in ${JSON.stringify(doc)}`);
  return s;
}

const ONE_KEY = { s3Keys: [{ bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" }] };

describe("unscoped assume (inline / text-only / async status poll)", () => {
  it("attaches NO session policy at all", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID);
    expect(stsMock.commandCalls(AssumeRoleCommand)[0]!.args[0].input.Policy).toBeUndefined();
  });

  it("assumes the stack's capability-broker role", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID);
    expect(stsMock.commandCalls(AssumeRoleCommand)[0]!.args[0].input.RoleArn).toBe(
      `arn:aws:iam::${ACCOUNT_ID}:role/teststack-app-capability-broker-role`,
    );
  });

  it("treats an empty scope object as unscoped", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, {});
    await getCapabilityBrokerCreds(ACCOUNT_ID, { s3Keys: [], s3PutKeyPrefixes: [] });
    expect(policyOf(0)).toBeUndefined();
    // Both are cacheable, so the second never reaches STS.
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });

  it("is CACHED across requests while the session is fresh", async () => {
    const a = await getCapabilityBrokerCreds(ACCOUNT_ID);
    const b = await getCapabilityBrokerCreds(ACCOUNT_ID);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
    expect(b).toBe(a);
  });

  it("re-assumes once the cached session is inside the refresh buffer", async () => {
    stsMock.reset();
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: "AKIAFAKE",
        SecretAccessKey: "fake-secret",
        SessionToken: "fake-token",
        // Expires in 30s — inside the 60s refresh buffer, so never reusable.
        Expiration: new Date(Date.now() + 30_000),
      },
    });
    await getCapabilityBrokerCreds(ACCOUNT_ID);
    await getCapabilityBrokerCreds(ACCOUNT_ID);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(2);
  });

  it("bedrockAsync alone (the status poll) still needs no session policy", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, { bedrockAsync: true });
    expect(policyOf(0)).toBeUndefined();
  });
});

describe("S3-scoped assume — session policy document", () => {
  it("re-Allows the Bedrock verbs (a session policy can only restrict)", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, ONE_KEY);
    const doc = policyOf(0)!;
    expect(doc.Version).toBe("2012-10-17");
    const bedrock = statement(doc, "SessionBedrockInvoke");
    expect(bedrock.Effect).toBe("Allow");
    expect(bedrock.Action).toEqual([
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream",
    ]);
    expect(bedrock.Resource).toEqual([
      "arn:aws:bedrock:*::foundation-model/*",
      `arn:aws:bedrock:*:${ACCOUNT_ID}:inference-profile/*`,
      `arn:aws:bedrock:*:${ACCOUNT_ID}:application-inference-profile/*`,
    ]);
  });

  it("narrows GetObject to EXACTLY the referenced key", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, ONE_KEY);
    const s3 = statement(policyOf(0)!, "SessionS3OneKey");
    expect(s3.Effect).toBe("Allow");
    expect(s3.Action).toBe("s3:GetObject");
    expect(s3.Resource).toEqual(["arn:aws:s3:::stk-files-1/shared/image/ab/cd/pic.jpg"]);
    // No wildcard reach into the rest of the bucket.
    expect(JSON.stringify(s3.Resource)).not.toContain("*");
  });

  it("does not grant PutObject on a read-only (input) scope", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, ONE_KEY);
    expect(sids(policyOf(0)!)).toEqual(["SessionBedrockInvoke", "SessionS3OneKey"]);
    expect(JSON.stringify(policyOf(0))).not.toContain("PutObject");
  });

  it("carries every referenced key when more than one is scoped", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, {
      s3Keys: [
        { bucket: "b1", key: "k1" },
        { bucket: "b2", key: "k2" },
      ],
    });
    expect(statement(policyOf(0)!, "SessionS3OneKey").Resource).toEqual([
      "arn:aws:s3:::b1/k1",
      "arn:aws:s3:::b2/k2",
    ]);
  });

  it("narrows PutObject to the single per-invocation output FOLDER", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, {
      s3PutKeyPrefixes: [{ bucket: "stk-files-1", keyPrefix: "apps/photos/syncable/capability-async/inv-1" }],
    });
    const doc = policyOf(0)!;
    expect(sids(doc)).toEqual(["SessionBedrockInvoke", "SessionS3OutputPrefix"]);
    const put = statement(doc, "SessionS3OutputPrefix");
    expect(put.Action).toBe("s3:PutObject");
    // Bedrock writes output.mp4 + manifest.json + generation-status.json under
    // the folder, so the trailing /* is the folder, not the whole bucket.
    expect(put.Resource).toEqual([
      "arn:aws:s3:::stk-files-1/apps/photos/syncable/capability-async/inv-1/*",
    ]);
  });

  it("adds the async verbs AND the async-invoke resource when bedrockAsync is set", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, {
      bedrockAsync: true,
      s3PutKeyPrefixes: [{ bucket: "stk-files-1", keyPrefix: "apps/photos/syncable/capability-async/inv-1" }],
    });
    const bedrock = statement(policyOf(0)!, "SessionBedrockInvoke");
    expect(bedrock.Action).toContain("bedrock:StartAsyncInvoke");
    expect(bedrock.Action).toContain("bedrock:GetAsyncInvoke");
    expect(bedrock.Action).toContain("bedrock:ListAsyncInvokes");
    // Without this resource the async verbs would have nothing to act on.
    expect(bedrock.Resource).toContain(`arn:aws:bedrock:*:${ACCOUNT_ID}:async-invoke/*`);
  });

  it("omits the async verbs on a synchronous scoped assume", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, ONE_KEY);
    const bedrock = statement(policyOf(0)!, "SessionBedrockInvoke");
    expect(bedrock.Action).not.toContain("bedrock:StartAsyncInvoke");
    expect(JSON.stringify(bedrock.Resource)).not.toContain("async-invoke");
  });

  it("combines an input key and an output prefix (image-to-video start)", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, {
      bedrockAsync: true,
      s3Keys: [{ bucket: "stk-files-1", key: "shared/image/ab/cd/pic.jpg" }],
      s3PutKeyPrefixes: [{ bucket: "stk-files-1", keyPrefix: "apps/photos/syncable/capability-async/inv-1" }],
    });
    expect(sids(policyOf(0)!)).toEqual([
      "SessionBedrockInvoke",
      "SessionS3OneKey",
      "SessionS3OutputPrefix",
    ]);
  });
});

describe("scoped assumes are never cached (the downscoping must not leak)", () => {
  it("assumes freshly for each scoped request, even with an identical scope", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, ONE_KEY);
    await getCapabilityBrokerCreds(ACCOUNT_ID, ONE_KEY);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(2);
    expect(policyOf(0)).toEqual(policyOf(1));
  });

  it("a scoped request never reuses the cached UNSCOPED session", async () => {
    // Warm the unscoped cache first — the regression this guards against is a
    // scoped request being served the broad, un-narrowed credential.
    await getCapabilityBrokerCreds(ACCOUNT_ID);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
    await getCapabilityBrokerCreds(ACCOUNT_ID, ONE_KEY);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(2);
    expect(policyOf(1)).toBeDefined();
  });

  it("a scoped assume does not poison the cache for later unscoped requests", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, ONE_KEY);
    await getCapabilityBrokerCreds(ACCOUNT_ID);
    await getCapabilityBrokerCreds(ACCOUNT_ID);
    const calls = stsMock.commandCalls(AssumeRoleCommand);
    // scoped, then one unscoped assume that the third call reuses.
    expect(calls).toHaveLength(2);
    expect(policyOf(0)).toBeDefined();
    expect(policyOf(1)).toBeUndefined();
  });

  it("scoped assumes for different keys produce different policies", async () => {
    await getCapabilityBrokerCreds(ACCOUNT_ID, { s3Keys: [{ bucket: "b", key: "one" }] });
    await getCapabilityBrokerCreds(ACCOUNT_ID, { s3Keys: [{ bucket: "b", key: "two" }] });
    expect(statement(policyOf(0)!, "SessionS3OneKey").Resource).toEqual(["arn:aws:s3:::b/one"]);
    expect(statement(policyOf(1)!, "SessionS3OneKey").Resource).toEqual(["arn:aws:s3:::b/two"]);
  });
});

describe("failure handling", () => {
  it("throws when STS returns an incomplete credential set", async () => {
    stsMock.reset();
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: "AK" } as never });
    await expect(getCapabilityBrokerCreds(ACCOUNT_ID)).rejects.toThrow(
      /Failed to assume capability-broker role/,
    );
  });

  it("requires STACK_PREFIX", async () => {
    const saved = process.env.STACK_PREFIX;
    delete process.env.STACK_PREFIX;
    await expect(getCapabilityBrokerCreds(ACCOUNT_ID)).rejects.toThrow(/STACK_PREFIX/);
    process.env.STACK_PREFIX = saved;
  });
});
