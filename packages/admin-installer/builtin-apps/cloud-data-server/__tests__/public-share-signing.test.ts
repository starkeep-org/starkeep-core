/**
 * Adversarial tests for the public-share signer.
 *
 * A visitor of a public share is anonymous, so `signPublicShareCloudFrontUrl`
 * has no grants to check. What stands between the internet and the owner's
 * bytes is the page's `PublicDisplaySet`: the key must be a display child the
 * fixed query returned, under the owner's own prefix, and never a member's own
 * key. These tests treat the key as hostile — an original, another user's
 * key, a key the page never returned, traversal, and other namespaces.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import {
  PublicDisplaySet,
  expiresAtFor,
  publicItemId,
  publicItemsToken,
  newLinkToken,
} from "../src/public-shares.js";

const ssmMock = mockClient(SSMClient);
const cfKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

type HandlerModule = typeof import("../src/api-handler.js");
let sign: HandlerModule["signPublicShareCloudFrontUrl"];

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AWS_REGION = "us-east-1";
  process.env.CLOUDFRONT_SIGNING_PARAM = "/teststack/app-creds/_cloudfront-signing";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sign = (await import("../src/api-handler.js")).signPublicShareCloudFrontUrl;
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  ssmMock.reset();
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: {
      Value: JSON.stringify({
        keyPairId: "KTESTPAIR",
        domain: "dtestcdn.cloudfront.net",
        privateKey: cfKeyPair.privateKey,
      }),
    },
  });
});

const OWNER = "owner-1";
const ORIGINAL = `shared/${OWNER}/image/ab/${"a".repeat(64)}`;
const STAND_IN = `shared/${OWNER}/image/cd/${"c".repeat(64)}`;
const ELSEWHERE = `shared/${OWNER}/image/ef/${"e".repeat(64)}`;

function page(): PublicDisplaySet {
  const display = new PublicDisplaySet(OWNER);
  display.addMember({ objectStorageKey: ORIGINAL, parentId: null });
  display.admit({ objectStorageKey: STAND_IN, parentId: "rec-original" });
  return display;
}

describe("signPublicShareCloudFrontUrl", () => {
  it("signs a display child the page admitted", async () => {
    const result = await sign(page(), STAND_IN, 3600);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.startsWith(`https://dtestcdn.cloudfront.net/${STAND_IN}?`)).toBe(true);
      expect(result.url).toContain("Signature=");
    }
  });

  it("refuses a member's own key", async () => {
    expect(await sign(page(), ORIGINAL, 3600)).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a member's key even when a child with the same bytes was admitted", async () => {
    const display = page();
    display.admit({ objectStorageKey: ORIGINAL, parentId: "rec-original" });
    expect(await sign(display, ORIGINAL, 3600)).toMatchObject({ ok: false, status: 403 });
  });

  it("never admits a parentless record", async () => {
    const display = page();
    expect(display.admit({ objectStorageKey: ELSEWHERE, parentId: null })).toBe(false);
    expect(await sign(display, ELSEWHERE, 3600)).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a key the page never returned", async () => {
    expect(await sign(page(), ELSEWHERE, 3600)).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses another user's key, even one admitted by mistake", async () => {
    const other = `shared/owner-2/image/cd/${"c".repeat(64)}`;
    const display = page();
    display.admit({ objectStorageKey: other, parentId: "rec-x" });
    expect(await sign(display, other, 3600)).toMatchObject({ ok: false, status: 403 });
  });

  it.each([
    `shared/${OWNER}/image/../video/${"c".repeat(64)}`,
    `shared/${OWNER}/image/cd/../../../apps/photos/x`,
    `apps/photos/${OWNER}/syncable/albums.json`,
    `${STAND_IN}/`,
    `/${STAND_IN}`,
    `shared/${OWNER}/image/cd/${"c".repeat(64)}%2F..`,
    "",
  ])("refuses a malformed or foreign key: %s", async (key) => {
    const display = page();
    display.admit({ objectStorageKey: key, parentId: "rec-x" });
    const result = await sign(display, key, 3600);
    expect(result.ok).toBe(false);
  });

  it("reads no signing config for a refused key", async () => {
    await sign(page(), ORIGINAL, 3600);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
  });
});

describe("public-share identifiers", () => {
  it("accepts only a well-formed link token in the items path", () => {
    const token = newLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(publicItemsToken(`/public-shares/${token}/items`)).toBe(token);
    expect(publicItemsToken(`/public-shares/${token}`)).toBeNull();
    expect(publicItemsToken(`/public-shares/${token}/items/x`)).toBeNull();
    expect(publicItemsToken(`/public-shares/short/items`)).toBeNull();
    expect(publicItemsToken(`/public-shares/${token.slice(0, 21)}%2F/items`)).toBeNull();
    expect(publicItemsToken(`/apps/photos/public-shares/${token}/items`)).toBeNull();
  });

  it("derives item ids stable within a share and unlinkable across shares", () => {
    const id = "rec-1" as StarkeepId;
    const a = publicItemId("salt-a", id);
    expect(publicItemId("salt-a", id)).toBe(a);
    expect(publicItemId("salt-b", id)).not.toBe(a);
    expect(a).not.toContain("rec-1");
  });

  it("turns a lifetime into an expiry, and refuses anything else", () => {
    const now = 1_000_000;
    expect(expiresAtFor("never", now)).toEqual({ ok: true, expiresAtMs: null });
    expect(expiresAtFor("7d", now)).toEqual({ ok: true, expiresAtMs: now + 7 * 86_400_000 });
    expect(expiresAtFor("toString", now)).toEqual({ ok: false });
    expect(expiresAtFor(30, now)).toEqual({ ok: false });
  });
});
