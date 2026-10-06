/**
 * The Trash, end to end over a real server: the tombstone feed, the way back, and
 * the reaper.
 *
 * A tombstone used to be invisible — every records query hard-coded
 * `deleted_at IS NULL` — and nothing ever reclaimed a blob, so storage only grew
 * and "I deleted that" meant "I stopped seeing it". These routes are what make a
 * delete something a person can see, undo, and finally have carried out.
 *
 * Driven against the real SQLite adapter on purpose. The reaper's age test is a
 * lexicographic bound over a serialized HLC that the *database* applies, and a
 * mock can only agree with that by construction rather than prove it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  builtinAppCreds,
  createRecordWithBytes,
  installApp,
  listRecords,
  testAppManifest,
  type InstalledApp,
} from "./helpers.js";

let server: LocalDataServer;
let drive: InstalledApp;
let app: InstalledApp;

interface TrashedRecord {
  id: string;
  deleted_at: string | null;
  original_filename: string | null;
}

beforeAll(async () => {
  server = await startLocalDataServer();
  drive = await builtinAppCreds(server, "starkeep-drive");
  // `labelKeys` so the restore case can assert a label comes back: a label write
  // naming an undeclared key is refused, which is the manifest doing its job.
  app = await installApp(
    server,
    testAppManifest({
      infraRequirements: {
        ...(testAppManifest().infraRequirements as Record<string, unknown>),
        labelKeys: [{ key: "favourite", description: "test" }],
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await server.stop();
});

/** The records on one side of the tombstone. */
async function recordsWith(deleted: "exclude" | "only" | "include"): Promise<TrashedRecord[]> {
  const res = await drive.fetch(`/data/records?limit=1000&deleted=${deleted}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { records: TrashedRecord[] }).records;
}

async function reap(body: Record<string, unknown> = {}) {
  const res = await fetch(`${server.url}/residency/reap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the deleted feed", () => {
  it("answers live records by default, and tombstones only when asked", async () => {
    const live = await createRecordWithBytes(app, { bytes: "feed-live", fileName: "live.jpg" });
    const gone = await createRecordWithBytes(app, { bytes: "feed-gone", fileName: "gone.jpg" });
    expect((await app.fetch(`/data/records/${gone.record.id}`, { method: "DELETE" })).status).toBe(200);

    const ids = (rows: TrashedRecord[]) => rows.map((r) => r.id);
    // The default is unchanged, which is what keeps every caller that has never
    // sent `deleted` seeing the answer it always got.
    expect(ids(await recordsWith("exclude"))).toContain(live.record.id);
    expect(ids(await recordsWith("exclude"))).not.toContain(gone.record.id);
    expect(ids(await recordsWith("only"))).toEqual([gone.record.id]);
    expect(ids(await recordsWith("include"))).toEqual(
      expect.arrayContaining([live.record.id, gone.record.id]),
    );
  });

  it("carries the deletion time, which is what a Trash shows", async () => {
    const [tombstone] = await recordsWith("only");
    expect(tombstone!.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const [live] = await recordsWith("exclude");
    expect(live!.deleted_at).toBeNull();
  });

  it("composes with updated_after, which is the whole of an app's delete feed", async () => {
    // An app asks `deleted=only&updated_after=<hlc>` and gets every record
    // tombstoned since it last looked, over the path every other read takes. No
    // second durable store, and no delete log with its own retention problem.
    const before = await createRecordWithBytes(app, { bytes: "feed-early", fileName: "early.jpg" });
    await app.fetch(`/data/records/${before.record.id}`, { method: "DELETE" });
    // `updated_after` takes a moment, which the route turns into a serialized-HLC
    // lower bound. A millisecond's wait is enough to put the two deletes either side.
    await new Promise((r) => setTimeout(r, 5));
    const watermark = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));

    const after = await createRecordWithBytes(app, { bytes: "feed-later", fileName: "later.jpg" });
    await app.fetch(`/data/records/${after.record.id}`, { method: "DELETE" });

    const res = await drive.fetch(
      `/data/records?limit=1000&deleted=only&updated_after=${encodeURIComponent(watermark)}`,
    );
    const { records } = (await res.json()) as { records: TrashedRecord[] };
    expect(records.map((r) => r.id)).toContain(after.record.id);
    expect(records.map((r) => r.id)).not.toContain(before.record.id);
  });

  it("refuses a misspelled value rather than quietly answering the live library", async () => {
    // A Trash view that sent `deleted=onlyy` and got the live library back would
    // look like an empty Trash, which is the one wrong answer nobody checks.
    const res = await drive.fetch("/data/records?deleted=onlyy");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("deleted must be");
  });
});

describe("the retention window", () => {
  it("is reported with the platform default beside it", async () => {
    const res = await drive.fetch("/data/trash");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      retention_days: 30,
      default_retention_days: 30,
      knows_library_value: true,
    });
  });
});

describe("restore", () => {
  it("brings the record back with its labels and its metadata", async () => {
    const created = await createRecordWithBytes(app, {
      bytes: "restore-me",
      fileName: "restore-me.jpg",
      labels: [{ key: "favourite" }],
      metadata: { width: 4032, height: 3024 },
    });
    const id = created.record.id;

    expect((await app.fetch(`/data/records/${id}`, { method: "DELETE" })).status).toBe(200);
    // The metadata route reads its table directly, with no view of any record, so
    // this filter is the only thing keeping a deleted record's dimensions out.
    expect(await metadataIds()).not.toContain(id);

    const res = await app.fetch(`/data/records/${id}/restore`, { method: "POST" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { ids: string[] }).ids).toContain(id);

    expect((await listRecords(drive)).map((r) => r.id)).toContain(id);
    expect(await metadataIds()).toContain(id);
    const withLabels = await drive.fetch(`/data/records/${id}?include=labels`);
    const { record } = (await withLabels.json()) as {
      record: { labels: Array<{ key: string }> };
    };
    expect(record.labels.map((l) => l.key)).toContain("favourite");
  });

  it("refuses a record that is not deleted", async () => {
    const created = await createRecordWithBytes(app, { bytes: "still-live", fileName: "live2.jpg" });
    const res = await app.fetch(`/data/records/${created.record.id}/restore`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("NotDeleted");
  });

  it("answers 404 for a record that never existed", async () => {
    const res = await app.fetch("/data/records/01NOSUCHRECORD000000000000/restore", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("the reaper", () => {
  it("reclaims nothing inside the window, and says what it looked at", async () => {
    const created = await createRecordWithBytes(app, { bytes: "fresh-delete", fileName: "fresh.jpg" });
    await app.fetch(`/data/records/${created.record.id}`, { method: "DELETE" });

    const { status, body } = await reap();
    expect(status).toBe(200);
    expect(body).toMatchObject({ retentionDays: 30, reclaimedBytes: 0, reaped: [] });

    // The bytes are still here, which is what makes a restore inside the window pure
    // row work — shown by restoring and reading them, since `file-url` answers 404
    // for a tombstone whatever its bytes are doing.
    expect((await app.fetch(`/data/records/${created.record.id}/restore`, { method: "POST" })).status).toBe(200);
    const url = await drive.fetch(`/data/records/${created.record.id}/file-url`);
    expect(url.status).toBe(200);
  });

  it("estimates without removing on a dry run", async () => {
    const { body } = await reap({ dryRun: true });
    expect(body).toMatchObject({ dryRun: true });
  });
});

/** The record ids the image metadata table answers for, through the query route. */
async function metadataIds(): Promise<string[]> {
  const res = await drive.fetch("/data/metadata/image?limit=500");
  expect(res.status, await res.clone().text()).toBe(200);
  const { rows } = (await res.json()) as { rows: Array<{ record_id: string }> };
  return rows.map((r) => r.record_id);
}
