/**
 * The shared admin session against the fake pool: a sign-in on the managed
 * login page, credentials minted per action, the idle expiry, sign-out, and a
 * write that must not undo the other tool's sign-out.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFakePool,
  FAKE_DEVICE_CLIENT_ID,
  FAKE_POOL_ID,
  type FakePool,
} from "@starkeep/testkit";

const dir = mkdtempSync(join(tmpdir(), "operator-admin-session-"));
process.env.STARKEEP_DIR = dir;

let pool: FakePool;
let server: Server;
let session: typeof import("../src/admin-session");
let oauth: typeof import("../src/oauth");
let redeem: typeof import("@starkeep/protocol-primitives").redeemAuthorizationCode;
let base = "";

const ADMIN = "admin@example.com";
const MEMBER = "member@example.com";
const REDIRECT = "http://localhost:3000/auth/callback";
const exchange = async () => ({
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: new Date("2030-01-01T00:00:00Z"),
});

beforeAll(async () => {
  pool = createFakePool();
  pool.addUser(ADMIN, "Admin-password-1", { groups: ["starkeep-admins", "starkeep-users"] });
  pool.addUser(MEMBER, "Member-password-1", { groups: ["starkeep-users"] });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const answer =
        req.url === "/oauth2/token"
          ? pool.redeemCode(new URLSearchParams(body))
          : pool.handle(
              String(req.headers["x-amz-target"]).replace("AWSCognitoIdentityProviderService.", ""),
              JSON.parse(body) as Record<string, unknown>,
            );
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.STARKEEP_COGNITO_ENDPOINT = `${base}/cognito/`;
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      userPoolId: FAKE_POOL_ID,
      userPoolClientId: FAKE_DEVICE_CLIENT_ID,
      identityPoolId: "us-east-1:pool",
      stackPrefix: "sk",
      cognitoDomain: "fake-pool.auth.us-east-1.amazoncognito.com",
    }),
  );
  session = await import("../src/admin-session");
  oauth = await import("../src/oauth");
  ({ redeemAuthorizationCode: redeem } = await import("@starkeep/protocol-primitives"));
});

afterAll(() => server.close());

/** A sign-in on the page, as admin-web's callback route completes it. */
async function signIn(email: string, now?: number) {
  const start = oauth.startAuthorization({
    domain: "fake-pool.auth.us-east-1.amazoncognito.com",
    clientId: FAKE_DEVICE_CLIENT_ID,
    redirectUri: REDIRECT,
  });
  const code = pool.issueCode(email, {
    codeChallenge: oauth.pkceChallenge(start.codeVerifier),
    redirectUri: REDIRECT,
  });
  const tokens = await redeem({
    domain: "unused",
    clientId: FAKE_DEVICE_CLIENT_ID,
    code,
    codeVerifier: start.codeVerifier,
    redirectUri: REDIRECT,
    tokenEndpoint: `${base}/oauth2/token`,
  });
  return session.saveAdminSignIn(tokens, now);
}

beforeEach(async () => {
  await session.signOutAdmin();
});

describe("startAuthorization", () => {
  it("sends the hash of a fresh secret to the page, never the secret", () => {
    const start = oauth.startAuthorization({ domain: "d.example.com", clientId: "c", redirectUri: REDIRECT });
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe("https://d.example.com/oauth2/authorize");
    expect(url.searchParams.get("code_challenge")).toBe(oauth.pkceChallenge(start.codeVerifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(start.url).not.toContain(start.codeVerifier);
    expect(oauth.startAuthorization({ domain: "d", clientId: "c", redirectUri: REDIRECT }).state).not.toBe(start.state);
  });
});

describe("the admin session", () => {
  it("is written by a sign-in, readable by its owner only", async () => {
    const status = await signIn(ADMIN);
    expect(status).toMatchObject({ signedIn: true, email: ADMIN });
    expect(statSync(session.adminSessionFile()).mode & 0o777).toBe(0o600);
  });

  it("refuses an account outside the admin group, and revokes its token", async () => {
    const revokedBefore = pool.revoked.size;
    await expect(signIn(MEMBER)).rejects.toThrow(/no admin rights/);
    expect(existsSync(session.adminSessionFile())).toBe(false);
    expect(pool.revoked.size).toBe(revokedBefore + 1);
  });

  it("mints credentials per action and marks the session used", async () => {
    const t0 = Date.parse("2026-11-19T08:00:00Z");
    await signIn(ADMIN, t0);
    const minted = await session.adminCredentials({ now: t0 + 60 * 60_000, exchange });
    expect(minted).toMatchObject({ email: ADMIN, stackPrefix: "sk", region: "us-east-1" });
    expect(minted.stsCredentials.expiration).toBe("2030-01-01T00:00:00.000Z");
    const file = JSON.parse(readFileSync(session.adminSessionFile(), "utf8")) as { lastUsedAt: string };
    expect(file.lastUsedAt).toBe(new Date(t0 + 60 * 60_000).toISOString());
  });

  it("ends after twelve idle hours, revoking the token", async () => {
    const t0 = Date.parse("2026-11-19T08:00:00Z");
    await signIn(ADMIN, t0);
    const token = (JSON.parse(readFileSync(session.adminSessionFile(), "utf8")) as { refreshToken: string }).refreshToken;
    const later = t0 + session.ADMIN_IDLE_EXPIRY_MS + 1;
    expect(session.adminSessionStatus(later).signedIn).toBe(false);
    await expect(session.adminCredentials({ now: later, exchange })).rejects.toBeInstanceOf(
      session.SignInRequired,
    );
    expect(pool.revoked.has(token)).toBe(true);
    expect(existsSync(session.adminSessionFile())).toBe(false);
  });

  it("stays alive while it is used within the idle window", async () => {
    const t0 = Date.parse("2026-11-19T08:00:00Z");
    await signIn(ADMIN, t0);
    await session.adminCredentials({ now: t0 + 11 * 3600_000, exchange });
    await expect(
      session.adminCredentials({ now: t0 + 22 * 3600_000, exchange }),
    ).resolves.toMatchObject({ email: ADMIN });
  });

  it("asks for a sign-in when the pool ended the session", async () => {
    await signIn(ADMIN);
    pool.signOutEverywhere(ADMIN);
    await expect(session.adminCredentials({ exchange })).rejects.toBeInstanceOf(session.SignInRequired);
    expect(existsSync(session.adminSessionFile())).toBe(false);
  });

  it("signs out at the pool and on disk", async () => {
    await signIn(ADMIN);
    const token = (JSON.parse(readFileSync(session.adminSessionFile(), "utf8")) as { refreshToken: string }).refreshToken;
    expect(await session.signOutAdmin()).toEqual({ revoked: true });
    expect(pool.revoked.has(token)).toBe(true);
    expect(session.adminSessionStatus().signedIn).toBe(false);
  });

  it("does not bring back a session the other tool signed out during a refresh", async () => {
    await signIn(ADMIN);
    const slowExchange = async () => {
      // The other tool signs out while this action mints credentials.
      await session.signOutAdmin();
      return exchange();
    };
    await session.adminCredentials({ exchange: slowExchange });
    expect(existsSync(session.adminSessionFile())).toBe(false);
  });

  it("ignores a session from another cloud than config.json names", async () => {
    await signIn(ADMIN);
    const file = JSON.parse(readFileSync(session.adminSessionFile(), "utf8")) as Record<string, unknown>;
    writeFileSync(session.adminSessionFile(), JSON.stringify({ ...file, userPoolId: "us-east-1_Other" }));
    expect(session.adminSessionStatus().signedIn).toBe(false);
    await expect(session.adminCredentials({ exchange })).rejects.toBeInstanceOf(session.SignInRequired);
  });
});

describe("waitForCallback", () => {
  it("resolves with the code when the state matches, after refusing a stray request", async () => {
    const port = 47_000 + Math.floor(Math.random() * 500);
    const wait = oauth.waitForCallback({ state: "s1", port });
    await wait.ready;
    const stray = await fetch(`http://localhost:${port}/callback?code=x&state=wrong`);
    expect(stray.status).toBe(400);
    const good = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=s1`);
    expect(good.status).toBe(200);
    expect(await good.text()).toContain("You can close this tab");
    await expect(wait.done).resolves.toEqual({ code: "the-code" });
  });

  it("rejects with the page's error", async () => {
    const port = 47_500 + Math.floor(Math.random() * 400);
    const wait = oauth.waitForCallback({ state: "s2", port });
    await wait.ready;
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=nope`);
    await expect(wait.done).rejects.toThrow(/nope/);
  });

  it("names a port another program holds", async () => {
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
    const port = (holder.address() as { port: number }).port;
    const wait = oauth.waitForCallback({ state: "s3", port });
    await expect(wait.ready).rejects.toThrow(/in use/);
    await expect(wait.done).rejects.toThrow(/in use/);
    holder.close();
  });
});
