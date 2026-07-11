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

function grants(overrides: Partial<{
  readableCategories: string[];
  writableCategories: string[];
  allAccess: boolean;
}> = {}): AccessGrants {
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
      "photos",
      "shared/image/ab/abc123def456",
      grants({ readableCategories: ["image"] }),
      3600,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url).toContain(`https://${CF_DOMAIN}/shared/image/ab/abc123def456`);
    expect(res.url).toContain("Signature=");
    expect(res.url).toContain(`Key-Pair-Id=${CF_KEY_PAIR_ID}`);
    expect(res.url).toContain("Expires=");
  });

  it("lets an allAccess (Drive) caller sign any category", async () => {
    const res = await signSharedCloudFrontUrl(
      "starkeep-drive",
      "shared/audio/cd/aabbccdd",
      grants({ allAccess: true }),
      3600,
    );
    expect(res.ok).toBe(true);
  });
});

describe("signSharedCloudFrontUrl — grant enforcement", () => {
  it("403s a category the caller cannot read", async () => {
    const res = await signSharedCloudFrontUrl(
      "photos",
      "shared/audio/ab/abc123",
      grants({ readableCategories: ["image"] }),
      3600,
    );
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("does not reach the signer when the grant check fails (SSM never read)", async () => {
    await signSharedCloudFrontUrl(
      "photos",
      "shared/audio/ab/abc123",
      grants({ readableCategories: ["image"] }),
      3600,
    );
    expect(ssmMock.calls()).toHaveLength(0);
  });
});

describe("signSharedCloudFrontUrl — namespace confinement", () => {
  it("400s an apps/* key even for its owner (CloudFront never serves apps/*)", async () => {
    const res = await signSharedCloudFrontUrl(
      "photos",
      "apps/photos/syncable/files/thumb.png",
      grants({ allAccess: true }),
      3600,
    );
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it.each([
    "private/photos/x",
    "",
    "sharedish/image/ab/hash",
    "shared",
    "shared/",
  ])("400s the unknown/short namespace %j", async (key) => {
    const res = await signSharedCloudFrontUrl(
      "photos",
      key,
      grants({ allAccess: true }),
      3600,
    );
    expect(res).toMatchObject({ ok: false });
    if (res.ok) throw new Error("expected rejection");
    expect(res.status).toBe(400);
  });
});

describe("signSharedCloudFrontUrl — path traversal & encoding", () => {
  it.each([
    // ".." segments that a client/edge would normalize into a different key
    "shared/image/../audio/abc123",
    "shared/../apps/photos/syncable/x",
    "shared/image/ab/../../audio/ab/hash",
    "shared/..",
    // encoded slash / percent-escapes (key arrives already decoded, so a
    // residual %2f is a literal % that must be rejected)
    "shared/image/ab/ha%2fsh",
    "shared/image/%2e%2e/hash",
    // embedded extra slash → wrong segment count
    "shared/image/ab/cd/hash",
    // whitespace / control chars
    "shared/image/ab/ab cd",
    "shared/image/ab/ab\thash",
    "shared/image/ab/ab\nhash",
  ])("rejects the adversarial key %j (allAccess grant — pure key defense)", async (key) => {
    const res = await signSharedCloudFrontUrl("photos", key, grants({ allAccess: true }), 3600);
    expect(res).toMatchObject({ ok: false });
    if (res.ok) throw new Error("expected rejection");
    expect(res.status).toBe(400);
    // Nothing that fails the key check should ever reach the signer.
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it("rejects an uppercase category even if the lowercase form is granted (no case-bypass)", async () => {
    const res = await signSharedCloudFrontUrl(
      "photos",
      "shared/IMAGE/ab/abc123",
      grants({ readableCategories: ["image"] }),
      3600,
    );
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it.each([
    "shared/image//abc123", // empty shard
    "shared/image/ab/", // empty hash
    "shared//ab/abc123", // empty category
    "shared/image/hash", // three segments
  ])("400s malformed/empty-segment key %j", async (key) => {
    const res = await signSharedCloudFrontUrl("photos", key, grants({ allAccess: true }), 3600);
    expect(res).toMatchObject({ ok: false, status: 400 });
  });
});
