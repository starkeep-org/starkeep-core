/**
 * Device session rules that the other device-session suites leave open: what
 * happens when two sign-outs, sign-ins or refreshes overlap, and what the
 * channel fetch does with a `Request` object.
 *
 * Every `it.fails` here records a suspected bug. See
 * `~/projects/starkeep/review-test-gaps-device-sign-in-multi-user-2026-10-18.md`,
 * section "Unit: the device session rules (protocol-primitives)".
 */
import { describe, it, expect, vi } from "vitest";
import {
  CognitoError,
  refreshSession,
  revokePendingSignOut,
  signOut,
  USER_TOKEN_HEADER,
  withUserToken,
  type AuthTokens,
  type CognitoClient,
  type CloudTokenSource,
} from "../src/index.js";
import { memorySessionStore } from "./helpers/memory-session-store.js";

function idTokenWith(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A pool whose revocations can be switched between offline and reachable. */
function poolWithRevocations() {
  const revoked: string[] = [];
  let online = false;
  const client: CognitoClient = {
    signIn: () => Promise.reject(new Error("not used")),
    setNewPassword: () => Promise.reject(new Error("not used")),
    refresh: () => Promise.reject(new Error("not used")),
    revoke: vi.fn(async (token: string) => {
      if (!online) throw new TypeError("fetch failed");
      revoked.push(token);
    }),
  };
  return {
    client,
    revoked,
    goOnline() {
      online = true;
    },
  };
}

describe("two sign-outs while the pool is unreachable", () => {
  it.fails("revokes both refresh tokens once the pool answers, not only the newer one", async () => {
    // Problem 4: the store has one pending-revocation slot. The second
    // sign-out overwrites the first token, which then stays valid for the ten
    // years a device refresh token lasts.
    const store = memorySessionStore();
    const pool = poolWithRevocations();

    await store.write({ refreshToken: "first", email: "a@example.com" });
    expect(await signOut(pool.client, store, { refreshToken: "first", email: "a@example.com" })).toBe("pending");

    // The person signs in again (the sign-in itself reached the pool), and
    // signs out again while revocation is still failing.
    await store.write({ refreshToken: "second", email: "a@example.com" });
    expect(await signOut(pool.client, store, { refreshToken: "second", email: "a@example.com" })).toBe("pending");

    pool.goOnline();
    await revokePendingSignOut(pool.client, store);
    expect(pool.revoked.sort()).toEqual(["first", "second"]);
  });
});

describe("a refresh that overlaps a sign-out or a sign-in", () => {
  it.fails("does not bring a session back after the person signed out", async () => {
    // Problem 6: refreshSession writes the session back when the refresh
    // learned an email the stored session lacked. A sign-out that landed while
    // the refresh was in flight is undone by that write.
    const store = memorySessionStore();
    await store.write({ refreshToken: "r1", email: null });
    const pending = deferred<AuthTokens>();
    const client: CognitoClient = {
      signIn: () => Promise.reject(new Error("not used")),
      setNewPassword: () => Promise.reject(new Error("not used")),
      refresh: () => pending.promise,
      revoke: async () => undefined,
    };

    const refreshing = refreshSession(client, store, { refreshToken: "r1", email: null, tokens: null });
    expect(await signOut(client, store, { refreshToken: "r1", email: null })).toBe("revoked");
    pending.resolve({
      accessToken: "access",
      idToken: idTokenWith({ sub: "user-1", email: "a@example.com", exp: 4_000_000_000 }),
      refreshToken: "r1",
      expiresIn: 900,
    });
    await refreshing;

    expect(await store.read()).toBeNull();
  });

  it.fails("leaves a newer sign-in alone when the old token's refresh is rejected afterwards", async () => {
    // Problem 6: a rejection clears the store outright. A sign-in that wrote a
    // new session while the old refresh was in flight is wiped with it, and the
    // device reads as signed out right after the person signed in.
    const store = memorySessionStore();
    await store.write({ refreshToken: "old", email: "a@example.com" });
    const pending = deferred<AuthTokens>();
    const client: CognitoClient = {
      signIn: () => Promise.reject(new Error("not used")),
      setNewPassword: () => Promise.reject(new Error("not used")),
      refresh: () => pending.promise,
      revoke: async () => undefined,
    };

    const refreshing = refreshSession(client, store, { refreshToken: "old", email: "a@example.com", tokens: null });
    await store.write({ refreshToken: "new", email: "a@example.com" });
    pending.reject(new CognitoError("NotAuthorizedException", "Refresh Token has been revoked", 400));
    expect((await refreshing).kind).toBe("rejected");

    expect(await store.read()).toEqual({ refreshToken: "new", email: "a@example.com" });
  });
});

describe("the channel fetch with a Request object", () => {
  it.fails("keeps the headers the caller set on the Request, beside the ID token", async () => {
    // Problem 10: the wrapper builds its headers from `init` alone and passes
    // them as `init.headers`, which replaces a Request's own headers.
    const seen: Headers[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init).headers);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const tokens: CloudTokenSource = { current: async () => "id-token" };
    const channel = "https://cloud.example/apps/starkeep-drive";
    const wrapped = withUserToken(fetchImpl, channel, tokens);

    await wrapped(
      new Request(`${channel}/sync/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Starkeep-Trace": "t-1" },
        body: "{}",
      }),
    );

    expect(seen[0]!.get(USER_TOKEN_HEADER)).toBe("id-token");
    expect(seen[0]!.get("X-Starkeep-Trace")).toBe("t-1");
    expect(seen[0]!.get("Content-Type")).toBe("application/json");
  });
});
