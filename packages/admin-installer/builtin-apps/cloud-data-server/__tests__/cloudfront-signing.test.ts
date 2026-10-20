/**
 * Adversarial tests for the CloudFront shared-file signing chokepoint
 * (signSharedCloudFrontUrl) and the parseObjectKey hardening behind it.
 *
 * With Part B, the per-app IAM ceiling is gone from the shared read path, so
 * this in-process chokepoint is the ONLY per-request defense before a URL is
 * signed. These tests treat the key as adversarial input — foreign categories,
 * apps/* and unknown namespaces, path traversal, encoding tricks, case
 * variants, and malformed segments — not just the happy path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type { AccessGrants } from "../src/access-enforcer.js";
import type { BrokerSubject } from "../src/api-handler.js";

/** A subject acting for user `u1`. */
function as(appId: string): BrokerSubject {
  return { appId, userId: "u1" };
}

const ssmMock = mockClient(SSMClient);

const cfKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const CF_DOMAIN = "dtestcdn.cloudfront.net";
const CF_KEY_PAIR_ID = "KTESTPAIR";
const CF_SIGNING_PARAM = "/teststack/app-creds/_cloudfront-signing";

type HandlerModule = typeof import("../src/api-handler.js");
let signSharedCloudFrontUrl: HandlerModule["signSharedCloudFrontUrl"];

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AWS_REGION = "us-east-1";
  process.env.CLOUDFRONT_SIGNING_PARAM = CF_SIGNING_PARAM;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const mod = await import("../src/api-handler.js");
  signSharedCloudFrontUrl = mod.signSharedCloudFrontUrl;
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  ssmMock.reset();
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: {
      Value: JSON.stringify({
        keyPairId: CF_KEY_PAIR_ID,
        domain: CF_DOMAIN,
        privateKey: cfKeyPair.privateKey,
      }),
    },
  });
});

function grants(
  overrides: Partial<{
    readableCategories: string[];
    writableCategories: string[];
    allAccess: boolean;
  }> = {},
): AccessGrants {
  return {
    readableTypes: new Set(),
    writableTypes: new Set(),
    readableCategories: new Set(overrides.readableCategories ?? []),
    writableCategories: new Set(overrides.writableCategories ?? []),
    writableMetadataCategories: new Set(),
    allAccess: overrides.allAccess ?? false,
  };
}

describe("signSharedCloudFrontUrl — happy path", () => {
  it("signs a well-formed shared key the caller can read", async () => {
    const res = await signSharedCloudFrontUrl(
      as("photos"),
      "shared/u1/image/ab/abc123def456",
      grants({ readableCategories: ["image"] }),
      3600,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url).toContain(`https://${CF_DOMAIN}/shared/u1/image/ab/abc123def456`);
    expect(res.url).toContain("Signature=");
    expect(res.url).toContain(`Key-Pair-Id=${CF_KEY_PAIR_ID}`);
    expect(res.url).toContain("Expires=");
  });

  it("lets an allAccess (Drive) caller sign any category", async () => {
    const res = await signSharedCloudFrontUrl(
      as("starkeep-drive"),
      "shared/u1/audio/cd/aabbccdd",
      grants({ allAccess: true }),
      3600,
    );
    expect(res.ok).toBe(true);
  });
});

describe("signSharedCloudFrontUrl — grant enforcement", () => {
  it("403s a category the caller cannot read", async () => {
    const res = await signSharedCloudFrontUrl(
      as("photos"),
      "shared/u1/audio/ab/abc123",
      grants({ readableCategories: ["image"] }),
      3600,
    );
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("does not reach the signer when the grant check fails (SSM never read)", async () => {
    await signSharedCloudFrontUrl(
      as("photos"),
      "shared/u1/audio/ab/abc123",
      grants({ readableCategories: ["image"] }),
      3600,
    );
    expect(ssmMock.calls()).toHaveLength(0);
  });
});

describe("signSharedCloudFrontUrl — user confinement", () => {
  it("403s another user's key, even for an allAccess caller, without reaching the signer", async () => {
    const res = await signSharedCloudFrontUrl(
      as("starkeep-drive"),
      "shared/u2/image/ab/abc123",
      grants({ allAccess: true }),
      3600,
    );
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it("400s a key in the old layout, which names no user", async () => {
    const res = await signSharedCloudFrontUrl(
      as("starkeep-drive"),
      "shared/image/ab/abc123",
      grants({ allAccess: true }),
      3600,
    );
    expect(res).toMatchObject({ ok: false, status: 400 });
  });
});

describe("signSharedCloudFrontUrl — namespace confinement", () => {
  it("400s an apps/* key even for its owner (CloudFront never serves apps/*)", async () => {
    const res = await signSharedCloudFrontUrl(
      as("photos"),
      "apps/photos/u1/syncable/files/thumb.png",
      grants({ allAccess: true }),
      3600,
    );
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it.each(["private/photos/x", "", "sharedish/image/ab/hash", "shared", "shared/u1/"])(
    "400s the unknown/short namespace %j",
    async (key) => {
      const res = await signSharedCloudFrontUrl(
        as("photos"),
        key,
        grants({ allAccess: true }),
        3600,
      );
      expect(res).toMatchObject({ ok: false });
      if (res.ok) throw new Error("expected rejection");
      expect(res.status).toBe(400);
    },
  );
});

describe("signSharedCloudFrontUrl — path traversal & encoding", () => {
  it.each([
    // ".." segments that a client/edge would normalize into a different key
    "shared/u1/image/../audio/abc123",
    "shared/u1/../apps/photos/syncable/x",
    "shared/u1/image/ab/../../audio/ab/hash",
    "shared/u1/..",
    // encoded slash / percent-escapes (key arrives already decoded, so a
    // residual %2f is a literal % that must be rejected)
    "shared/u1/image/ab/ha%2fsh",
    "shared/u1/image/%2e%2e/hash",
    // embedded extra slash → wrong segment count
    "shared/u1/image/ab/cd/hash",
    // whitespace / control chars
    "shared/u1/image/ab/ab cd",
    "shared/u1/image/ab/ab\thash",
    "shared/u1/image/ab/ab\nhash",
  ])("rejects the adversarial key %j (allAccess grant — pure key defense)", async (key) => {
    const res = await signSharedCloudFrontUrl(as("photos"), key, grants({ allAccess: true }), 3600);
    expect(res).toMatchObject({ ok: false });
    if (res.ok) throw new Error("expected rejection");
    expect(res.status).toBe(400);
    // Nothing that fails the key check should ever reach the signer.
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it("rejects an uppercase category even if the lowercase form is granted (no case-bypass)", async () => {
    const res = await signSharedCloudFrontUrl(
      as("photos"),
      "shared/u1/IMAGE/ab/abc123",
      grants({ readableCategories: ["image"] }),
      3600,
    );
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it.each([
    "shared/u1/image//abc123", // empty shard
    "shared/u1/image/ab/", // empty hash
    "shared/u1//ab/abc123", // empty category
    "shared/u1/image/hash", // three segments
  ])("400s malformed/empty-segment key %j", async (key) => {
    const res = await signSharedCloudFrontUrl(as("photos"), key, grants({ allAccess: true }), 3600);
    expect(res).toMatchObject({ ok: false, status: 400 });
  });
});
