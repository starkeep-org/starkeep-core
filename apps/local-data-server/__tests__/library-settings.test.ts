/**
 * The library's settings file, across the wire: two real local-data-servers
 * and the fake cloud.
 *
 * Pins what only a round trip shows: a value set on one desktop reaches the
 * other through the Drive channel as an ordinary file, concurrent edits
 * converge on one live settings file, and each branch of the stamping rule —
 * a node that knows the library's value stamps, one that does not leaves the
 * stamp to the cloud, and the cloud's stamp comes back in the same exchange.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import { builtinAppCreds, registerWithBytes, type InstalledApp } from "./helpers.js";

const BIG = 2 * 1024 * 1024;

let cloud: FakeCloud;
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;

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
  return fetch(`${server.url}/library/stand-in-standards`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function record(app: InstalledApp, id: string): Promise<Record<string, unknown>> {
  const res = await app.fetch(`/data/records/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { record: Record<string, unknown> }).record;
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

describe("the library's settings", () => {
  it("start at the defaults, unset, and known, on a node that syncs with a cloud", async () => {
    // No settings file exists, so the defaults are the library's value and
    // this node knows it. A node that treated an untouched library as unknown
    // could stamp nothing, so no app could derive a stand-in for anything
    // until the cloud answered.
    const view = await settingsOf(serverA);
    expect(view).toMatchObject({ set: false, knowsLibraryValue: true, problems: [] });
    expect(view.current).toEqual(view.defaults);
  });

  it("stamp with the defaults, with no cloud round, while no settings file exists", async () => {
    const { body } = await registerWithBytes(driveA, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fidelity: 6000,
      fileName: "before-any-setting.jpg",
    });
    expect((await record(driveA, body.record!.id)).canonical_threshold).toBe(4272);
  });

  it("refuse a value out of range and write nothing", async () => {
    const res = await putSettings(serverA, { standIns: { image: { canonicalThreshold: 100 } } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { problems: string[] }).problems.join()).toMatch(/1280 to 16384/);
    expect((await settingsOf(serverA)).set).toBe(false);
  });

  it("leave the stamp to the cloud on a node that cannot read the settings file, and bring it back", async () => {
    // The one state in which a node is genuinely in the dark: a settings file
    // exists, its row has reached this node, and its bytes have not. Built by
    // pushing the file up from A and failing B's blob downloads, so B sees the
    // row without the bytes.
    expect((await putSettings(serverA, { standIns: { image: { canonicalThreshold: 5120 } } })).status).toBe(200);
    await syncNow(driveA);
    cloud.failures.blobGets = 6;
    await syncNow(driveB);
    const dark = await settingsOf(serverB);
    expect(dark).toMatchObject({ set: true, knowsLibraryValue: false });
    expect(dark.problems.join()).toMatch(/have not reached this machine/);

    // An original registered here carries no stamp: this node must not guess,
    // because a stamp is permanent.
    const { body } = await registerWithBytes(driveB, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fidelity: 8000,
      fileName: "while-in-the-dark.jpg",
    });
    const id = body.record!.id;
    expect((await record(driveB, id)).canonical_threshold).toBeNull();

    // A stand-in for an original with no stamp is refused, because nothing here
    // can say what it should be. An unmeasured original is the case that would
    // wedge: the refusal keeps the measurement the write reported, so the cloud
    // has an original to stamp and the retry can succeed.
    const unmeasured = await registerWithBytes(driveB, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fileName: "unmeasured-in-the-dark.jpg",
    });
    const unmeasuredId = unmeasured.body.record!.id;
    expect((await record(driveB, unmeasuredId)).fidelity).toBeNull();
    const refused = await registerWithBytes(driveB, {
      type: "image/avif",
      parentId: unmeasuredId,
      standIn: { role: "canonical", fidelity: 5120 },
      parentFidelity: 9000,
      fileName: "canonical.avif",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("parent-awaits-stamp");
    expect((await record(driveB, unmeasuredId)).fidelity).toBe(9000);

    // The cloud always knows, so it stamps the originals it applies, and the
    // stamps come back to the node that sent them.
    cloud.failures.blobGets = 0;
    await converge();
    expect((await settingsOf(serverB)).knowsLibraryValue).toBe(true);
    expect((await record(driveB, id)).canonical_threshold).toBe(5120);
    expect((await record(driveA, id)).canonical_threshold).toBe(5120);
    // And the one whose measurement only the refusal kept is stamped too, so
    // the retry of that stand-in write now has a threshold to be checked
    // against.
    expect((await record(driveB, unmeasuredId)).canonical_threshold).toBe(5120);
  });

  it("carry a value set on one desktop to the other, which then stamps with it", async () => {
    const res = await putSettings(serverA, {
      standIns: { image: { canonicalThreshold: 6000 }, video: { advisoryLongEdges: { bySize: { "2000": 960 } } } },
    });
    expect(res.status).toBe(200);
    const onA = await settingsOf(serverA);
    expect(onA).toMatchObject({ set: true, knowsLibraryValue: true });
    expect(onA.current.image.canonicalThreshold).toBe(6000);
    // A value the request left out keeps its current value.
    expect(onA.current.video.canonicalThreshold).toBe(4800);

    await converge();
    const onB = await settingsOf(serverB);
    expect(onB).toMatchObject({ set: true, knowsLibraryValue: true, problems: [] });
    expect(onB.current.image.canonicalThreshold).toBe(6000);
    expect(onB.current.video.advisoryLongEdges).toEqual({ canonical: 1920, bySize: { 2000: 960 } });

    const { body } = await registerWithBytes(driveB, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fidelity: 8000,
      fileName: "after-the-setting.jpg",
    });
    expect((await record(driveB, body.record!.id)).canonical_threshold).toBe(6000);
  });

  it("leave an original stamped earlier as it was", async () => {
    const where = encodeURIComponent(JSON.stringify({ original_filename: "before-any-setting.jpg" }));
    const res = await driveA.fetch(`/data/records?where=${where}`);
    const [earlier] = ((await res.json()) as { records: Array<Record<string, unknown>> }).records;
    expect(earlier!.canonical_threshold).toBe(4272);
  });

  it("converge concurrent edits on one live settings file, the newest", async () => {
    expect((await putSettings(serverA, { standIns: { image: { canonicalThreshold: 5120 } } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await putSettings(serverB, { standIns: { image: { canonicalThreshold: 3200 } } })).status).toBe(200);
    await converge();
    await converge();
    expect((await settingsOf(serverA)).current.image.canonicalThreshold).toBe(3200);
    expect((await settingsOf(serverB)).current.image.canonicalThreshold).toBe(3200);
    expect(liveSettingsInCloud()).toBe(1);
  });
});
