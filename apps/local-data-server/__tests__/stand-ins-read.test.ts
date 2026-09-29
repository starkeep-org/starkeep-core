/**
 * Reading stand-ins, end to end: the collapsed listing, the size summary each
 * original carries, the content read at a chosen size, and deletes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  registerWithBytes,
  standInAppManifest,
  type InstalledApp,
} from "./helpers.js";

const BIG = 2 * 1024 * 1024;

let server: LocalDataServer;
let app: InstalledApp;

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, standInAppManifest());
}, 60_000);

afterAll(async () => {
  await server.stop();
});

interface WireSize {
  fidelity: number;
  role: string;
  record_id: string | null;
  placement: string;
  url?: string;
}
interface WireRecord {
  id: string;
  stand_in_role: string | null;
  fidelity: number | null;
  stand_ins?: {
    status: string;
    top: number | null;
    fidelity: number | null;
    sizes: WireSize[];
    original_placement: string;
  };
}

async function list(query: string): Promise<WireRecord[]> {
  const res = await app.fetch(`/data/records?${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { records: WireRecord[] }).records;
}

async function create(body: Record<string, unknown>): Promise<string> {
  const { status, body: out } = await registerWithBytes(app, body as never);
  expect(status, JSON.stringify(out)).toBeLessThan(300);
  return out.record!.id;
}

async function original(over: Record<string, unknown> = {}): Promise<string> {
  return create({ type: "image/jpeg", sizeBytes: BIG, fileName: `o-${Math.random()}.jpg`, ...over });
}

async function standIn(parentId: string, role: string, fidelity: number, over: Record<string, unknown> = {}) {
  return create({
    type: "image/avif",
    contentType: "image/avif",
    parentId,
    fileName: `${role}-${fidelity}`,
    standIn: { role, fidelity },
    ...over,
  });
}

function byParent(parentId: string): string {
  return `where=${encodeURIComponent(JSON.stringify({ parent_id: parentId }))}`;
}

describe("listings", () => {
  it("collapse stand-ins into their original by default", async () => {
    const parent = await original({ fidelity: 6000 });
    const small = await standIn(parent, "smaller", 640);
    const ids = (await list(`where=${encodeURIComponent(JSON.stringify({ id: { in: [parent, small] } }))}`)).map(
      (r) => r.id,
    );
    expect(ids).toEqual([parent]);
  });

  it("show stand-ins as their own rows with include=stand-ins", async () => {
    const parent = await original({ fidelity: 6000 });
    const small = await standIn(parent, "smaller", 640);
    const rows = await list(`${byParent(parent)}&include=stand-ins`);
    expect(rows.map((r) => [r.id, r.stand_in_role, r.fidelity])).toEqual([[small, "smaller", 640]]);
  });

  it("show stand-ins to a where that names stand_in_role", async () => {
    const parent = await original({ fidelity: 6000 });
    const canonical = await standIn(parent, "canonical", 4272);
    const where = encodeURIComponent(JSON.stringify({ parent_id: parent, stand_in_role: "canonical" }));
    expect((await list(`where=${where}`)).map((r) => r.id)).toEqual([canonical]);
  });

  it("keep derived records that are not stand-ins", async () => {
    const parent = await original({ fidelity: 6000 });
    const poster = await create({ type: "image/jpeg", parentId: parent, fileName: "poster" });
    expect((await list(byParent(parent))).map((r) => r.id)).toEqual([poster]);
  });

  it("count one item per original, unless the aggregate asks for stand-ins", async () => {
    const parent = await original({ fidelity: 6000 });
    await standIn(parent, "smaller", 320);
    await standIn(parent, "smaller", 640);
    const collapsed = await app.fetch(
      `/data/records?aggregate=${encodeURIComponent('{"n":{"fn":"count"}}')}&${byParent(parent)}`,
    );
    expect(collapsed.status).toBe(200);
    expect(((await collapsed.json()) as { groups: Array<{ n: number }> }).groups[0]!.n).toBe(0);
    const all = await app.fetch(
      `/data/records?aggregate=${encodeURIComponent('{"n":{"fn":"count"}}')}&${byParent(parent)}&include=stand-ins`,
    );
    expect(((await all.json()) as { groups: Array<{ n: number }> }).groups[0]!.n).toBe(2);
  });
});

describe("the size summary", () => {
  async function summaryOf(id: string, extra = "") {
    const rows = await list(`where=${encodeURIComponent(JSON.stringify({ id }))}${extra}`);
    return rows[0]!.stand_ins!;
  }

  it("lists every standard size and the canonical stand-in of an archivable original", async () => {
    const parent = await original({ fidelity: 6000 });
    await standIn(parent, "smaller", 640);
    const summary = await summaryOf(parent);
    expect(summary.status).toBe("archivable");
    expect(summary.top).toBe(4272);
    expect(summary.sizes.map((s) => [s.fidelity, s.role, s.placement])).toEqual([
      [320, "smaller", "missing"],
      [640, "smaller", "here"],
      [1280, "smaller", "missing"],
      [2560, "smaller", "missing"],
      [4272, "canonical", "missing"],
    ]);
  });

  it("lets a self-canonical original answer its own top size", async () => {
    const parent = await original({ fidelity: 2000 });
    const summary = await summaryOf(parent);
    expect(summary.status).toBe("self-canonical");
    expect(summary.sizes.at(-1)).toMatchObject({ fidelity: 2000, role: "original", record_id: parent });
  });

  it("describes a video original, which always takes a canonical stand-in", async () => {
    const parent = await create({ type: "video/mp4", sizeBytes: BIG, fidelity: 3840, fileName: "v.mp4" });
    const summary = await summaryOf(parent);
    expect(summary.sizes.map((s) => [s.fidelity, s.role])).toEqual([
      [1280, "smaller"],
      [1920, "canonical"],
    ]);
  });

  it("describes an original with no fidelity by what exists", async () => {
    const parent = await original();
    const summary = await summaryOf(parent);
    expect(summary).toMatchObject({ status: "fidelity-unknown", top: null, sizes: [] });
  });

  it("reports cloud placement for a stand-in whose bytes are not here", async () => {
    const parent = await original({ fidelity: 6000 });
    const small = await standIn(parent, "smaller", 320);
    const res = await app.fetch(`/data/records/${small}`);
    const path = ((await res.json()) as { record: { path: string } }).record.path;
    // The node lets the bytes go and keeps the row, which is what an eviction
    // or an elided sync leaves behind.
    await rm(path);
    const summary = await summaryOf(parent);
    expect(summary.sizes.find((s) => s.fidelity === 320)!.placement).toBe("cloud");
  });

  it("says where the original's own bytes sit", async () => {
    const parent = await original({ fidelity: 6000 });
    expect((await summaryOf(parent)).original_placement).toBe("here");
    const res = await app.fetch(`/data/records/${parent}`);
    const path = ((await res.json()) as { record: { path: string } }).record.path;
    await rm(path);
    expect((await summaryOf(parent)).original_placement).toBe("cloud");
  });

  it("carries URLs for resident sizes with include=stand-in-urls", async () => {
    const parent = await original({ fidelity: 6000 });
    await standIn(parent, "smaller", 640);
    const summary = await summaryOf(parent, "&include=stand-in-urls");
    const entry = summary.sizes.find((s) => s.fidelity === 640)!;
    expect(entry.url).toMatch(/\/data\/files\//);
    expect(summary.sizes.find((s) => s.fidelity === 320)!.url).toBeUndefined();
    const bytes = await fetch(entry.url!);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/avif");
  });

  it("rides the single-record read too", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await app.fetch(`/data/records/${parent}`);
    const record = ((await res.json()) as { record: WireRecord }).record;
    expect(record.stand_ins!.top).toBe(4272);
  });
});

describe("GET /data/records/:id/content-url", () => {
  async function read(id: string, size: string) {
    const res = await app.fetch(`/data/records/${id}/content-url?size=${size}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("serves the stand-in at an exact standard size and names it", async () => {
    const parent = await original({ fidelity: 6000 });
    const small = await standIn(parent, "smaller", 640);
    const { status, body } = await read(parent, "640");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      record_id: small,
      type: "image/avif",
      mime_type: "image/avif",
      fidelity: 640,
      role: "smaller",
      available_here: true,
    });
    expect((await fetch(body.url as string)).status).toBe(200);
  });

  it("serves the canonical stand-in for canonical and any larger size", async () => {
    const parent = await original({ fidelity: 6000 });
    const canonical = await standIn(parent, "canonical", 4272);
    expect((await read(parent, "canonical")).body.record_id).toBe(canonical);
    expect((await read(parent, "9000")).body.record_id).toBe(canonical);
  });

  it("serves a self-canonical original as itself", async () => {
    const parent = await original({ fidelity: 2000 });
    const { body } = await read(parent, "canonical");
    expect(body).toMatchObject({ record_id: parent, role: "original", type: "image/jpeg", fidelity: 2000 });
  });

  it("answers 404 with the summary for a size nobody produced", async () => {
    const parent = await original({ fidelity: 6000 });
    const { status, body } = await read(parent, "1280");
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "SizeNotProduced", fidelity: 1280 });
    expect((body.stand_ins as { top: number }).top).toBe(4272);
  });

  it("refuses a size between standard sizes, a malformed size and a stand-in id", async () => {
    const parent = await original({ fidelity: 6000 });
    const small = await standIn(parent, "smaller", 640);
    expect((await read(parent, "500")).body.error).toBe("NotAStandardSize");
    expect((await read(parent, "big")).status).toBe(400);
    expect((await read(small, "640")).body.error).toBe("NotAnOriginal");
  });

  it("answers 404 for an original with no fidelity", async () => {
    const parent = await original();
    expect((await read(parent, "640")).body.error).toBe("FidelityUnknown");
  });
});

describe("DELETE /data/records/:id", () => {
  async function del(id: string) {
    const res = await app.fetch(`/data/records/${id}`, { method: "DELETE" });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function exists(id: string): Promise<boolean> {
    return (await app.fetch(`/data/records/${id}`)).status === 200;
  }

  it("deletes the original, every stand-in and every derived record", async () => {
    const parent = await original({ fidelity: 6000 });
    const small = await standIn(parent, "smaller", 640);
    const canonical = await standIn(parent, "canonical", 4272);
    const poster = await create({ type: "image/jpeg", parentId: parent, fileName: "poster" });
    const { status, body } = await del(parent);
    expect(status).toBe(200);
    expect((body.ids as string[]).sort()).toEqual([parent, small, canonical, poster].sort());
    for (const id of [parent, small, canonical, poster]) expect(await exists(id)).toBe(false);
  });

  it("refuses the canonical stand-in alone while the original is live", async () => {
    const parent = await original({ fidelity: 6000 });
    const canonical = await standIn(parent, "canonical", 4272);
    const { status, body } = await del(canonical);
    expect(status).toBe(409);
    expect(body.error).toBe("CanonicalStandIn");
    expect(await exists(canonical)).toBe(true);
  });

  it("deletes a smaller stand-in alone, freeing its slot", async () => {
    const parent = await original({ fidelity: 6000 });
    const small = await standIn(parent, "smaller", 640);
    expect((await del(small)).status).toBe(200);
    expect(await exists(parent)).toBe(true);
    await standIn(parent, "smaller", 640, { bytes: "a better encode" });
  });

  it("answers 404 for a missing record and 403 without a write grant", async () => {
    expect((await del("01NOSUCHRECORD000000000000")).status).toBe(404);
    const reader = await installApp(server, {
      id: "reader",
      name: "Reader",
      version: "1.0.0",
      tier: "community",
      infraRequirements: {
        fileAccess: [{ types: ["image/jpeg"], access: "read", metadataWrite: false, rationale: "t" }],
      },
    });
    const parent = await original({ fidelity: 6000 });
    expect((await reader.fetch(`/data/records/${parent}`, { method: "DELETE" })).status).toBe(403);
  });
});

describe("GET /data/stand-ins/backlog", () => {
  async function backlog(kind: string, extra = ""): Promise<{ status: number; ids: string[]; next: string | null }> {
    const res = await app.fetch(`/data/stand-ins/backlog?kind=${kind}${extra}`);
    const body = (await res.json()) as { records?: Array<{ id: string }>; nextCursor?: string | null };
    return { status: res.status, ids: (body.records ?? []).map((r) => r.id), next: body.nextCursor ?? null };
  }
  async function all(kind: string): Promise<string[]> {
    const ids: string[] = [];
    let token: string | null = null;
    do {
      const page = await backlog(kind, token ? `&page_token=${encodeURIComponent(token)}` : "");
      ids.push(...page.ids);
      token = page.next;
    } while (token);
    return ids;
  }

  it("lists originals waiting on a canonical stand-in, and drops them once one exists", async () => {
    const waiting = await original({ fidelity: 6000 });
    expect(await all("missing-canonical")).toContain(waiting);
    await standIn(waiting, "canonical", 4272);
    expect(await all("missing-canonical")).not.toContain(waiting);
  });

  it("lists originals nobody has reported a fidelity for", async () => {
    const unknown = await original();
    const known = await original({ fidelity: 6000 });
    const ids = await all("missing-fidelity");
    expect(ids).toContain(unknown);
    expect(ids).not.toContain(known);
  });

  it("refuses an unknown kind", async () => {
    expect((await backlog("everything")).status).toBe(400);
  });
});

describe("the do-not-archive label", () => {
  it("is writable by any app without declaring the key", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await app.fetch("/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId: parent, key: "do-not-archive" }] }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const undeclared = await app.fetch("/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId: parent, key: "not-declared" }] }),
    });
    expect(undeclared.status).toBe(400);
  });
});
