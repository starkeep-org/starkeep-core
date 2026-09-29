/**
 * Node residency for the stand-in categories, over real servers: what a node
 * receives against its sync-down ceiling, the ceiling routes, and "Free up
 * space".
 *
 * The fake cloud's file store reports no checksum, so no replica there can be
 * confirmed and "Free up space" can only refuse here. That is the direction
 * that matters over the wire — the removal path, with verified replicas, is
 * covered in the sync engine's `stand-in-residency.test.ts`.
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
let config: Record<string, unknown>;
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;

async function converge(apps: InstalledApp[] = [driveA, driveB]): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    for (const app of apps) {
      const res = await app.fetch("/sync/now", { method: "POST" });
      expect(res.status).toBe(200);
    }
  }
}

/** Whether a node holds a record's bytes, as opposed to merely its row. */
async function hasBytes(app: InstalledApp, recordId: string): Promise<boolean> {
  const res = await app.fetch(`/data/records/${recordId}/file-url`);
  if (!res.ok) return false;
  const { url } = (await res.json()) as { url: string };
  return (await fetch(url)).status === 200;
}

/** Wait for a self-restarting daemon to come back on the same port. */
async function waitForRestart(server: LocalDataServer): Promise<void> {
  await server.waitForExit(15_000).catch(() => {});
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${server.url}/health`)).ok) return;
    } catch {
      // still down
    }
    if (Date.now() > deadline) throw new Error("daemon did not come back");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  config = { apiGatewayUrl: cloud.url, pullIntervalMs: 600_000, pushDebounceMs: 50, syncMaxItems: 5 };
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

async function create(app: InstalledApp, body: Record<string, unknown>): Promise<string> {
  const { status, body: out } = await registerWithBytes(app, body as never);
  expect(status, JSON.stringify(out)).toBeLessThan(300);
  return out.record!.id;
}

async function contentUrl(app: InstalledApp, id: string, size: string) {
  const res = await app.fetch(`/data/records/${id}/content-url?size=${size}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function family(app: InstalledApp) {
  const original = await create(app, {
    type: "image/jpeg",
    sizeBytes: BIG,
    fileName: `family-${Math.random()}.jpg`,
    fidelity: 6000,
  });
  const standIn = (role: string, fidelity: number, bytes: number) =>
    create(app, {
      type: "image/avif",
      contentType: "image/avif",
      parentId: original,
      fileName: `${role}-${fidelity}`,
      sizeBytes: bytes,
      standIn: { role, fidelity },
    });
  const medium = await standIn("smaller", 1280, 20_000);
  const screen = await standIn("smaller", 2560, 60_000);
  const canonical = await standIn("canonical", 4272, 200_000);
  return { original, medium, screen, canonical };
}

describe("what a desktop receives against its ceiling", () => {
  it("receives stand-ins up to 2560, and the original and canonical stand-in only on demand", async () => {
    const f = await family(driveA);
    await converge();

    // The rows arrive everywhere; the bytes follow the ceiling.
    expect((await contentUrl(driveB, f.original, "1280")).body.available_here).toBe(true);
    expect((await contentUrl(driveB, f.original, "2560")).body.available_here).toBe(true);
    expect((await contentUrl(driveB, f.original, "canonical")).body.available_here).toBe(false);

    const res = await driveB.fetch(`/data/records/${f.original}/file-url`);
    // No cloud storage is configured on this node, so an original it does not
    // hold has nowhere to be read from here.
    expect(res.status).toBe(404);
  });

  it("describes where each size sits on each node", async () => {
    const f = await family(driveA);
    await converge();
    const where = encodeURIComponent(JSON.stringify({ id: f.original }));
    const res = await driveB.fetch(`/data/records?where=${where}`);
    const sizes = ((await res.json()) as { records: Array<{ stand_ins: { sizes: Array<{ fidelity: number; placement: string }> } }> })
      .records[0]!.stand_ins.sizes;
    expect(sizes.map((s) => [s.fidelity, s.placement])).toEqual([
      [320, "missing"],
      [640, "missing"],
      [1280, "here"],
      [2560, "here"],
      [4272, "cloud"],
    ]);
  });
});

describe("a node at the phone's ceiling", () => {
  let serverC: LocalDataServer;
  let driveC: InstalledApp;

  beforeAll(async () => {
    serverC = await startLocalDataServer({
      config: { ...config, standInCeilings: { image: 1280 } },
      auth: { idToken: fakeIdToken() },
    });
    driveC = await builtinAppCreds(serverC, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await serverC?.stop();
  });

  // No stand-in can replace either, so every node keeps both.
  it("keeps a derived record and a document, whatever its ceiling", async () => {
    const f = await family(driveA);
    const poster = await create(driveA, {
      type: "image/webp",
      contentType: "image/webp",
      parentId: f.original,
      fileName: `poster-${Math.random()}`,
      sizeBytes: 30_000,
    });
    const pdf = await create(driveA, {
      type: "document/pdf",
      contentType: "application/pdf",
      fileName: `doc-${Math.random()}.pdf`,
      sizeBytes: BIG,
    });
    await converge([driveA, driveC]);
    expect(await hasBytes(driveC, poster)).toBe(true);
    expect(await hasBytes(driveC, pdf)).toBe(true);
    expect((await contentUrl(driveC, f.original, "2560")).body.available_here).toBe(false);
  }, 60_000);

  // No round offers the 2560 again once the watermark is past it, so the
  // restart's catalogue scan and the acquisition pass are what bring it.
  it("receives what a raised ceiling now covers", async () => {
    const f = await family(driveA);
    await converge([driveA, driveC]);
    expect((await contentUrl(driveC, f.original, "1280")).body.available_here).toBe(true);
    expect((await contentUrl(driveC, f.original, "2560")).body.available_here).toBe(false);

    const res = await fetch(`${serverC.url}/residency/stand-ins`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ceilings: { image: 2560 } }),
    });
    expect(res.status).toBe(200);
    await waitForRestart(serverC);
    driveC = await builtinAppCreds(serverC, "starkeep-drive");

    await converge([driveC]);
    expect((await contentUrl(driveC, f.original, "2560")).body.available_here).toBe(true);
    expect((await contentUrl(driveC, f.original, "canonical")).body.available_here).toBe(false);
  }, 120_000);
});

describe("the ceiling routes", () => {
  it("report the desktop defaults on an unconfigured node", async () => {
    const res = await fetch(`${serverB.url}/residency/stand-ins`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nodeKind: "desktop",
      ceilings: { image: 2560, video: null, audio: null },
      defaults: { phone: { image: 1280 }, desktop: { image: 2560 } },
      standardSizes: { image: [320, 640, 1280, 2560] },
      canonicalThresholds: { image: 4272, video: 1920, audio: 128 },
    });
  });

  it("count the backlog across every type, for the operator", async () => {
    type Backlog = Record<string, { count: number; complete: boolean }>;
    const read = async () =>
      ((await (await fetch(`${serverA.url}/residency/stand-ins`)).json()) as { backlog: Backlog }).backlog;
    const before = await read();
    await create(driveA, { type: "image/jpeg", sizeBytes: BIG, fileName: `waiting-${Math.random()}.jpg`, fidelity: 6000 });
    await create(driveA, { type: "image/jpeg", sizeBytes: BIG, fileName: `unmeasured-${Math.random()}.jpg` });
    const after = await read();
    expect(after["missing-canonical"]).toEqual({ count: before["missing-canonical"]!.count + 1, complete: true });
    expect(after["missing-fidelity"]).toEqual({ count: before["missing-fidelity"]!.count + 1, complete: true });
  });

  it("refuse a malformed ceiling without saving it", async () => {
    const res = await fetch(`${serverB.url}/residency/stand-ins`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ceilings: { image: -3, model3d: 5 }, nodeKind: "fridge" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { problems: string[] };
    expect(body.problems).toHaveLength(3);
  });
});

describe("POST /residency/free-up-space", () => {
  async function free(body: Record<string, unknown>) {
    const res = await fetch(`${serverA.url}/residency/free-up-space`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("refuses a malformed request", async () => {
    expect((await free({ bytes: -1, scope: "originals" })).status).toBe(400);
    expect((await free({ bytes: 10, scope: "everything" })).status).toBe(400);
  });

  it("removes nothing it cannot prove is in the cloud, and says why", async () => {
    const f = await family(driveA);
    await converge();
    const { status, body } = await free({ bytes: 1, scope: "originals-and-above-ceiling" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ cloudReachable: true, freedBytes: 0, removed: [] });
    expect((body.eligibleBytes as number) > 0).toBe(true);
    const refused = body.refused as Array<{ recordId: string; reason: string }>;
    expect(refused.find((r) => r.recordId === f.original)?.reason).toBe("not-durable");
    // Other files on this shared server are refused too — none is removed.
    expect(refused.every((r) => r.reason === "not-durable" || r.reason === "no-canonical")).toBe(true);
    expect((await contentUrl(driveA, f.original, "canonical")).body.available_here).toBe(true);
  });

  it("estimates without removing on a dry run", async () => {
    const { body } = await free({ bytes: 1, scope: "originals", dryRun: true });
    expect(body).toMatchObject({ dryRun: true, removed: [] });
  });
});
