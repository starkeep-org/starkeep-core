/**
 * Grant enforcement through the HTTP surface: an app sees exactly its
 * declared types. (Plan §2 Tier-1 cases + §6 built-ins.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installApp,
  builtinAppCreds,
  testAppManifest,
  readOnlyAppManifest,
  createRecordWithBytes,
  listRecords,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;
let imageApp: InstalledApp; // readwrite jpg/png + metadataWrite
let pdfReader: InstalledApp; // read-only pdf
let drive: InstalledApp;

beforeAll(async () => {
  server = await startLocalDataServer();
  imageApp = await installApp(server, testAppManifest());
  pdfReader = await installApp(server, readOnlyAppManifest());
  drive = await builtinAppCreds(server, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("write grants", () => {
  it("read-only grant → 403 on record create of that type", async () => {
    const res = await pdfReader.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "document/pdf",
        contentType: "application/pdf",
        contentHash: "a".repeat(64),
        sizeBytes: 1,
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe("AccessDenied");
    expect(body.detail).toContain("readwrite");
  });

  it("no grant at all → 403 on create (jpg from the pdf app)", async () => {
    const res = await pdfReader.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image/jpeg",
        contentType: "image/jpeg",
        contentHash: "b".repeat(64),
        sizeBytes: 1,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("byte uploads are category-gated too", async () => {
    const res = await pdfReader.fetch("/data/files?type=document/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: Buffer.from("pdf bytes"),
    });
    expect(res.status).toBe(403); // read grant ≠ category write
    const presign = await pdfReader.fetch("/files/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: `shared/document/aa/${"a".repeat(64)}` }),
    });
    expect(presign.status).toBe(403);
  });
});

describe("read visibility", () => {
  it("ungranted types are invisible in /data/records and /data/types", async () => {
    const created = await createRecordWithBytes(imageApp, { fileName: "secret.jpg" });

    const visible = await listRecords(imageApp);
    expect(visible.some((r) => r.id === created.record.id)).toBe(true);

    const invisible = await listRecords(pdfReader);
    expect(invisible.some((r) => r.id === created.record.id)).toBe(false);

    const typesRes = await pdfReader.fetch("/data/types");
    const types = (await typesRes.json()) as { types: Array<{ record_type: string }>; total: number };
    expect(types.types.some((t) => t.record_type === "image/jpeg")).toBe(false);
  });

  it("category-widening: a jpg grant permits category file ops on png bytes (pinned-intentional)", async () => {
    // imageApp declares jpg AND png; use a one-extension app to pin widening.
    const jpgOnly = await installApp(server, {
      id: "jpg-only",
      name: "Jpg Only",
      version: "1.0.0",
      tier: "community",
      infraRequirements: {
        fileAccess: [
          { types: ["image/jpeg"], access: "readwrite", metadataWrite: false, rationale: "t" },
        ],
      },
    });
    // png is a different extension in the same category (image) — the
    // category-level byte upload is allowed by design.
    const res = await jpgOnly.fetch("/data/files?type=image/png", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Buffer.from("png-bytes"),
    });
    expect(res.status).toBe(200);
    // …but the record-level write on type png stays denied (extension-exact).
    const record = await jpgOnly.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image/png",
        contentType: "image/png",
        contentHash: "c".repeat(64),
        sizeBytes: 1,
      }),
    });
    expect(record.status).toBe(403);
  });
});

describe("all-access identities", () => {
  it("starkeep-drive reads and writes every type with no grant rows", async () => {
    const created = await createRecordWithBytes(drive, { fileName: "drive.jpg" });
    expect(created.record.id).toBeDefined();
    // Drive sees records created by other apps.
    const fromImageApp = await createRecordWithBytes(imageApp, { fileName: "other.jpg" });
    const driveList = await listRecords(drive);
    expect(driveList.some((r) => r.id === fromImageApp.record.id)).toBe(true);
  });
});

describe("metadata writes", () => {
  it("metadataWrite grant allows category metadata and validates columns", async () => {
    const { record } = await createRecordWithBytes(imageApp, { fileName: "meta.jpg" });
    const ok = await imageApp.fetch(`/data/records/${record.id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image/jpeg", metadata: { width: 800, height: 600 } }),
    });
    expect(ok.status).toBe(200);

    const read = await imageApp.fetch(`/data/records/${record.id}/metadata/image`);
    const meta = (await read.json()) as { metadata: Record<string, unknown> };
    expect(meta.metadata).toMatchObject({ width: 800, height: 600 });

    const unknownColumn = await imageApp.fetch(`/data/records/${record.id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image/jpeg", metadata: { not_a_column: 1 } }),
    });
    expect(unknownColumn.status).toBe(400);
  });

  it("no metadataWrite grant → 403", async () => {
    const { record } = await createRecordWithBytes(imageApp, { fileName: "meta2.jpg" });
    const res = await pdfReader.fetch(`/data/records/${record.id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image/jpeg", metadata: { width: 1 } }),
    });
    expect(res.status).toBe(403);
  });

  it("`other`-category records have no metadata table (400 even for Drive)", async () => {
    // Drive passes the grant check (all-access) and hits the no-table guard.
    const res = await drive.fetch(`/data/records/someid/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "zzz-unmapped", metadata: { x: 1 } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no metadata table");

    // Reading metadata for `other` yields null rather than an error.
    const read = await drive.fetch(`/data/records/someid/metadata/zzz-unmapped`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { metadata: unknown }).metadata).toBeNull();
  });

  it("ordinary apps cannot reach `other` at all (403 before the table guard)", async () => {
    const res = await imageApp.fetch(`/data/records/someid/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "zzz-unmapped", metadata: { x: 1 } }),
    });
    expect(res.status).toBe(403);
  });
});
