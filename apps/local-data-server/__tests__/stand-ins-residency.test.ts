/**
 * Node residency for the stand-in categories, over real servers: what a node
 * receives against its sync-down ceiling, what a read brings on demand, the
 * ceiling routes, "Keep originals here", and "Free up space".
 *
 * Every presence check reads the disk or the listing. A file or content read
 * would itself fetch the bytes it asks about.
 *
 * The fake cloud's file store reports no checksum, so no replica there can be
 * confirmed and "Free up space" can only refuse here. That is the direction
 * that matters over the wire — the removal path, with verified replicas, is
 * covered in the sync engine's `stand-in-residency.test.ts`.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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

/** Whether a node holds a record's bytes on disk, as opposed to merely its row. */
async function holds(server: LocalDataServer, app: InstalledApp, recordId: string): Promise<boolean> {
  const res = await app.fetch(`/data/records/${recordId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  const record = (body.record ?? body) as { objectStorageKey?: string; object_storage_key?: string };
  const key = record.objectStorageKey ?? record.object_storage_key;
  expect(key, JSON.stringify(body)).toBeTruthy();
  return existsSync(join(server.starkeepDir, "objects", key!));
}

/** Where each of an original's sizes sits on a node, by fidelity, without fetching any. */
async function placements(app: InstalledApp, original: string): Promise<Record<number, string>> {
  const where = encodeURIComponent(JSON.stringify({ id: original }));
  const res = await app.fetch(`/data/records?where=${where}`);
  const sizes = ((await res.json()) as { records: Array<{ stand_ins: { sizes: Array<{ fidelity: number; placement: string }> } }> })
    .records[0]!.stand_ins.sizes;
  return Object.fromEntries(sizes.map((s) => [s.fidelity, s.placement]));
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
    expect(await placements(driveB, f.original)).toMatchObject({ 1280: "here", 2560: "here", 4272: "cloud" });
    expect(await holds(serverB, driveB, f.original)).toBe(false);
  });

  // The Drive channel carries the bytes, as it does on the phone. A presigned
  // S3 URL would answer 403: the person's own identity cannot read `shared/`.
  it("brings an original here when something reads it, and keeps it", async () => {
    const f = await family(driveA);
    await converge();
    expect(await holds(serverB, driveB, f.original)).toBe(false);

    const res = await driveB.fetch(`/data/records/${f.original}/file-url`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; source: string };
    expect(body.source).toBe("local");
    expect((await fetch(body.url)).status).toBe(200);
    expect(await holds(serverB, driveB, f.original)).toBe(true);

    // A later round leaves it where it is.
    await converge();
    expect(await holds(serverB, driveB, f.original)).toBe(true);
  });

  it("brings the canonical stand-in here when a content read asks for it", async () => {
    const f = await family(driveA);
    await converge();
    const { status, body } = await contentUrl(driveB, f.original, "canonical");
    expect(status).toBe(200);
    expect(body).toMatchObject({ record_id: f.canonical, available_here: true });
    expect((await fetch(body.url as string)).status).toBe(200);
    expect((await placements(driveB, f.original))[4272]).toBe("here");
  });

  it("brings missing files here for a batch read", async () => {
    const a = await family(driveA);
    const b = await family(driveA);
    await converge();
    const res = await driveB.fetch("/data/records/file-urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [a.original, b.original, a.medium] }),
    });
    expect(res.status).toBe(200);
    const { urls } = (await res.json()) as { urls: Record<string, { url: string }> };
    expect(Object.keys(urls).sort()).toEqual([a.original, b.original, a.medium].sort());
    for (const id of [a.original, b.original]) expect(await holds(serverB, driveB, id)).toBe(true);
  });

  // Every failure leaves the desktop as it was and says so, rather than
  // handing out a URL that cannot work.
  describe("when the cloud cannot hand over the bytes", () => {
    afterEach(() => {
      cloud.failures.blobGets = 0;
    });

    it("answers file-url with 502", async () => {
      const f = await family(driveA);
      await converge();
      cloud.failures.blobGets = 1000;
      const res = await driveB.fetch(`/data/records/${f.original}/file-url`);
      expect(res.status).toBe(502);
      expect(await holds(serverB, driveB, f.original)).toBe(false);
    });

    it("answers content-url with no URL and says the bytes are not here", async () => {
      const f = await family(driveA);
      await converge();
      cloud.failures.blobGets = 1000;
      const { status, body } = await contentUrl(driveB, f.original, "canonical");
      expect(status).toBe(200);
      expect(body).toMatchObject({ record_id: f.canonical, available_here: false, url: null });
    });

    it("leaves a failed id out of a batch and still serves the rest", async () => {
      const f = await family(driveA);
      await converge();
      cloud.failures.blobGets = 1000;
      const res = await driveB.fetch("/data/records/file-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [f.original, f.medium] }),
      });
      expect(res.status).toBe(200);
      const { urls } = (await res.json()) as { urls: Record<string, unknown> };
      // The 1280 stand-in is here already; the original needed a fetch that failed.
      expect(Object.keys(urls)).toEqual([f.medium]);
    });
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

  // No stand-in can replace any of these, so every node keeps them.
  it("keeps a derived record, a document and an audio file, whatever its ceiling", async () => {
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
    const song = await create(driveA, {
      type: "audio/mp3",
      contentType: "audio/mpeg",
      fileName: `song-${Math.random()}.mp3`,
      sizeBytes: BIG,
    });
    await converge([driveA, driveC]);
    expect(await holds(serverC, driveC, poster)).toBe(true);
    expect(await holds(serverC, driveC, pdf)).toBe(true);
    expect(await holds(serverC, driveC, song)).toBe(true);
    expect((await placements(driveC, f.original))[2560]).toBe("cloud");
  }, 60_000);

  // No round offers the 2560 again once the watermark is past it, so the
  // restart's catalogue scan and the acquisition pass are what bring it.
  it("receives what a raised ceiling now covers", async () => {
    const f = await family(driveA);
    await converge([driveA, driveC]);
    expect(await placements(driveC, f.original)).toMatchObject({ 1280: "here", 2560: "cloud" });

    const res = await fetch(`${serverC.url}/residency/stand-ins`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ceilings: { image: 2560 } }),
    });
    expect(res.status).toBe(200);
    await waitForRestart(serverC);
    driveC = await builtinAppCreds(serverC, "starkeep-drive");

    await converge([driveC]);
    expect(await placements(driveC, f.original)).toMatchObject({ 2560: "here", 4272: "cloud" });
  }, 120_000);
});

describe("a node that keeps originals", () => {
  let serverD: LocalDataServer;
  let driveD: InstalledApp;

  beforeAll(async () => {
    serverD = await startLocalDataServer({
      config: { ...config, keepOriginals: true },
      auth: { idToken: fakeIdToken() },
    });
    driveD = await builtinAppCreds(serverD, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await serverD?.stop();
  });

  it("receives every original, and leaves the canonical stand-in on demand", async () => {
    const f = await family(driveA);
    const unmeasured = await create(driveA, {
      type: "image/jpeg",
      sizeBytes: BIG,
      fileName: `unmeasured-${Math.random()}.jpg`,
    });
    await converge([driveA, driveD]);
    expect(await holds(serverD, driveD, f.original)).toBe(true);
    expect(await holds(serverD, driveD, unmeasured)).toBe(true);
    expect(await placements(driveD, f.original)).toMatchObject({ 2560: "here", 4272: "cloud" });
  }, 60_000);

  it("frees no original", async () => {
    const res = await fetch(`${serverD.url}/residency/free-up-space`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bytes: 1024 * 1024 * 1024, scope: "originals", dryRun: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ eligibleBytes: 0 });
  });

  it("reports the setting and what the library's originals weigh", async () => {
    const res = await fetch(`${serverD.url}/residency/stand-ins`);
    const body = (await res.json()) as {
      keepOriginals: boolean;
      libraryOriginals: Record<string, { count: number; bytes: number }>;
    };
    expect(body.keepOriginals).toBe(true);
    expect(body.libraryOriginals.image!.count).toBeGreaterThanOrEqual(2);
    expect(body.libraryOriginals.image!.bytes).toBeGreaterThanOrEqual(2 * BIG);
    expect(body.libraryOriginals.video).toEqual({ count: 0, bytes: 0 });
  });
});

describe("a desktop that syncs with no cloud", () => {
  let lone: LocalDataServer;
  let driveL: InstalledApp;

  beforeAll(async () => {
    lone = await startLocalDataServer();
    driveL = await builtinAppCreds(lone, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await lone?.stop();
  });

  it("answers file-url with 404 for bytes that are not here, since nothing could fetch them", async () => {
    const id = await create(driveL, { type: "image/jpeg", sizeBytes: 64, fileName: `gone-${Math.random()}.jpg` });
    const res = await driveL.fetch(`/data/records/${id}`);
    const path = ((await res.json()) as { record: { path: string } }).record.path;
    await rm(path);
    const url = await driveL.fetch(`/data/records/${id}/file-url`);
    expect(url.status).toBe(404);
    expect(((await url.json()) as { error: string }).error).toMatch(/does not sync with a cloud/);
  });
});

describe("the ceiling routes", () => {
  it("report the desktop defaults on an unconfigured node", async () => {
    const res = await fetch(`${serverB.url}/residency/stand-ins`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ceilings: { image: 2560, video: null },
      defaults: { image: 2560, video: null },
      standardSizes: { image: [320, 640, 1280, 2560] },
      canonicalThresholds: { image: 4272, video: 1920 },
      keepOriginals: false,
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
      // Audio is not a stand-in category, so it has no ceiling to set.
      body: JSON.stringify({ ceilings: { image: -3, audio: 128 }, keepOriginals: "yes" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { problems: string[] };
    expect(body.problems).toHaveLength(3);
    expect(body.problems.join("\n")).toMatch(/audio is not a stand-in category/);
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
