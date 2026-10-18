/**
 * When being offline costs you your session, and when it must not.
 *
 * The bug these exist for: the refresh lived in a `try`/`catch` whose `catch`
 * cleared the stored token, so one launch without a network signed the device
 * out for good — and being signed out is indistinguishable from a revoked
 * token once the credential is gone, so the failure would have looked like
 * Cognito's fault.
 *
 * The distinction the code now makes is *the pool said no* versus *the pool did
 * not answer*, and every case below is one side or the other of that line.
 */
import { describe, it, expect } from "vitest";
import {
  CognitoError,
  loadStoredSession,
  refreshSession,
  revokePendingSignOut,
  sessionFromTokens,
  signOut,
  storeSignIn,
  type ActiveSession,
  type AuthTokens,
  type CognitoClient,
} from "../src/index.js";
import { memorySessionStore } from "./helpers/memory-session-store.js";

/** A JWT whose claims segment is the only meaningful part. */
function idTokenWith(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function tokens(email: string, refreshToken = "r1"): AuthTokens {
  return {
    accessToken: "access",
    idToken: idTokenWith({ email }),
    refreshToken,
    expiresIn: 3600,
  };
}

/** A client whose refresh does whatever the test needs. */
function clientThat(
  refresh: () => Promise<AuthTokens>,
  revoke: (refreshToken: string) => Promise<void> = () => Promise.reject(new Error("not used")),
): CognitoClient {
  return {
    refresh,
    revoke,
    signIn: () => Promise.reject(new Error("not used")),
    setNewPassword: () => Promise.reject(new Error("not used")),
  };
}

function storeWith(session?: { refreshToken: string; email: string | null }) {
  const store = memorySessionStore();
  return {
    store,
    async seed() {
      if (session) await store.write(session);
      return store;
    },
  };
}

describe("loading what is on the device", () => {
  it("returns no session when nothing was ever stored", async () => {
    const { store } = storeWith();
    expect(await loadStoredSession(store)).toBeNull();
  });

  it("returns a token-less session without touching the network", async () => {
    // The local-first property: no client is involved in this call at all, so
    // there is nothing here that a dead network could delay or fail.
    const { store, seed } = storeWith({ refreshToken: "r1", email: "a@example.com" });
    await seed();

    expect(await loadStoredSession(store)).toEqual({
      refreshToken: "r1",
      email: "a@example.com",
      tokens: null,
    });
  });
});

describe("refreshing a stored session", () => {
  it("goes live when the pool answers", async () => {
    const { store, seed } = storeWith({ refreshToken: "r1", email: null });
    await seed();
    const session = (await loadStoredSession(store))!;

    const outcome = await refreshSession(
      clientThat(async () => tokens("a@example.com")),
      store,
      session,
    );

    expect(outcome.kind).toBe("live");
    expect(outcome.kind === "live" && outcome.session.tokens?.accessToken).toBe("access");
  });

  it("learns the email a stored session did not have", async () => {
    const { store, seed } = storeWith({ refreshToken: "r1", email: null });
    await seed();
    const session = (await loadStoredSession(store))!;

    await refreshSession(clientThat(async () => tokens("a@example.com")), store, session);

    expect(await store.read()).toEqual({ refreshToken: "r1", email: "a@example.com" });
  });

  it("KEEPS the session when the network is gone", async () => {
    // The regression. `fetch` throwing is a phone in a lift, not a revoked
    // credential, and the refresh token must still be there afterwards.
    const { store, seed } = storeWith({ refreshToken: "r1", email: "a@example.com" });
    await seed();
    const session = (await loadStoredSession(store))!;

    const outcome = await refreshSession(
      clientThat(() => Promise.reject(new TypeError("Network request failed"))),
      store,
      session,
    );

    expect(outcome.kind).toBe("offline");
    expect(await store.read()).toEqual({ refreshToken: "r1", email: "a@example.com" });
  });

  it("keeps the session when Cognito itself is failing", async () => {
    // A 5xx is not the pool rejecting this credential — it is the pool being
    // unable to answer, which is the network case wearing a status code.
    const { store, seed } = storeWith({ refreshToken: "r1", email: "a@example.com" });
    await seed();
    const session = (await loadStoredSession(store))!;

    const outcome = await refreshSession(
      clientThat(() => Promise.reject(new CognitoError("InternalErrorException", "boom", 500))),
      store,
      session,
    );

    expect(outcome.kind).toBe("offline");
    expect(await store.read()).not.toBeNull();
  });

  it("keeps the session when the response could not be understood", async () => {
    // Raised by this client rather than by Cognito, so it carries status 0 and
    // must not be read as a rejection: a reply we failed to parse is no
    // evidence about the credential.
    const { store, seed } = storeWith({ refreshToken: "r1", email: "a@example.com" });
    await seed();
    const session = (await loadStoredSession(store))!;

    const outcome = await refreshSession(
      clientThat(() =>
        Promise.reject(new CognitoError("IncompleteAuthResult", "incomplete session")),
      ),
      store,
      session,
    );

    expect(outcome.kind).toBe("offline");
    expect(await store.read()).not.toBeNull();
  });

  it("ends the session only when the pool rejects the token", async () => {
    const { store, seed } = storeWith({ refreshToken: "r1", email: "a@example.com" });
    await seed();
    const session = (await loadStoredSession(store))!;

    const outcome = await refreshSession(
      clientThat(() =>
        Promise.reject(new CognitoError("NotAuthorizedException", "Refresh Token has expired", 400)),
      ),
      store,
      session,
    );

    expect(outcome.kind).toBe("rejected");
    expect(await store.read()).toBeNull();
  });

  it("survives a refresh that fails and then succeeds", async () => {
    // What a train journey looks like: offline at launch, live once there is
    // signal, with nothing lost in between and no sign-in in the middle.
    const { store, seed } = storeWith({ refreshToken: "r1", email: "a@example.com" });
    await seed();
    let offline = true;
    const client = clientThat(async () => {
      if (offline) throw new TypeError("Network request failed");
      return tokens("a@example.com");
    });

    let session: ActiveSession = (await loadStoredSession(store))!;
    expect((await refreshSession(client, store, session)).kind).toBe("offline");

    offline = false;
    const second = await refreshSession(client, store, session);
    expect(second.kind).toBe("live");
    if (second.kind === "live") session = second.session;
    expect(session.tokens).not.toBeNull();
  });
});

describe("sessionFromTokens", () => {
  it("takes the email from the id token", () => {
    expect(sessionFromTokens(tokens("a@example.com"))).toEqual({
      email: "a@example.com",
      refreshToken: "r1",
      tokens: tokens("a@example.com"),
    });
  });

  it("keeps a completed sign-in without its ID token", async () => {
    const store = memorySessionStore();
    await storeSignIn(store, tokens("a@example.com"));
    expect(await store.read()).toEqual({ refreshToken: "r1", email: "a@example.com" });
  });
});

describe("signing out", () => {
  const notRefreshing = () => Promise.reject(new Error("not used"));
  const live = (refreshToken: string): ActiveSession => ({ email: "a@example.com", refreshToken, tokens: null });

  it("revokes this sign-in at the pool and leaves nothing behind", async () => {
    const revoked: string[] = [];
    const client = clientThat(notRefreshing, async (t) => {
      revoked.push(t);
    });
    const store = await storeWith({ refreshToken: "r1", email: "a@example.com" }).seed();

    expect(await signOut(client, store, live("r1"))).toBe("revoked");

    expect(revoked).toEqual(["r1"]);
    expect(await store.read()).toBeNull();
    expect(await store.readPendingRevocation()).toBeNull();
  });

  it("signs out locally without a network, and keeps the token to revoke later", async () => {
    const client = clientThat(notRefreshing, () => Promise.reject(new TypeError("Network request failed")));
    const store = await storeWith({ refreshToken: "r1", email: "a@example.com" }).seed();

    expect(await signOut(client, store, live("r1"))).toBe("pending");

    expect(await store.read()).toBeNull();
    expect(await store.readPendingRevocation()).toBe("r1");
  });

  it("finishes the revocation on a later launch with a network", async () => {
    const revoked: string[] = [];
    const store = await storeWith().seed();
    await store.writePendingRevocation("r1");

    const outcome = await revokePendingSignOut(
      clientThat(notRefreshing, async (t) => {
        revoked.push(t);
      }),
      store,
    );

    expect(outcome).toBe("revoked");
    expect(revoked).toEqual(["r1"]);
    expect(await store.readPendingRevocation()).toBeNull();
  });

  it("drops a pending token the pool refuses, since a refused token is already unusable", async () => {
    const store = await storeWith().seed();
    await store.writePendingRevocation("r1");
    const client = clientThat(notRefreshing, () =>
      Promise.reject(new CognitoError("UnauthorizedException", "token already revoked", 400)),
    );

    expect(await revokePendingSignOut(client, store)).toBe("revoked");
    expect(await store.readPendingRevocation()).toBeNull();
  });

  it("keeps a pending token through a server error", async () => {
    const store = await storeWith().seed();
    await store.writePendingRevocation("r1");
    const client = clientThat(notRefreshing, () =>
      Promise.reject(new CognitoError("InternalErrorException", "try again", 500)),
    );

    expect(await revokePendingSignOut(client, store)).toBe("pending");
    expect(await store.readPendingRevocation()).toBe("r1");
  });

  it("does nothing at launch when no sign-out is waiting", async () => {
    const store = await storeWith().seed();
    expect(await revokePendingSignOut(clientThat(notRefreshing), store)).toBe("none");
  });

  it("leaves a newer sign-in's session alone while finishing an old revocation", async () => {
    const store = await storeWith({ refreshToken: "r2", email: "a@example.com" }).seed();
    await store.writePendingRevocation("r1");

    await revokePendingSignOut(clientThat(notRefreshing, async () => {}), store);

    expect(await store.read()).toEqual({ refreshToken: "r2", email: "a@example.com" });
  });
});
