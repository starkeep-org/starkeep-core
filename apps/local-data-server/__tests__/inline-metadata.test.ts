/**
 * Metadata at the record's own write, and the clock bump that makes a later
 * metadata write reach a peer at all.
 *
 * Two things are under test and they answer different questions.
 *
 * `POST /data/records` accepting a `metadata` object closes the window in which
 * a record is visible to a sync scan without its metadata — the window that put
 * dimensionless renditions in the cloud. It must not, in closing it, widen who
 * may write derived columns: the same `metadataWrite` grant and the same
 * per-category column list gate both doors.
 *
 * `POST /data/records/:id/metadata` moving `records.updated_at` is what makes a
 * *later* write reach a peer. A decode that backfills EXIF onto an
 * already-registered original writes metadata long after creation, and the
 * outbound sync scan is a delta scan over exactly that column.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  createRecordWithBytes,
  installApp,
  testAppManifest,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;
/** Same readwrite grants, but no `metadataWrite`. */
let noMetadataApp: InstalledApp;

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
  noMetadataApp = await installApp(
    server,
    testAppManifest({
      id: "nometa",
      name: "No Metadata",
      infraRequirements: {
        fileAccess: [
          {
            types: ["image/jpeg", "image/png"],
            access: "readwrite",
            metadataWrite: false,
            rationale: "test",
          },
        ],
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await server.stop();
});

async function readMetadata(
  actor: InstalledApp,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const res = await actor.fetch(`/data/records/${recordId}/metadata/image`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { metadata: Record<string, unknown> | null }).metadata;
}

describe("inline metadata at record creation", () => {
  it("writes the row in the same call as the record", async () => {
    const { record } = await createRecordWithBytes(app, {
      bytes: "inline-metadata-1",
      fileName: "inline1.jpg",
      metadata: { width: 4032, height: 3024 },
    });

    const metadata = await readMetadata(app, record.id);
    expect(metadata).not.toBeNull();
    expect(metadata!["width"]).toBe(4032);
    expect(metadata!["height"]).toBe(3024);
  });

  it("refuses an app with no metadataWrite grant, exactly as the metadata route does", async () => {
    const upload = await noMetadataApp.fetch("/data/files?type=image/jpeg", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("inline-metadata-forbidden"),
    });
    expect(upload.status).toBe(200);
    const { contentHash, sizeBytes } = (await upload.json()) as {
      contentHash: string;
      sizeBytes: number;
    };

    const res = await noMetadataApp.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image/jpeg",
        contentType: "image/jpeg",
        contentHash,
        sizeBytes,
        fileName: "forbidden.jpg",
        metadata: { width: 1 },
      }),
    });
    expect(res.status).toBe(403);

    // And the same app is refused at the other door, which is the point: one
    // grant, two entrances.
    const viaRoute = await noMetadataApp.fetch("/data/records/anything/metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image/jpeg", metadata: { width: 1 } }),
    });
    expect(viaRoute.status).toBe(403);
  });

  it("rejects unknown columns against the category's declaration", async () => {
    const upload = await app.fetch("/data/files?type=image/jpeg", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("inline-metadata-unknown-column"),
    });
    const { contentHash, sizeBytes } = (await upload.json()) as {
      contentHash: string;
      sizeBytes: number;
    };
    const res = await app.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "image/jpeg",
        contentType: "image/jpeg",
        contentHash,
        sizeBytes,
        fileName: "unknown-column.jpg",
        metadata: { width: 4032, bogus_column: 1 },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("bogus_column");
  });

  it("leaves no record behind when the metadata is rejected", async () => {
    const upload = await app.fetch("/data/files?type=image/jpeg", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("inline-metadata-rejected-leaves-nothing"),
    });
    const { contentHash, sizeBytes } = (await upload.json()) as {
      contentHash: string;
      sizeBytes: number;
    };
    const post = (body: Record<string, unknown>) =>
      app.fetch("/data/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const base = {
      type: "image/jpeg",
      contentType: "image/jpeg",
      contentHash,
      sizeBytes,
      fileName: "rejected.jpg",
    };
    expect((await post({ ...base, metadata: { nope: 1 } })).status).toBe(400);

    // Validated before anything is written, so the retry is a fresh create
    // rather than a dedup hit against a half-written first attempt.
    const retry = await post({ ...base, metadata: { width: 10 } });
    expect(retry.status).toBe(200);
    const { record, deduped } = (await retry.json()) as {
      record: { id: string };
      deduped?: boolean;
    };
    expect(deduped).toBeUndefined();
    expect((await readMetadata(app, record.id))!["width"]).toBe(10);
  });

  it('rejects "other", which has no metadata table', async () => {
    const upload = await app.fetch("/data/files?type=image/jpeg", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("inline-metadata-other"),
    });
    const { contentHash, sizeBytes } = (await upload.json()) as {
      contentHash: string;
      sizeBytes: number;
    };
    // The app has no grant on `other`, so the grant check answers first — the
    // same refusal the metadata route gives, and the reason the layering rule
    // holds without a special case.
    const res = await app.fetch("/data/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "other/other",
        contentType: "application/octet-stream",
        contentHash,
        sizeBytes,
        fileName: "other.bin",
        metadata: { anything: 1 },
      }),
    });
    expect(res.status).not.toBe(200);
  });
});

describe("the clock bump on a later metadata write", () => {
  it("moves records.updated_at without touching version", async () => {
    const { record } = await createRecordWithBytes(app, {
      bytes: "clock-bump-subject",
      fileName: "bump.jpg",
    });

    const before = (await (await app.fetch(`/data/records/${record.id}`)).json()) as {
      record: { updated_at: string; version: number };
    };

    const write = await app.fetch(`/data/records/${record.id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image/jpeg", metadata: { width: 640 } }),
    });
    expect(write.status).toBe(200);

    const after = (await (await app.fetch(`/data/records/${record.id}`)).json()) as {
      record: { updated_at: string; version: number };
    };

    // The bump is the whole mechanism: metadata rides the record row, and the
    // outbound sync scan selects on this column. Without it the write is
    // invisible to every peer, forever.
    expect(Date.parse(after.record.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(before.record.updated_at),
    );
    expect(after.record.updated_at).not.toBe(before.record.updated_at);
    // `version` counts revisions of the record. A derived fact arriving is not
    // one.
    expect(after.record.version).toBe(before.record.version);
  });

  it("surfaces the record through updated_after, which is what an incremental refresh reads", async () => {
    const { record } = await createRecordWithBytes(app, {
      bytes: "clock-bump-incremental",
      fileName: "incremental.jpg",
    });
    const cutoff = new Date(Date.now() + 1).toISOString();

    await app.fetch(`/data/records/${record.id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image/jpeg", metadata: { width: 641 } }),
    });

    const res = await app.fetch(
      `/data/records?updated_after=${encodeURIComponent(cutoff)}&include=metadata`,
    );
    expect(res.status).toBe(200);
    const { records } = (await res.json()) as {
      records: Array<{ id: string; metadata: Record<string, unknown> | null }>;
    };
    const found = records.find((r) => r.id === record.id);
    // `updated_at` now means "the record or its derived facts changed". Photos'
    // incremental library refresh reads exactly this and genuinely wants to see
    // it — a photo that just gained its dimensions is a photo the grid should
    // repaint.
    expect(found).toBeDefined();
    expect(found!.metadata!["width"]).toBe(641);
  });
});
