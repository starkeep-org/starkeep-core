/**
 * Signing this machine in to sync, against the fake cloud and its fake pool.
 *
 * The machine boots with a cloud address and nothing else, as a member's
 * machine does after "Join": no pool ids in its config and no device key. It
 * learns how to sign in from the cloud's `/auth/config`, signs in through the
 * device client — answering the first sign-in's new-password challenge — binds
 * its library to the token's user, and syncs with the token alone.
 *
 * See `~/projects/starkeep/plan-device-sign-in-2026-10-18.md`, phase 3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
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
const CHOSEN = "Chosen-password-2";

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
    env: { STARKEEP_COGNITO_ENDPOINT: cloud.cognitoEndpoint },
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
    const res = await post(
      "/auth/login",
      { email: EMAIL, password: TEMPORARY },
      { Origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(cloud.pool.signIns(EMAIL)).toBe(0);
  });

  it("refuses a wrong password, saying so", async () => {
    const res = await post("/auth/login", { email: EMAIL, password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body["error"]).toMatch(/Incorrect username or password/);
  });

  it("asks for a new password at the first sign-in, then signs in with it", async () => {
    const first = await post("/auth/login", { email: EMAIL, password: TEMPORARY });
    expect(first).toEqual({ status: 200, body: { challenge: "NEW_PASSWORD_REQUIRED" } });

    const second = await post("/auth/login", {
      email: EMAIL,
      password: TEMPORARY,
      newPassword: CHOSEN,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ ok: true, email: EMAIL, userId: FAKE_CLOUD_USER_ID });

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
    const res = await post("/auth/login", {
      email: "other@example.com",
      password: "Other-password-3",
    });
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

  it("signs in again with the chosen password, and the library stays bound to the same user", async () => {
    const res = await post("/auth/login", { email: EMAIL, password: CHOSEN });
    expect(res.status).toBe(200);
    expect(await status()).toMatchObject({ state: "signed-in", libraryUserId: FAKE_CLOUD_USER_ID });
  });
});
