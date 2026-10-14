/**
 * The paired-device list, kept in the library's settings file: two real
 * local-data-servers and the fake cloud.
 *
 * Pins what the list is for. An entry written on one desktop reaches the other,
 * so a phone paired from any machine can be revoked from any machine. A change
 * to the list keeps every other setting, and a change to the standards keeps the
 * list. A machine that cannot read the winning settings file refuses to write,
 * because the newest file wins everywhere and a write built on the defaults
 * would erase the person's settings on every node.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import { builtinAppCreds, type InstalledApp } from "./helpers.js";

let cloud: FakeCloud;
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;

interface Device {
  deviceId: string;
  label: string | null;
  appIds: string[];
  pairedAt: string;
}

const phone: Device = {
  deviceId: "dev_pixel-1",
  label: "Pixel 8",
  appIds: ["starkeep-drive"],
  pairedAt: "2026-10-13T12:00:00.000Z",
};

async function syncNow(app: InstalledApp): Promise<{ applied: number; shipped: number }> {
  const res = await app.fetch("/sync/now", { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { applied: number; shipped: number };
}

/** Two consecutive quiet rounds; see `sync-over-wire.test.ts` for why two. */
async function converge(maxRounds = 30): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxRounds; i++) {
    const a = await syncNow(driveA);
    const b = await syncNow(driveB);
    if (a.applied === 0 && a.shipped === 0 && b.applied === 0 && b.shipped === 0) {
      quiet += 1;
      if (quiet >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else {
      quiet = 0;
    }
  }
  throw new Error(`did not converge within ${maxRounds} rounds`);
}

async function listOf(server: LocalDataServer): Promise<{ devices: Device[] | null; problems: string[] }> {
  const res = await fetch(`${server.url}/library/paired-devices`);
  expect(res.status).toBe(200);
  return (await res.json()) as { devices: Device[] | null; problems: string[] };
}

function add(server: LocalDataServer, device: unknown): Promise<Response> {
  return fetch(`${server.url}/library/paired-devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(device),
  });
}

function remove(server: LocalDataServer, deviceId: string): Promise<Response> {
  return fetch(`${server.url}/library/paired-devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

async function standardsOf(server: LocalDataServer): Promise<{ set: boolean; current: { image: { canonicalThreshold: number } } }> {
  const res = await fetch(`${server.url}/library/stand-in-standards`);
  expect(res.status).toBe(200);
  return (await res.json()) as { set: boolean; current: { image: { canonicalThreshold: number } } };
}

function putStandards(server: LocalDataServer, body: unknown): Promise<Response> {
  return fetch(`${server.url}/library/stand-in-standards`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function liveSettingsInCloud(): number {
  const row = cloud.db
    .prepare(`SELECT COUNT(*) AS n FROM shared_records WHERE type = 'starkeep/settings' AND deleted_at IS NULL`)
    .get() as { n: number };
  return row.n;
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  const config = { apiGatewayUrl: cloud.url, pullIntervalMs: 600_000, pushDebounceMs: 50, syncMaxItems: 5 };
  serverA = await startLocalDataServer({ config, auth: { idToken: fakeIdToken() } });
  serverB = await startLocalDataServer({ config, auth: { idToken: fakeIdToken() } });
  driveA = await builtinAppCreds(serverA, "starkeep-drive");
  driveB = await builtinAppCreds(serverB, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await serverA?.stop();
  await serverB?.stop();
  await cloud?.close();
});

describe("the paired-device list", () => {
  it("starts empty, and reading it writes no settings file", async () => {
    expect(await listOf(serverA)).toEqual({ devices: [], problems: [] });
    expect((await standardsOf(serverA)).set).toBe(false);
  });

  it("writes nothing when asked to remove a device it does not hold", async () => {
    // An absent settings file is what tells every host the person has set
    // nothing. Removing nothing must not create one.
    const res = await remove(serverA, "never-paired");
    expect(res.status).toBe(200);
    expect((await standardsOf(serverA)).set).toBe(false);
  });

  it("refuses an entry whose device id could walk an SSM path, and writes nothing", async () => {
    const res = await add(serverA, { ...phone, deviceId: "../app-creds/photos" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { problems: string[] }).problems.join()).toMatch(/deviceId/);
    expect((await standardsOf(serverA)).set).toBe(false);
  });

  it("refuses an entry with no app ids", async () => {
    const res = await add(serverA, { ...phone, appIds: [] });
    expect(res.status).toBe(422);
  });

  it("adds a device, and a second add with the same id replaces it", async () => {
    expect((await add(serverA, phone)).status).toBe(200);
    expect((await listOf(serverA)).devices).toEqual([phone]);
    const relabelled = { ...phone, label: "Old phone" };
    const res = await add(serverA, relabelled);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { devices: Device[] }).devices).toEqual([relabelled]);
    expect((await add(serverA, phone)).status).toBe(200);
  });

  it("keeps the list when the stand-in standards change, and the standards when the list changes", async () => {
    expect((await putStandards(serverA, { standIns: { image: { canonicalThreshold: 6000 } } })).status).toBe(200);
    expect((await listOf(serverA)).devices).toEqual([phone]);

    const second = { ...phone, deviceId: "dev_tablet", label: "Tablet" };
    expect((await add(serverA, second)).status).toBe(200);
    expect((await standardsOf(serverA)).current.image.canonicalThreshold).toBe(6000);
    expect((await listOf(serverA)).devices).toEqual([phone, second]);
  });

  it("reaches the other desktop, which can then revoke a device it never paired", async () => {
    await converge();
    expect((await listOf(serverB)).devices?.map((d) => d.deviceId)).toEqual(["dev_pixel-1", "dev_tablet"]);

    expect((await remove(serverB, "dev_tablet")).status).toBe(200);
    expect((await listOf(serverB)).devices?.map((d) => d.deviceId)).toEqual(["dev_pixel-1"]);
    await converge();
    expect((await listOf(serverA)).devices?.map((d) => d.deviceId)).toEqual(["dev_pixel-1"]);
    // The standards came along untouched through both machines.
    expect((await standardsOf(serverA)).current.image.canonicalThreshold).toBe(6000);
    expect(liveSettingsInCloud()).toBe(1);
  });

  it("refuses to write on a machine that cannot read the winning settings file", async () => {
    // A file exists and its row has reached B, but its bytes have not. B does
    // not know the current settings, so any file it wrote would be built on
    // the defaults and would win everywhere.
    expect((await add(serverA, { ...phone, deviceId: "dev_new" })).status).toBe(200);
    await syncNow(driveA);
    cloud.failures.blobGets = 6;
    await syncNow(driveB);

    const dark = await listOf(serverB);
    expect(dark.devices).toBeNull();
    expect(dark.problems.join()).toMatch(/have not reached this machine/);

    const refused = await add(serverB, { ...phone, deviceId: "dev_from_b" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/cannot read the library's settings/);
    expect((await remove(serverB, "dev_pixel-1")).status).toBe(409);
    // The stand-in save is held to the same rule.
    expect((await putStandards(serverB, { standIns: { image: { canonicalThreshold: 3200 } } })).status).toBe(409);

    cloud.failures.blobGets = 0;
    await converge();
    expect((await listOf(serverB)).devices?.map((d) => d.deviceId)).toEqual(["dev_pixel-1", "dev_new"]);
    expect((await standardsOf(serverB)).current.image.canonicalThreshold).toBe(6000);
  });

  it("serializes concurrent changes, so neither erases the other", async () => {
    const results = await Promise.all([
      add(serverA, { ...phone, deviceId: "dev_c1" }),
      add(serverA, { ...phone, deviceId: "dev_c2" }),
      remove(serverA, "dev_new"),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await listOf(serverA)).devices?.map((d) => d.deviceId)).toEqual(["dev_pixel-1", "dev_c1", "dev_c2"]);
  });
});
