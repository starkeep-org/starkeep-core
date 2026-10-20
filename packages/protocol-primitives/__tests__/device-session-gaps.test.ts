/**
 * Device session rules that the other device-session suites leave open: what
 * happens when two sign-outs, sign-ins or refreshes overlap, where a waiting
 * revocation goes after a move to another pool, and what the channel fetch
 * does with a `Request` object.
 *
 * Each case started as an `it.fails` in the 2026-10-18 test-gap review. See
 * `~/projects/starkeep/assessment-failing-tests-device-sign-in-2026-10-18.md`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  CognitoError,
  createCloudTokenSource,
  endReplacedSession,
  refreshSession,
  revokePendingSignOut,
  signOut,
  storeSignIn,
  USER_TOKEN_HEADER,
  withUserToken,
  type AuthTokens,
  type CognitoClient,
  type CloudTokenSource,
  type DeviceAuthConfig,
} from "../src/index.js";
import { memorySessionStore } from "./helpers/memory-session-store.js";

function idTokenWith(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function tokensFor(refreshToken: string, sub = "user-1"): AuthTokens {
  return {
    accessToken: "access",
    idToken: idTokenWith({ sub, email: "a@example.com", exp: 4_000_000_000 }),
    refreshToken,
    expiresIn: 900,
  };
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

const POOL_X: DeviceAuthConfig = {
  region: "us-east-2",
  userPoolId: "us-east-2_PoolX",
  deviceClientId: "clientX",
};
const POOL_Y: DeviceAuthConfig = {
  region: "us-west-2",
  userPoolId: "us-west-2_PoolY",
  deviceClientId: "clientY",
};

/**
 * Pools that can each go out of reach. Each revokes only tokens it issued, as
 * Cognito does, and refuses any other with a 4xx.
 */
function pools() {
  const state = new Map<string, { issued: Set<string>; revoked: string[]; online: boolean }>();
  for (const auth of [POOL_X, POOL_Y])
    state.set(auth.userPoolId, { issued: new Set(), revoked: [], online: true });
  const clientFor = (auth: DeviceAuthConfig): CognitoClient => {
    const pool = state.get(auth.userPoolId)!;
    return {
      signIn: () => Promise.reject(new Error("not used")),
      setNewPassword: () => Promise.reject(new Error("not used")),
      refresh: () => Promise.reject(new Error("not used")),
      revoke: vi.fn(async (token: string) => {
        if (!pool.online) throw new TypeError("fetch failed");
        if (!pool.issued.has(token))
          throw new CognitoError("UnauthorizedException", "Invalid token", 400);
        pool.revoked.push(token);
      }),
    };
  };
  return {
    clientFor,
    pool: (auth: DeviceAuthConfig) => state.get(auth.userPoolId)!,
    /** A token the pool has issued, as a completed sign-in leaves it. */
    issue(auth: DeviceAuthConfig, token: string) {
      state.get(auth.userPoolId)!.issued.add(token);
      return tokensFor(token);
    },
  };
}

describe("two sign-outs while the pool is unreachable", () => {
  it("revokes both refresh tokens once the pool answers, with a sign-in between them", async () => {
    // Two sign-outs always have a sign-in between them, and the sign-in
    // reaches the pool. The sign-in finishes the first sign-out, so the second
    // one finds the slot empty.
    const store = memorySessionStore();
    const world = pools();
    const x = world.pool(POOL_X);

    await storeSignIn(store, world.issue(POOL_X, "first"));
    x.online = false;
    expect(await signOut(world.clientFor, store, (await store.read())!, POOL_X)).toBe("pending");

    x.online = true;
    const second = world.issue(POOL_X, "second");
    await endReplacedSession(world.clientFor, store, null);
    await storeSignIn(store, second);
    expect(x.revoked).toEqual(["first"]);

    x.online = false;
    expect(await signOut(world.clientFor, store, (await store.read())!, POOL_X)).toBe("pending");
    x.online = true;
    await revokePendingSignOut(world.clientFor, store);
    expect(x.revoked).toEqual(["first", "second"]);
  });
});

describe("a waiting revocation after a move to another pool", () => {
  it("goes to the pool that issued the token, not the pool the device uses now", async () => {
    const store = memorySessionStore();
    const world = pools();
    const x = world.pool(POOL_X);

    await storeSignIn(store, world.issue(POOL_X, "x-token"));
    x.online = false;
    // Signing in at Y replaces the X session. X is out of reach, so the X
    // token waits.
    const yTokens = world.issue(POOL_Y, "y-token");
    await endReplacedSession(world.clientFor, store, POOL_X);
    await storeSignIn(store, yTokens);
    expect(await store.readPendingRevocation()).toEqual({ refreshToken: "x-token", auth: POOL_X });

    x.online = true;
    expect(await revokePendingSignOut(world.clientFor, store)).toBe("revoked");
    expect(x.revoked).toEqual(["x-token"]);
    expect(world.pool(POOL_Y).revoked).toEqual([]);
  });

  it("finishes a waiting sign-out at the next sign-in, before the new session is kept", async () => {
    const store = memorySessionStore();
    const world = pools();
    const x = world.pool(POOL_X);

    await storeSignIn(store, world.issue(POOL_X, "old"));
    x.online = false;
    await signOut(world.clientFor, store, (await store.read())!, POOL_X);
    x.online = true;

    await endReplacedSession(world.clientFor, store, null);

    expect(x.revoked).toEqual(["old"]);
    expect(await store.readPendingRevocation()).toBeNull();
  });
});

describe("a refresh that overlaps a sign-out or a sign-in", () => {
  it("does not bring a session back after the person signed out", async () => {
    // refreshSession writes the session back when the refresh learned an email
    // the stored session lacked. The write must not undo a sign-out that landed
    // while the refresh was in flight.
    const store = memorySessionStore();
    await store.write({ refreshToken: "r1", email: null });
    const pending = deferred<AuthTokens>();
    const client: CognitoClient = {
      signIn: () => Promise.reject(new Error("not used")),
      setNewPassword: () => Promise.reject(new Error("not used")),
      refresh: () => pending.promise,
      revoke: async () => undefined,
    };

    const refreshing = refreshSession(client, store, {
      refreshToken: "r1",
      email: null,
      tokens: null,
    });
    expect(await signOut(() => client, store, { refreshToken: "r1", email: null }, POOL_X)).toBe(
      "revoked",
    );
    pending.resolve(tokensFor("r1"));
    expect((await refreshing).kind).toBe("superseded");

    expect(await store.read()).toBeNull();
  });

  it("leaves a newer sign-in alone when the old token's refresh is rejected afterwards", async () => {
    // A rejection is about the token that was refreshed. A sign-in that wrote
    // a new session while the old refresh was in flight keeps its session.
    const store = memorySessionStore();
    await store.write({ refreshToken: "old", email: "a@example.com" });
    const pending = deferred<AuthTokens>();
    const client: CognitoClient = {
      signIn: () => Promise.reject(new Error("not used")),
      setNewPassword: () => Promise.reject(new Error("not used")),
      refresh: () => pending.promise,
      revoke: async () => undefined,
    };

    const refreshing = refreshSession(client, store, {
      refreshToken: "old",
      email: "a@example.com",
      tokens: null,
    });
    await store.write({ refreshToken: "new", email: "a@example.com" });
    pending.reject(
      new CognitoError("NotAuthorizedException", "Refresh Token has been revoked", 400),
    );
    expect((await refreshing).kind).toBe("superseded");

    expect(await store.read()).toEqual({ refreshToken: "new", email: "a@example.com" });
  });

  it("hands out the newer sign-in's token, and reports no rejection, when the old refresh loses the race", async () => {
    const store = memorySessionStore();
    await store.write({ refreshToken: "old", email: "a@example.com" });
    const first = deferred<AuthTokens>();
    const oldInFlight = deferred<void>();
    const refreshed: string[] = [];
    const client: CognitoClient = {
      signIn: () => Promise.reject(new Error("not used")),
      setNewPassword: () => Promise.reject(new Error("not used")),
      refresh: (token) => {
        refreshed.push(token);
        if (token !== "old") return Promise.resolve(tokensFor("new", "user-2"));
        oldInFlight.resolve();
        return first.promise;
      },
      revoke: async () => undefined,
    };
    const onRejected = vi.fn();
    const source = createCloudTokenSource({ client, store, onRejected });

    const asked = source.current();
    await oldInFlight.promise;
    await store.write({ refreshToken: "new", email: "a@example.com" });
    first.reject(new CognitoError("NotAuthorizedException", "Refresh Token has been revoked", 400));

    expect(await asked).toBe(tokensFor("new", "user-2").idToken);
    expect(refreshed).toEqual(["old", "new"]);
    expect(onRejected).not.toHaveBeenCalled();
  });
});

describe("the channel fetch with a Request object", () => {
  it("keeps the headers the caller set on the Request, beside the ID token", async () => {
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

  it("lets init's headers override the Request's, as fetch does", async () => {
    const seen: Headers[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init).headers);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const channel = "https://cloud.example/apps/starkeep-drive";
    const wrapped = withUserToken(fetchImpl, channel, { current: async () => "id-token" });

    await wrapped(
      new Request(`${channel}/data/types`, { headers: { "X-Starkeep-Trace": "from-request" } }),
      {
        headers: { "X-Starkeep-Trace": "from-init" },
      },
    );

    expect(seen[0]!.get("X-Starkeep-Trace")).toBe("from-init");
  });
});
