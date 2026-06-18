/**
 * Shared-record data plane: create (both body shapes), read, list, dedup,
 * and blob-presence enforcement. (Plan §3 "Records".)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  testAppManifest,
  createRecordWithBytes,
  listRecords,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;
let scratchDir: string;

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
  scratchDir = await mkdtemp(join(tmpdir(), "lds-records-"));
}, 60_000);

afterAll(async () => {
  await server.stop();
  await rm(scratchDir, { recursive: true, force: true });
});

describe("create — key-ref shape", () => {
  it("registers a record for previously-uploaded bytes", async () => {
    const { record, deduped } = await createRecordWithBytes(app, {
      bytes: "key-ref-bytes",
      fileName: "keyref.jpg",
    });
    expect(deduped).toBeUndefined();
    expect(record.type).toBe("image/jpeg");
    expect(record.original_filename).toBe("keyref.jpg");
    expect(record.object_storage_key).toMatch(/^shared\/image\//); // category-namespaced
    // Readable back through GET /data/records/:id
    const got = await app.fetch(`/data/records/${record.id}`);
    expect(got.status).toBe(200);
  });

  it("refuses to register a record whose blob was never uploaded", async () => {
    const res = await app.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image/jpeg",
        contentType: "image/jpeg",
        contentHash: createHash("sha256").update("never-uploaded").digest("hex"),
        sizeBytes: 13,
      }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Blob not found");
  });

  it("validates contentHash format and sizeBytes", async () => {
    const bad = await app.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "image/jpeg", contentType: "image/jpeg", contentHash: "XYZ" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("create — filePath shape", () => {
  it("ingests a local file by path", async () => {
    const filePath = join(scratchDir, "local-cat.jpg");
    await writeFile(filePath, "local-file-bytes");
    const res = await app.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "image/jpeg", contentType: "image/jpeg", filePath }),
    });
    expect(res.status).toBe(200);
    const { record } = (await res.json()) as { record: Record<string, unknown> };
    expect(record.original_filename).toBe("local-cat.jpg");
    expect(record.size_bytes).toBe(16);
  });

  it("requires one of filePath or contentHash", async () => {
    const res = await app.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "image/jpeg", contentType: "image/jpeg" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("dedup", () => {
  it("same bytes + same filename → deduped:true with the original id", async () => {
    const bytes = Buffer.from(`dedup-bytes-${Date.now()}`);
    const first = await createRecordWithBytes(app, { bytes, fileName: "dup.jpg" });
    const second = await createRecordWithBytes(app, { bytes, fileName: "dup.jpg" });
    expect(second.deduped).toBe(true);
    expect(second.record.id).toBe(first.record.id);
  });

  it("same bytes under a different filename is a new record", async () => {
    const bytes = Buffer.from(`same-bytes-${Date.now()}`);
    const first = await createRecordWithBytes(app, { bytes, fileName: "name-a.jpg" });
    const second = await createRecordWithBytes(app, { bytes, fileName: "name-b.jpg" });
    expect(second.deduped).toBeUndefined();
    expect(second.record.id).not.toBe(first.record.id);
  });

  it("derived children dedup by (parentId, contentHash)", async () => {
    const parent = await createRecordWithBytes(app, { fileName: "parent.jpg" });
    const thumbBytes = Buffer.from(`thumb-${Date.now()}`);
    const child1 = await createRecordWithBytes(app, {
      bytes: thumbBytes,
      parentId: parent.record.id,
    });
    const child2 = await createRecordWithBytes(app, {
      bytes: thumbBytes,
      parentId: parent.record.id,
    });
    expect(child2.deduped).toBe(true);
    expect(child2.record.id).toBe(child1.record.id);
    expect(child1.record.parent_id).toBe(parent.record.id);

    // Same parent, different bytes (a different crop) is NOT collapsed.
    const child3 = await createRecordWithBytes(app, {
      bytes: Buffer.from(`other-thumb-${Date.now()}`),
      parentId: parent.record.id,
    });
    expect(child3.record.id).not.toBe(child1.record.id);
  });
});

describe("list", () => {
  it("honors limit and type filters", async () => {
    for (let i = 0; i < 3; i++) {
      await createRecordWithBytes(app, { fileName: `list-${i}.jpg` });
    }
    const limited = await listRecords(app, "?limit=2");
    expect(limited.length).toBe(2);
    const jpgs = await listRecords(app, "?type=image/jpeg");
    expect(jpgs.every((r) => r.type === "image/jpeg")).toBe(true);
  });

  it("filters with updated_after", async () => {
    await createRecordWithBytes(app, { fileName: "before-cutoff.jpg" });
    // HLC wall times are ms-resolution; leave a clear gap around the cutoff.
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const after = await createRecordWithBytes(app, { fileName: "after-cutoff.jpg" });

    const records = await listRecords(app, `?updated_after=${encodeURIComponent(cutoff)}`);
    const names = records.map((r) => r.original_filename);
    expect(names).toContain("after-cutoff.jpg");
    expect(names).not.toContain("before-cutoff.jpg");
    expect(records.some((r) => r.id === after.record.id)).toBe(true);
  });

  it("reports types with counts in /data/types", async () => {
    await createRecordWithBytes(app, { fileName: "typecount.jpg" });
    const res = await app.fetch("/data/types");
    const body = (await res.json()) as {
      types: Array<{ record_type: string; count: number }>;
      total: number;
    };
    const jpg = body.types.find((t) => t.record_type === "image/jpeg");
    expect(jpg).toBeDefined();
    expect(jpg!.count).toBeGreaterThan(0);
    expect(body.total).toBeGreaterThan(0);
  });
});
