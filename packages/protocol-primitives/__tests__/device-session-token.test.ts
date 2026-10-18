/**
 * A device's credential for the cloud: when it refreshes, when it stops, and
 * where it goes.
 *
 * Three properties matter. A token near expiry is refreshed before it is sent,
 * so a sync pass never spends its window on 401s. Signing out stops the next
 * request rather than the one fifteen minutes later. And the token goes only to
 * the data plane — the same `fetch` downloads from presigned S3 and CloudFront
 * URLs, which have no business seeing a bearer credential.
 */
import { describe, it, expect, vi } from "vitest";
import {
  CognitoError,
  createCloudTokenSource,
  REFRESH_MARGIN_MS,
  SignedOutError,
  USER_TOKEN_HEADER,
  withUserToken,
  type AuthTokens,
  type CognitoClient,
} from "../src/index.js";
import { memorySessionStore } from "./helpers/memory-session-store.js";

const T0 = 1_800_000_000_000;

/** A JWT whose claims segment is the only meaningful part. */
function idTokenExpiringAt(expMs: number, tag: string): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), tag }), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function setup(options: { signedIn?: boolean; lifetimeMs?: number } = {}) {
  let clock = T0;
  let issued = 0;
  const lifetimeMs = options.lifetimeMs ?? 15 * 60_000;
  const refresh = vi.fn(async (refreshToken: string): Promise<AuthTokens> => {
    issued += 1;
    return {
      accessToken: "access",
      idToken: idTokenExpiringAt(clock + lifetimeMs, `id-${issued}`),
      refreshToken,
      expiresIn: lifetimeMs / 1000,
    };
  });
  const client: CognitoClient = {
    refresh,
    signIn: () => Promise.reject(new Error("not used")),
    setNewPassword: () => Promise.reject(new Error("not used")),
    revoke: () => Promise.reject(new Error("not used")),
  };
  const store = memorySessionStore();
  const rejected: string[] = [];
  const tokens = createCloudTokenSource({ client, store, now: () => clock, onRejected: (r) => rejected.push(r) });
  return {
    tokens,
    store,
    refresh,
    rejected,
    advance(ms: number) {
      clock += ms;
    },
    async signIn() {
      await store.write({ refreshToken: "r1", email: "a@example.com" });
    },
  };
}

describe("the token source", () => {
  it("has no token for a device that never signed in, and asks Cognito nothing", async () => {
    const { tokens, refresh } = setup();
    expect(await tokens.current()).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes once, then serves the cached token while it is fresh", async () => {
    const env = setup();
    await env.signIn();

    const first = await env.tokens.current();
    env.advance(5 * 60_000);
    const second = await env.tokens.current();

    expect(first).toBe(second);
    expect(env.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes ahead of expiry rather than sending a token about to lapse", async () => {
    const env = setup();
    await env.signIn();

    const first = await env.tokens.current();
    env.advance(15 * 60_000 - REFRESH_MARGIN_MS + 1);
    const second = await env.tokens.current();

    expect(second).not.toBe(first);
    expect(env.refresh).toHaveBeenCalledTimes(2);
  });

  it("shares one refresh between requests that arrive together", async () => {
    const env = setup();
    await env.signIn();

    const results = await Promise.all([env.tokens.current(), env.tokens.current(), env.tokens.current()]);

    expect(new Set(results).size).toBe(1);
    expect(env.refresh).toHaveBeenCalledTimes(1);
  });

  it("stops at once when the user signs out, not when the cached token expires", async () => {
    const env = setup();
    await env.signIn();
    expect(await env.tokens.current()).not.toBeNull();

    await env.store.clear();

    expect(await env.tokens.current()).toBeNull();
  });

  it("drops the cache when a different sign-in replaces the session", async () => {
    const env = setup();
    await env.signIn();
    const first = await env.tokens.current();

    await env.store.write({ refreshToken: "r2", email: "b@example.com" });
    const second = await env.tokens.current();

    expect(second).not.toBe(first);
    expect(env.refresh).toHaveBeenLastCalledWith("r2");
  });

  it("returns no token when the pool rejects the refresh token, and the session ends", async () => {
    const env = setup();
    await env.signIn();
    env.refresh.mockRejectedValueOnce(new CognitoError("NotAuthorizedException", "revoked", 400));

    expect(await env.tokens.current()).toBeNull();
    expect(await env.store.read()).toBeNull();
    expect(env.rejected).toEqual(["revoked"]);
  });

  it("keeps the session when the pool cannot be reached", async () => {
    const env = setup();
    await env.signIn();
    env.refresh.mockRejectedValueOnce(new TypeError("Network request failed"));

    expect(await env.tokens.current()).toBeNull();
    expect(await env.store.read()).not.toBeNull();
  });
});

describe("the channel fetch", () => {
  const CHANNEL = "https://d111.cloudfront.net/apps/starkeep-drive";

  function recordingFetch() {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("{}");
    });
    return { seen, impl: impl as unknown as typeof fetch };
  }

  it("adds the ID token to data-plane requests and keeps the caller's headers", async () => {
    const env = setup();
    await env.signIn();
    const { seen, impl } = recordingFetch();

    await withUserToken(impl, CHANNEL, env.tokens)(`${CHANNEL}/sync/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(seen[0]!.headers.get(USER_TOKEN_HEADER)).toBe(await env.tokens.current());
    expect(seen[0]!.headers.get("Content-Type")).toBe("application/json");
  });

  it("sends nothing to a presigned URL outside the channel", async () => {
    const env = setup();
    await env.signIn();
    const { seen, impl } = recordingFetch();

    await withUserToken(impl, CHANNEL, env.tokens)("https://bucket.s3.amazonaws.com/shared/x?X-Amz-Signature=abc");

    expect(seen[0]!.headers.get(USER_TOKEN_HEADER)).toBeNull();
    expect(env.refresh).not.toHaveBeenCalled();
  });

  it("refuses a data-plane request with no session, saying why", async () => {
    const env = setup();
    const { impl } = recordingFetch();

    await expect(
      withUserToken(impl, CHANNEL, env.tokens)(`${CHANNEL}/sync/exchange`),
    ).rejects.toBeInstanceOf(SignedOutError);
    expect(impl).not.toHaveBeenCalled();
  });
});
