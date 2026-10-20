/**
 * The deployment's settings, across the wire: real local data servers and the
 * fake cloud.
 *
 * Pins what only a round trip shows: a value set in the cloud reaches every
 * node through the Drive channel's settings route, a node with no cloud keeps
 * the value in its own config, and each branch of the stamping rule holds — a
 * node that knows the value stamps, one that does not leaves the stamp to the
 * cloud, and the cloud's stamp comes back in the same exchange.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import { builtinAppCreds, registerWithBytes, type InstalledApp } from "../helpers.js";

const BIG = 2 * 1024 * 1024;

let cloud: FakeCloud;
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;
const cloudConfig = () => ({
  apiGatewayUrl: cloud.url,
  pullIntervalMs: 600_000,
  pushDebounceMs: 50,
  syncMaxItems: 5,
});

async function syncNow(app: InstalledApp): Promise<{ applied: number; shipped: number }> {
  const res = await app.fetch("/sync/now", { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { applied: number; shipped: number };
}

interface SettingsView {
  current: Record<"image" | "video", { canonicalThreshold: number; advisoryLongEdges: unknown }>;
  defaults: Record<"image" | "video", { canonicalThreshold: number }>;
  set: boolean;
  problems: string[];
  knowsLibraryValue: boolean;
}

async function settingsOf(server: LocalDataServer): Promise<SettingsView> {
  const res = await fetch(`${server.url}/library/stand-in-standards`);
  expect(res.status).toBe(200);
  return (await res.json()) as SettingsView;
}

async function putSettings(server: LocalDataServer, body: unknown): Promise<Response> {
  return fetch(`${server.url}/library/deployment-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Read the document again now, as admin-web asks after writing the parameter. */
async function refresh(server: LocalDataServer): Promise<void> {
  const res = await fetch(`${server.url}/library/deployment-settings/refresh`, { method: "POST" });
  expect(res.status).toBe(200);
}

async function record(app: InstalledApp, id: string): Promise<Record<string, unknown>> {
  const res = await app.fetch(`/data/records/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { record: Record<string, unknown> }).record;
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  serverA = await startLocalDataServer({ config: cloudConfig() });
  serverB = await startLocalDataServer({ config: cloudConfig() });
  driveA = await builtinAppCreds(serverA, "starkeep-drive");
  driveB = await builtinAppCreds(serverB, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await serverA?.stop();
  await serverB?.stop();
  await cloud?.close();
});

describe("the deployment's settings on a node with a cloud", () => {
  it("start at the defaults, unset, and known", async () => {
    // No document is set, so the defaults are the value and this node knows
    // it. A node that treated an untouched deployment as unknown could stamp
    // nothing, so no app could derive a stand-in until the cloud answered.
    const view = await settingsOf(serverA);
    expect(view).toMatchObject({ set: false, knowsLibraryValue: true, problems: [] });
    expect(view.current).toEqual(view.defaults);
  });

  it("stamp with the defaults, with no cloud round, while no document is set", async () => {
    const { body } = await registerWithBytes(driveA, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fidelity: 6000,
      fileName: "before-any-setting.jpg",
    });
    expect((await record(driveA, body.record!.id)).canonical_threshold).toBe(4272);
  });

  it("refuse a local write, because the document lives in the cloud", async () => {
    const res = await putSettings(serverA, { standIns: { image: { canonicalThreshold: 5120 } } });
    expect(res.status).toBe(409);
    expect((await settingsOf(serverA)).set).toBe(false);
  });

  it("carry a value set in the cloud to every node, which then stamps with it", async () => {
    cloud.setDeploymentSettings({
      standIns: {
        image: { canonicalThreshold: 6000 },
        video: { advisoryLongEdges: { bySize: { "2000": 960 } } },
      },
    });
    await refresh(serverA);
    await refresh(serverB);
    for (const server of [serverA, serverB]) {
      const view = await settingsOf(server);
      expect(view).toMatchObject({ set: true, knowsLibraryValue: true, problems: [] });
      expect(view.current.image.canonicalThreshold).toBe(6000);
      expect(view.current.video.advisoryLongEdges).toEqual({
        canonical: 1920,
        bySize: { 2000: 960 },
      });
    }
    const { body } = await registerWithBytes(driveB, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fidelity: 8000,
      fileName: "after-the-setting.jpg",
    });
    expect((await record(driveB, body.record!.id)).canonical_threshold).toBe(6000);
  });

  it("leave an original stamped earlier as it was", async () => {
    const where = encodeURIComponent(
      JSON.stringify({ original_filename: "before-any-setting.jpg" }),
    );
    const res = await driveA.fetch(`/data/records?where=${where}`);
    const [earlier] = ((await res.json()) as { records: Array<Record<string, unknown>> }).records;
    expect(earlier!.canonical_threshold).toBe(4272);
  });

  it("keep the last value through a failed read", async () => {
    cloud.failures.deploymentSettings = true;
    await refresh(serverA);
    const view = await settingsOf(serverA);
    expect(view).toMatchObject({ knowsLibraryValue: true });
    expect(view.current.image.canonicalThreshold).toBe(6000);
    expect(view.problems.join()).toMatch(/503/);
    cloud.failures.deploymentSettings = false;
  });

  it("leave the stamp to the cloud on a node that has never read the document, and bring it back", async () => {
    // The one state in which a node is in the dark: it syncs with a cloud
    // and has never read a usable document from it.
    cloud.setDeploymentSettings({ standIns: { image: { canonicalThreshold: 5120 } } });
    cloud.failures.deploymentSettings = true;
    const serverC = await startLocalDataServer({ config: cloudConfig() });
    try {
      const driveC = await builtinAppCreds(serverC, "starkeep-drive");
      const dark = await settingsOf(serverC);
      expect(dark).toMatchObject({ set: false, knowsLibraryValue: false });
      expect(dark.problems.join()).toMatch(/503/);

      // An original registered here carries no stamp: this node must not
      // guess, because a stamp is permanent.
      const { body } = await registerWithBytes(driveC, {
        type: "image/jpeg",
        sizeBytes: BIG,
        fidelity: 8000,
        fileName: "while-in-the-dark.jpg",
      });
      const id = body.record!.id;
      expect((await record(driveC, id)).canonical_threshold).toBeNull();

      // A stand-in for an original with no stamp is refused, because nothing
      // here can say what it should be. The refusal keeps the measurement the
      // write reported, so the cloud has an original to stamp and the retry
      // can succeed.
      const unmeasured = await registerWithBytes(driveC, {
        type: "image/jpeg",
        sizeBytes: BIG,
        fileName: "unmeasured-in-the-dark.jpg",
      });
      const unmeasuredId = unmeasured.body.record!.id;
      const refused = await registerWithBytes(driveC, {
        type: "image/avif",
        parentId: unmeasuredId,
        standIn: { role: "canonical", fidelity: 5120 },
        parentFidelity: 9000,
        fileName: "canonical.avif",
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("parent-awaits-stamp");
      expect((await record(driveC, unmeasuredId)).fidelity).toBe(9000);

      // The cloud always knows, so it stamps the originals it applies, and
      // the stamps come back to the node that sent them.
      await syncNow(driveC);
      await syncNow(driveC);
      expect((await record(driveC, id)).canonical_threshold).toBe(5120);
      expect((await record(driveC, unmeasuredId)).canonical_threshold).toBe(5120);

      // Once the route answers, the node knows the value too.
      cloud.failures.deploymentSettings = false;
      await refresh(serverC);
      expect(await settingsOf(serverC)).toMatchObject({
        set: true,
        knowsLibraryValue: true,
        problems: [],
      });
    } finally {
      cloud.failures.deploymentSettings = false;
      await serverC.stop();
    }
  });
});

describe("the deployment's settings on a node with no cloud", () => {
  let solo: LocalDataServer;
  let driveSolo: InstalledApp;

  beforeAll(async () => {
    solo = await startLocalDataServer();
    driveSolo = await builtinAppCreds(solo, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await solo?.stop();
  });

  it("refuse a value out of range and write nothing", async () => {
    const res = await putSettings(solo, { standIns: { image: { canonicalThreshold: 100 } } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { problems: string[] }).problems.join()).toMatch(/1280 to 16384/);
    expect((await settingsOf(solo)).set).toBe(false);
  });

  it("keep a value in this machine's config and stamp with it, keeping what the change left out", async () => {
    expect((await putSettings(solo, { trash: { retentionDays: 90 } })).status).toBe(200);
    expect(
      (await putSettings(solo, { standIns: { image: { canonicalThreshold: 6000 } } })).status,
    ).toBe(200);
    const view = await settingsOf(solo);
    expect(view).toMatchObject({ set: true, knowsLibraryValue: true });
    expect(view.current.image.canonicalThreshold).toBe(6000);
    expect(view.current.video.canonicalThreshold).toBe(4800);
    const res = await fetch(`${solo.url}/library/deployment-settings`);
    expect(((await res.json()) as { retentionDays: number }).retentionDays).toBe(90);

    const { body } = await registerWithBytes(driveSolo, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fidelity: 8000,
      fileName: "solo.jpg",
    });
    expect((await record(driveSolo, body.record!.id)).canonical_threshold).toBe(6000);
  });
});
