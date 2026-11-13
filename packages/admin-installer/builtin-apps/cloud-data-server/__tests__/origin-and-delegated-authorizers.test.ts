/**
 * The origin authorizer and the delegated authorizer. Both admit only
 * requests that came through CloudFront, and neither ever throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appIdOfPath,
  handler as delegated,
  resetPublicKeyCache,
} from "../src/delegated-authorizer.js";
import { delegationSigningKeyFromPem, signDelegationToken } from "../src/delegation-tokens.js";
import { handler as origin } from "../src/origin-authorizer.js";
import { makeDelegationKeyPem } from "./delegation-key.js";

const ORIGIN_SECRET = "s".repeat(43);
const pem = makeDelegationKeyPem();
const key = delegationSigningKeyFromPem(pem.privateKeyPem);
const saved = { ...process.env };

beforeEach(() => {
  process.env.STARKEEP_ORIGIN_SECRET = ORIGIN_SECRET;
  process.env.STARKEEP_DELEGATION_PUBLIC_KEY = pem.publicKeyPem;
  resetPublicKeyCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

function token(appId = "probe", expiresAtMs = Date.now() + 60_000) {
  return signDelegationToken(key, {
    userId: "user-1",
    appId,
    delegationId: "dlg-1",
    mode: "read",
    channel: "app",
    expiresAtMs,
  });
}

function req(over: { auth?: string; origin?: string | null; path?: string } = {}) {
  const headers: Record<string, string> = {};
  if (over.auth !== undefined) headers.authorization = over.auth;
  if (over.origin !== null) headers["x-starkeep-origin"] = over.origin ?? ORIGIN_SECRET;
  return { headers, rawPath: over.path ?? "/apps/probe/mcp" };
}

describe("origin authorizer", () => {
  it("admits a request that came through CloudFront", async () => {
    expect(await origin(req())).toEqual({ isAuthorized: true });
  });

  it("refuses a request without the header or with a wrong value", async () => {
    expect(await origin(req({ origin: null }))).toEqual({ isAuthorized: false });
    expect(await origin(req({ origin: "s".repeat(42) }))).toEqual({ isAuthorized: false });
    expect(await origin({})).toEqual({ isAuthorized: false });
  });

  it("refuses everything when the deployment has no secret", async () => {
    delete process.env.STARKEEP_ORIGIN_SECRET;
    expect(await origin(req())).toEqual({ isAuthorized: false });
  });
});

describe("delegated authorizer", () => {
  it("admits a valid token on its own app's route, through CloudFront", async () => {
    const res = await delegated(req({ auth: `Bearer ${token()}` }));
    expect(res).toEqual({
      isAuthorized: true,
      context: { userId: "user-1", delegationId: "dlg-1", mode: "read" },
    });
  });

  it("refuses a token for another app", async () => {
    expect((await delegated(req({ auth: `Bearer ${token("photos")}` }))).isAuthorized).toBe(false);
  });

  it("refuses a valid token that did not come through CloudFront", async () => {
    const res = await delegated(req({ auth: `Bearer ${token()}`, origin: null }));
    expect(res.isAuthorized).toBe(false);
  });

  it("refuses an expired token, a missing bearer and garbage", async () => {
    for (const auth of [
      `Bearer ${token("probe", Date.now() - 1)}`,
      undefined,
      "Bearer",
      "Basic abc",
      "Bearer skd_not.a.token",
    ]) {
      expect((await delegated(req({ auth }))).isAuthorized, String(auth)).toBe(false);
    }
  });

  it("refuses everything when the deployment has no public key", async () => {
    delete process.env.STARKEEP_DELEGATION_PUBLIC_KEY;
    expect((await delegated(req({ auth: `Bearer ${token()}` }))).isAuthorized).toBe(false);
  });

  it("reads the app from the path", () => {
    expect(appIdOfPath("/apps/probe/mcp")).toBe("probe");
    expect(appIdOfPath("/apps/probe")).toBe("probe");
    expect(appIdOfPath("/connect")).toBeNull();
    expect(appIdOfPath(undefined)).toBeNull();
  });
});
