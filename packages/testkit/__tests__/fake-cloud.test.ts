import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serializeHLC } from "@starkeep/protocol-primitives";
import { startFakeCloud, type FakeCloud } from "../src/index.js";

describe("fake cloud responder", () => {
  let cloud: FakeCloud;

  beforeAll(async () => {
    cloud = await startFakeCloud();
  });

  afterAll(async () => {
    await cloud.close();
  });

  it("answers /health at both the root and per-app paths", async () => {
    expect((await fetch(`${cloud.url}/health`)).status).toBe(200);
    expect((await fetch(`${cloud.url}/apps/starkeep-drive/health`)).status).toBe(200);
  });

  it("serves an empty exchange on the Drive channel and logs it", async () => {
    const res = await fetch(`${cloud.url}/apps/starkeep-drive/sync/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watermarks: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: unknown[]; hasMore: boolean };
    expect(body.records).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(cloud.exchangeLog.at(-1)).toMatchObject({
      appId: "starkeep-drive",
      inRecords: 0,
      outRecords: 0,
    });
  });

  it("round-trips a blob through presign PUT → confirm → presign GET", async () => {
    const key = "shared/jpg/test-blob";
    const presignPut = await fetch(`${cloud.url}/apps/starkeep-drive/files/presign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    expect(presignPut.status).toBe(200);
    const { url: putUrl } = (await presignPut.json()) as { url: string };
    const put = await fetch(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("jpeg-bytes"),
    });
    expect(put.status).toBe(200);
    expect(await cloud.hasBlob(key)).toBe(true);

    const head = await fetch(
      `${cloud.url}/apps/starkeep-drive/files/${encodeURIComponent(key)}`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);

    const presignGet = await fetch(
      `${cloud.url}/apps/starkeep-drive/files/${encodeURIComponent(key)}/presign`,
    );
    expect(presignGet.status).toBe(200);
    const { url: getUrl } = (await presignGet.json()) as { url: string };
    const got = await fetch(getUrl);
    expect(Buffer.from(await got.arrayBuffer()).toString()).toBe("jpeg-bytes");
  });

  it("injects exchange failures via the failure counters", async () => {
    cloud.failures.exchanges = 1;
    const failing = await fetch(`${cloud.url}/apps/starkeep-drive/sync/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watermarks: {} }),
    });
    expect(failing.status).toBe(500);
    const recovered = await fetch(`${cloud.url}/apps/starkeep-drive/sync/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watermarks: {} }),
    });
    expect(recovered.status).toBe(200);
  });

  it("cloud-installs an app and applies its rows on the per-app channel only", async () => {
    cloud.installApp({
      id: "rowsapp",
      name: "Rows App",
      version: "1.0.0",
      tier: "community",
      infraRequirements: {
        fileAccess: [],
        appSpecificSyncable: {
          files: false,
          tables: [
            {
              name: "notes",
              columns: [
                { name: "note_id", type: "text", primaryKey: true, notNull: true },
                { name: "body", type: "text" },
              ],
            },
          ],
        },
      },
    });

    const timestamp = { wallTime: Date.now(), counter: 0, nodeId: "test-node" };
    const res = await fetch(`${cloud.url}/apps/rowsapp/sync/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        watermarks: {},
        appSyncableRows: [
          {
            appId: "rowsapp",
            table: "notes",
            op: "insert",
            row: { note_id: "n1", body: "hello", updated_at: serializeHLC(timestamp) },
            timestamp,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const rows = cloud.appRows("rowsapp", "notes");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ note_id: "n1", body: "hello" });
  });
});
