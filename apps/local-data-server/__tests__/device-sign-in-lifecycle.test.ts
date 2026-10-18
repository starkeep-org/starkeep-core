/**
 * A machine's sign-in over its life, against the fake cloud and its fake pool:
 * data written before the first sign-in, sign-out and sign-in again, a session
 * the pool ends, a start with the pool out of reach, and the move from a paired
 * key to a sign-in.
 *
 * `device-sign-in.test.ts` covers the first sign-in itself. Every `it.fails`
 * here records a suspected bug. See
 * `~/projects/starkeep/review-test-gaps-device-sign-in-multi-user-2026-10-18.md`,
 * section "Tier 2: a local data server against the fake cloud".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FAKE_CLOUD_USER_ID,
  startFakeCloud,
  startLocalDataServer,
  type FakeCloud,
  type LocalDataServer,
} from "@starkeep/testkit";
import { builtinAppCreds, createRecordWithBytes, eventually, type InstalledApp } from "./helpers.js";

const EMAIL = "member@example.com";
const PASSWORD = "Member-password-1";

async function post(server: LocalDataServer, path: string, body: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function status(server: LocalDataServer): Promise<Record<string, unknown>> {
  return (await (await fetch(`${server.url}/auth/status`)).json()) as Record<string, unknown>;
}

async function storedRefreshToken(server: LocalDataServer): Promise<string | null> {
  const file = JSON.parse(await readFile(join(server.starkeepDir, "device-session.json"), "utf8")) as {
    session: { refreshToken: string } | null;
  };
  return file.session?.refreshToken ?? null;
}

async function cloudIds(cloud: FakeCloud): Promise<string[]> {
  return (await cloud.sharedRecords()).map((r) => r.id);
}

/** Give a sync that should not happen every chance to happen, then look. */
async function settle(app: InstalledApp): Promise<void> {
  await app.fetch("/sync/now", { method: "POST" });
  await new Promise((r) => setTimeout(r, 1_500));
}

/** A machine that joined `cloud` by address, as a member's does: no pool ids, no key. */
function joinedMachine(cloud: FakeCloud, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  return startLocalDataServer({
    config: { apiGatewayUrl: cloud.url, pullIntervalMs: 600_000, pushDebounceMs: 50, ...extra },
    deviceKey: false,
    env: { STARKEEP_COGNITO_ENDPOINT: cloud.cognitoEndpoint, ...env },
  });
}

describe("a machine that has not joined a cloud", () => {
  let server: LocalDataServer;
  beforeAll(async () => {
    server = await startLocalDataServer({ config: {}, deviceKey: false });
  }, 60_000);
  afterAll(async () => server?.stop());

  it("says to join a cloud first, rather than failing somewhere later", async () => {
    const res = await post(server, "/auth/login", { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(503);
    expect(res.body["error"]).toMatch(/Join a cloud first/);
  });
});

describe("one machine's sign-in, from first sign-in to a session the pool ends", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let drive: InstalledApp;
  let whileSignedOut: string;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    cloud.pool.addUser(EMAIL, PASSWORD, { sub: FAKE_CLOUD_USER_ID });
    server = await joinedMachine(cloud);
    drive = await builtinAppCreds(server, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
    // The restart below hands the dir back in, and the harness deletes only
    // dirs it made itself.
    if (server) await rm(server.starkeepDir, { recursive: true, force: true });
  });

  it("carries what was written before the first sign-in to the cloud, under the user's segment", { timeout: 30_000 }, async () => {
    // Local-first: the person used the machine before signing in. Those
    // records live under the `local` segment until the library binds.
    const { record } = await createRecordWithBytes(drive, { bytes: "before-sign-in", fileName: "early.jpg" });
    await settle(drive);
    expect(await cloudIds(cloud)).not.toContain(record.id);

    const res = await post(server, "/auth/login", { email: EMAIL, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await eventually(async () => {
      const synced = (await cloud.sharedRecords()).find((r) => r.id === record.id);
      expect(synced, "the early record has not reached the cloud").toBeDefined();
      expect(synced!.objectStorageKey).toMatch(new RegExp(`^shared/${FAKE_CLOUD_USER_ID}/`));
    }, { timeoutMs: 20_000 });
  });

  it("reads the cloud for the Drive UI with the device token alone", async () => {
    const res = await drive.fetch("/cloud/data/types");
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("replaces the session on a second sign-in, and revokes the old refresh token at the pool", async () => {
    const before = await storedRefreshToken(server);
    expect(before).toBeTruthy();

    const res = await post(server, "/auth/login", { email: EMAIL, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await storedRefreshToken(server);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    await eventually(() => expect(cloud.pool.revoked.has(before!)).toBe(true));
  });

  it("stops syncing once signed out: a new record stays on the machine", { timeout: 30_000 }, async () => {
    const res = await post(server, "/auth/sign-out", {});
    expect(res.status).toBe(200);

    const { record } = await createRecordWithBytes(drive, { bytes: "while-signed-out", fileName: "later.jpg" });
    whileSignedOut = record.id;
    await settle(drive);
    expect(await cloudIds(cloud)).not.toContain(whileSignedOut);
  });

  it("resumes sync on the next sign-in, and carries what was written meanwhile", { timeout: 30_000 }, async () => {
    const res = await post(server, "/auth/login", { email: EMAIL, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await eventually(async () => {
      await drive.fetch("/sync/now", { method: "POST" });
      expect(await cloudIds(cloud)).toContain(whileSignedOut);
    }, { timeoutMs: 20_000 });
  });

  it("shows signed out after a restart once the pool ended the session, and syncs nothing", { timeout: 60_000 }, async () => {
    // An admin signed the person out everywhere, or disabled the account. The
    // machine learns of it the next time it asks the pool for a token; a
    // restart asks at once.
    cloud.pool.signOutEverywhere(EMAIL);
    await server.stopKeepData();
    server = await startLocalDataServer({
      starkeepDir: server.starkeepDir,
      deviceKey: false,
      env: { STARKEEP_COGNITO_ENDPOINT: cloud.cognitoEndpoint },
    });
    drive = await builtinAppCreds(server, "starkeep-drive");

    await eventually(async () => expect(await status(server)).toMatchObject({ state: "signed-out" }), {
      timeoutMs: 20_000,
    });
    // The library stays bound to its user.
    expect(await status(server)).toMatchObject({ libraryUserId: FAKE_CLOUD_USER_ID });

    const { record } = await createRecordWithBytes(drive, { bytes: "after-pool-ended", fileName: "ended.jpg" });
    await settle(drive);
    expect(await cloudIds(cloud)).not.toContain(record.id);
  });
});

describe("a signed-in machine that starts while the pool is out of reach", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    cloud.pool.addUser(EMAIL, PASSWORD, { sub: FAKE_CLOUD_USER_ID });
    server = await joinedMachine(cloud);
    await builtinAppCreds(server, "starkeep-drive");
    const res = await post(server, "/auth/login", { email: EMAIL, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
    if (server) await rm(server.starkeepDir, { recursive: true, force: true });
  });

  it("stays signed in and keeps its session, rather than signing itself out", { timeout: 60_000 }, async () => {
    const token = await storedRefreshToken(server);
    await server.stopKeepData();
    // Nothing listens on port 9: every call to the pool fails to connect.
    server = await startLocalDataServer({
      starkeepDir: server.starkeepDir,
      deviceKey: false,
      env: { STARKEEP_COGNITO_ENDPOINT: "http://127.0.0.1:9/" },
    });

    await eventually(async () =>
      expect(await status(server)).toMatchObject({
        state: "signed-in",
        email: EMAIL,
        libraryUserId: FAKE_CLOUD_USER_ID,
      }),
    );
    expect(await storedRefreshToken(server)).toBe(token);
  });
});

describe("a machine that joined a different cloud than the one its config names", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    cloud.pool.addUser(EMAIL, PASSWORD, { sub: FAKE_CLOUD_USER_ID });
    // The operator's own cloud left its pool ids behind; "Join" changed only
    // the address.
    server = await joinedMachine(cloud, {
      userPoolId: "us-east-1_OldPool99",
      deviceUserPoolClientId: "oldcloudclient000000000001",
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it.fails("signs in to the pool of the cloud it joined", async () => {
    // Problem 8: the sign-in prefers the config file's pool ids over the
    // joined cloud's `/auth/config`.
    const res = await post(server, "/auth/login", { email: EMAIL, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe("an account with no data library", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    // An admin without data: in `starkeep-admins`, not in `starkeep-users`.
    cloud.pool.addUser(EMAIL, PASSWORD, { sub: FAKE_CLOUD_USER_ID, groups: ["starkeep-admins"] });
    server = await joinedMachine(cloud);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it.fails("is refused at sign-in, before the library is bound to it", async () => {
    // Problem 9: the sign-in binds the library to any account the pool
    // accepts. The cloud then refuses every sync call for an account outside
    // `starkeep-users`, and the library stays bound to that account for good.
    const res = await post(server, "/auth/login", { email: EMAIL, password: PASSWORD });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await status(server)).toMatchObject({ libraryUserId: null });
  });
});

describe("a paired machine that signs in as the same user", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let drive: InstalledApp;
  let pairedRecord: string;

  beforeAll(async () => {
    // The fake cloud approves the machine's key for its one user, as an admin
    // would have before sign-in existed.
    cloud = await startFakeCloud();
    cloud.pool.addUser(EMAIL, PASSWORD, { sub: FAKE_CLOUD_USER_ID });
    server = await startLocalDataServer({
      config: { apiGatewayUrl: cloud.url, pullIntervalMs: 600_000, pushDebounceMs: 50 },
      env: { STARKEEP_COGNITO_ENDPOINT: cloud.cognitoEndpoint },
    });
    drive = await builtinAppCreds(server, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it("syncs with its paired key before the sign-in", { timeout: 30_000 }, async () => {
    const { record } = await createRecordWithBytes(drive, { bytes: "paired-bytes", fileName: "paired.jpg" });
    pairedRecord = record.id;
    await eventually(async () => {
      await drive.fetch("/sync/now", { method: "POST" });
      expect(await cloudIds(cloud)).toContain(pairedRecord);
    }, { timeoutMs: 20_000 });
  });

  it("keeps syncing after the sign-in, and uploads nothing it already sent", { timeout: 30_000 }, async () => {
    const res = await post(server, "/auth/login", { email: EMAIL, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await status(server)).toMatchObject({ state: "signed-in", libraryUserId: FAKE_CLOUD_USER_ID });

    cloud.clearExchangeLog();
    const { record } = await createRecordWithBytes(drive, { bytes: "signed-in-bytes", fileName: "after.jpg" });
    await eventually(async () => {
      await drive.fetch("/sync/now", { method: "POST" });
      expect(await cloudIds(cloud)).toContain(record.id);
    }, { timeoutMs: 20_000 });

    const shipped = cloud.exchangeLog
      .filter((e) => e.appId === "starkeep-drive")
      .reduce((sum, e) => sum + e.inRecords, 0);
    expect(shipped).toBe(1);
  });
});
