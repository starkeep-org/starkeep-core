/**
 * Signing this machine in to sync, against the fake cloud and its fake pool.
 *
 * The machine boots with a cloud address and nothing else, as a member's
 * machine does after "Join": no pool ids in its config and no device key. It
 * learns how to sign in from the cloud's `/auth/config`, redeems a code from
 * the managed login page for the device client, binds its library to the
 * token's user, and syncs with the token alone. The harness's sign-in, a
 * refresh token from a password sign-in with AWS credentials, takes the same
 * route.
 *
 * See `~/projects/starkeep/plan-device-sign-in-2026-10-18.md`, phase 3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  adminPasswordSignIn,
  FAKE_CLOUD_USER_ID,
  startFakeCloud,
  startLocalDataServer,
  type FakeCloud,
  type LocalDataServer,
} from "@starkeep/testkit";
import {
  builtinAppCreds,
  createRecordWithBytes,
  eventually,
  type InstalledApp,
} from "../helpers.js";

const EMAIL = "member@example.com";
const TEMPORARY = "Temporary-1";
const REDIRECT = "http://localhost:3000/auth/callback";

let cloud: FakeCloud;
let server: LocalDataServer;
let drive: InstalledApp;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * What the managed login page and the callback hand the server: a code bound to
 * a PKCE challenge, and the verifier that answers it.
 */
function pageSignIn(email: string, verifier = randomBytes(32).toString("base64url")) {
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  const code = cloud.pool.issueCode(email, { codeChallenge, redirectUri: REDIRECT });
  return { code, codeVerifier: verifier, redirectUri: REDIRECT };
}

async function status(): Promise<Record<string, unknown>> {
  return (await (await fetch(`${server.url}/auth/status`)).json()) as Record<string, unknown>;
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  // The member's account, as an admin created it: a temporary password the
  // first sign-in must replace.
  cloud.pool.addUser(EMAIL, TEMPORARY, { sub: FAKE_CLOUD_USER_ID, temporary: true });
  cloud.pool.addUser("other@example.com", "Other-password-3", { sub: "someone-else" });
  server = await startLocalDataServer({
    config: { apiGatewayUrl: cloud.url, pullIntervalMs: 600_000, pushDebounceMs: 50 },
    signIn: false,
    env: {
      STARKEEP_COGNITO_ENDPOINT: cloud.cognitoEndpoint,
      STARKEEP_COGNITO_TOKEN_ENDPOINT: cloud.cognitoTokenEndpoint,
    },
  });
  drive = await builtinAppCreds(server, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await cloud?.close();
});

describe("signing this machine in", () => {
  it("starts signed out, with nothing syncing", async () => {
    expect(await status()).toMatchObject({ state: "signed-out", email: null, libraryUserId: null });
  });

  it("refuses a sign-in from a web page, which any site in the browser could send", async () => {
    const res = await post("/auth/login", pageSignIn(EMAIL), { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(cloud.pool.signIns(EMAIL)).toBe(0);
  });

  it("takes no password", async () => {
    const res = await post("/auth/login", { email: EMAIL, password: TEMPORARY });
    expect(res.status).toBe(400);
    expect(cloud.pool.signIns(EMAIL)).toBe(0);
  });

  it("refuses a code with the wrong verifier", async () => {
    const res = await post("/auth/login", { ...pageSignIn(EMAIL), codeVerifier: "not-the-one" });
    expect(res.status).toBe(401);
    expect(res.body["error"]).toMatch(/PKCE/);
    expect(await status()).toMatchObject({ state: "signed-out" });
  });

  it("signs in with a code from the managed login page", async () => {
    const res = await post("/auth/login", pageSignIn(EMAIL));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true, email: EMAIL, userId: FAKE_CLOUD_USER_ID });

    expect(await status()).toMatchObject({
      state: "signed-in",
      email: EMAIL,
      userId: FAKE_CLOUD_USER_ID,
      libraryUserId: FAKE_CLOUD_USER_ID,
    });
  });

  it("keeps the session in a file only its owner can read", async () => {
    const info = await stat(join(server.starkeepDir, "device-session.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("syncs with the token alone", { timeout: 30_000 }, async () => {
    const { record } = await createRecordWithBytes(drive, {
      bytes: "signed-in-bytes",
      fileName: "member.jpg",
    });
    await eventually(async () => {
      const ids = (await cloud.sharedRecords()).map((r) => r.id);
      expect(ids).toContain(record.id);
    });
  });

  it("refuses another account on a library that belongs to this one", async () => {
    const res = await post("/auth/login", pageSignIn("other@example.com"));
    expect(res.status).toBe(409);
    expect(await status()).toMatchObject({ state: "signed-in", email: EMAIL });
  });

  it("signs out locally and at the pool", async () => {
    const res = await post("/auth/sign-out", {});
    expect(res.body).toEqual({ ok: true, revocation: "revoked" });
    expect(cloud.pool.revoked.size).toBeGreaterThan(0);
    expect(await status()).toMatchObject({
      state: "signed-out",
      libraryUserId: FAKE_CLOUD_USER_ID,
    });
  });

  it("refuses a refresh token the pool revoked", async () => {
    const revoked = [...cloud.pool.revoked][0]!;
    const res = await post("/auth/login", { refreshToken: revoked });
    expect(res.status).toBe(401);
    expect(await status()).toMatchObject({ state: "signed-out" });
  });

  it("signs in again with the harness's refresh token, and the library stays bound to the same user", async () => {
    // The page set a permanent password at the first sign-in; the harness
    // signs in with it at the pool, holding AWS credentials.
    const refreshToken = await adminPasswordSignIn(cloud.cognitoEndpoint, {
      email: EMAIL,
      password: TEMPORARY,
    });
    const res = await post("/auth/login", { refreshToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await status()).toMatchObject({ state: "signed-in", libraryUserId: FAKE_CLOUD_USER_ID });
  });
});
