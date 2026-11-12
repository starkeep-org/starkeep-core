/**
 * App-specific data plane: declared-table CRUD, isolation between apps, and
 * the per-app file namespace. (Plan §3 "App-specific data".)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, putAppFile, testAppManifest, type InstalledApp } from "../helpers.js";

let server: LocalDataServer;
let appA: InstalledApp; // declares `notes` + files:true
let appB: InstalledApp; // declares its own `notes` + files:false
let noSyncable: InstalledApp; // no appSpecificSyncable at all

beforeAll(async () => {
  server = await startLocalDataServer();
  appA = await installApp(server, testAppManifest());
  appB = await installApp(server, {
    id: "app-b",
    name: "App B",
    version: "1.0.0",
    tier: "community",
    infraRequirements: {
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
  noSyncable = await installApp(server, {
    id: "no-syncable",
    name: "No Syncable",
    version: "1.0.0",
    tier: "community",
    infraRequirements: {},
  });
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("declared-table CRUD", () => {
  it("inserts, queries, updates, and deletes rows", async () => {
    const insert = await appA.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "n1", body: "hello" } }),
    });
    expect(insert.status).toBe(200);

    const query = await appA.fetch(
      `/app-data/db/notes?where=${encodeURIComponent(JSON.stringify({ note_id: "n1" }))}`,
    );
    const { rows } = (await query.json()) as { rows: Array<Record<string, unknown>> };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ note_id: "n1", body: "hello" });
    // Reserved sync columns are maintained inline.
    expect(rows[0].updated_at).toBeDefined();

    const update = await appA.fetch("/app-data/db/notes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ where: { note_id: "n1" }, patch: { body: "edited" } }),
    });
    expect(((await update.json()) as { changes: number }).changes).toBe(1);

    const del = await appA.fetch("/app-data/db/notes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ where: { note_id: "n1" } }),
    });
    expect(((await del.json()) as { changes: number }).changes).toBe(1);

    const after = await appA.fetch(
      `/app-data/db/notes?where=${encodeURIComponent(JSON.stringify({ note_id: "n1" }))}`,
    );
    expect(((await after.json()) as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it("reports what each write did: ifAbsent, true counts, compare-and-set", async () => {
    const send = async (method: string, body: unknown) => {
      const res = await appA.fetch("/app-data/db/notes", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const stampOf = async (id: string) => {
      const res = await appA.fetch(
        `/app-data/db/notes?select=note_id,updated_at&where=${encodeURIComponent(
          JSON.stringify({ note_id: id }),
        )}`,
      );
      const { rows } = (await res.json()) as { rows: Array<{ updated_at: string }> };
      return rows[0]!.updated_at;
    };

    // A seed lands once, then leaves the live row alone.
    expect(await send("POST", { row: { note_id: "s1", body: "seed" }, ifAbsent: true })).toEqual({
      status: 200,
      body: { ok: true, changes: 1 },
    });
    await send("PATCH", { where: { note_id: "s1" }, patch: { body: "edited" } });
    expect(await send("POST", { row: { note_id: "s1", body: "seed" }, ifAbsent: true })).toEqual({
      status: 200,
      body: { ok: true, changes: 0, skipped: "live" },
    });

    // Compare-and-set: the stamp a read returned guards one write.
    const stamp = await stampOf("s1");
    expect(
      await send("PATCH", { where: { note_id: "s1" }, patch: { body: "a" }, ifUpdatedAt: stamp }),
    ).toEqual({ status: 200, body: { changes: 1 } });
    const stale = await send("PATCH", {
      where: { note_id: "s1" },
      patch: { body: "b" },
      ifUpdatedAt: stamp,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ changes: 0, skipped: "stale" });

    // Deleted: a reseed stays out, a patch 404s, and a second delete succeeds.
    expect(await send("DELETE", { where: { note_id: "s1" } })).toEqual({
      status: 200,
      body: { changes: 1 },
    });
    expect(await send("POST", { row: { note_id: "s1", body: "seed" }, ifAbsent: true })).toEqual({
      status: 200,
      body: { ok: true, changes: 0, skipped: "deleted" },
    });
    expect((await send("PATCH", { where: { note_id: "s1" }, patch: { body: "c" } })).status).toBe(
      404,
    );
    expect(await send("DELETE", { where: { note_id: "s1" } })).toEqual({
      status: 200,
      body: { changes: 0, skipped: "deleted" },
    });

    // Never written: patch and delete both 404.
    expect((await send("PATCH", { where: { note_id: "nope" }, patch: { body: "x" } })).status).toBe(
      404,
    );
    expect((await send("DELETE", { where: { note_id: "nope" } })).status).toBe(404);
  });

  it("refuses an undeclared table", async () => {
    const res = await appA.fetch("/app-data/db/not_declared", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { x: 1 } }),
    });
    expect(res.status).toBe(400);
  });

  it("apps with no appSpecificSyncable are refused on the db plane", async () => {
    // Pin: today the factory still builds an (empty) view, so this lands on
    // the undeclared-table 400 rather than the no-namespace 404.
    const res = await noSyncable.fetch("/app-data/db/anything");
    expect([400, 404]).toContain(res.status);
  });

  it("same-named tables in two apps are fully isolated", async () => {
    await appA.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "a-row", body: "A's data" } }),
    });
    const bRows = await appB.fetch("/app-data/db/notes");
    const { rows } = (await bRows.json()) as { rows: unknown[] };
    expect(rows).toHaveLength(0);
  });
});

describe("per-app file namespace", () => {
  it("write/get/delete confined to the app's own namespace", async () => {
    await putAppFile(appA, "thumbs/t1.bin", "app-file-bytes");

    const get = await appA.fetch("/app-data/files/thumbs/t1.bin");
    expect(get.status).toBe(200);
    const { url } = (await get.json()) as { url: string };
    const bytes = await fetch(url);
    expect(Buffer.from(await bytes.arrayBuffer()).toString()).toBe("app-file-bytes");

    const del = await appA.fetch("/app-data/files/thumbs/t1.bin", { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await appA.fetch("/app-data/files/thumbs/t1.bin");
    expect(gone.status).toBe(404);
  });

  it("presign → direct upload → register → stat/get round-trip", async () => {
    const body = Buffer.from("presigned-cover-bytes");
    const contentHash = createHash("sha256")
      .update(body as unknown as Uint8Array)
      .digest("hex");

    // Before any upload, the file is absent.
    const before = await appA.fetch("/app-data/files/cover");
    expect(before.status).toBe(404);

    // 1. Presign — server constructs the key from appId + subKey.
    const presign = await appA.fetch("/app-data/files/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subKey: "cover", contentType: "image/png" }),
    });
    expect(presign.status).toBe(200);
    const { url: uploadUrl, key } = (await presign.json()) as { url: string; key: string };
    expect(key).toContain("/syncable/cover");

    // 2. Upload bytes directly to the presigned URL (no app HMAC needed).
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: body as unknown as BodyInit,
    });
    expect(put.status).toBe(204);

    // Bytes are present, but the index row isn't written until register, so
    // existence-via-index still reports absent.
    const beforeRegister = await appA.fetch("/app-data/files/cover");
    expect(beforeRegister.status).toBe(404);

    // 3. Register the index row.
    const register = await appA.fetch("/app-data/files/cover/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentHash, mimeType: "image/png", sizeBytes: body.length }),
    });
    expect(register.status).toBe(200);

    // 4. Now it exists; GET presigns and the bytes round-trip.
    const get = await appA.fetch("/app-data/files/cover");
    expect(get.status).toBe(200);
    const { url } = (await get.json()) as { url: string };
    const fetched = await fetch(url);
    expect(Buffer.from(await fetched.arrayBuffer()).toString()).toBe("presigned-cover-bytes");

    // Cleanup so the reserved-table assertions below aren't perturbed.
    await appA.fetch("/app-data/files/cover", { method: "DELETE" });
  });

  it("batches playback URLs, omitting subKeys with no index row", async () => {
    // One request for N files. The per-file GET costs a round trip each, and
    // in the cloud a Lambda slot on the calling app's proxy plus one on the
    // data server — which is what exhausted the concurrency ceiling and left
    // memo's study cards silent.
    await putAppFile(appA, "clips/one.bin", "clip-one");
    await putAppFile(appA, "clips/two.bin", "clip-two");

    const res = await appA.fetch("/app-data/file-urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subKeys: ["clips/one.bin", "clips/two.bin", "clips/absent.bin"] }),
    });
    expect(res.status).toBe(200);
    const { urls } = (await res.json()) as { urls: Record<string, string> };

    // The absent key is dropped rather than failing the batch.
    expect(Object.keys(urls).sort()).toEqual(["clips/one.bin", "clips/two.bin"]);

    const bytes = await fetch(urls["clips/one.bin"]!);
    expect(Buffer.from(await bytes.arrayBuffer()).toString()).toBe("clip-one");

    await appA.fetch("/app-data/files/clips/one.bin", { method: "DELETE" });
    await appA.fetch("/app-data/files/clips/two.bin", { method: "DELETE" });
  });

  it("400s a malformed subKeys list", async () => {
    for (const subKeys of [[], ["ok", 7], "clips/one.bin"]) {
      const res = await appA.fetch("/app-data/file-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subKeys }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("files plane refused for an app that declared files:false", async () => {
    // The presign route gates on filesEnabled before minting an upload token.
    const res = await appB.fetch("/app-data/files/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subKey: "x.bin", contentType: "application/octet-stream" }),
    });
    expect([400, 404]).toContain(res.status);
  });

  it("one app's files are invisible to another", async () => {
    await putAppFile(appA, "private.bin", "private");
    // app-b probing the same subKey resolves inside ITS namespace → absent
    // (and its files plane is disabled anyway).
    const res = await appB.fetch("/app-data/files/private.bin");
    expect([400, 404]).toContain(res.status);
  });
});

describe("GET /app-data/files — listing an app's own files", () => {
  interface Listing {
    files: Array<{
      sub_key: string;
      size_bytes: number;
      mime_type: string;
      original_filename: string | null;
      created_at: string;
    }>;
    truncated: boolean;
    page_token: string | null;
  }
  async function list(app: InstalledApp, query: string): Promise<Response> {
    return app.fetch(`/app-data/files?${query}`);
  }

  let started = 0;
  beforeAll(async () => {
    started = Date.now();
    await putAppFile(appA, "listing/b.json", "{}", "application/json");
    await putAppFile(appA, "listing/a.json", "{}", "application/json");
    await putAppFile(appA, "listing/c.json", "{}", "application/json");
    await putAppFile(appA, "elsewhere/z.bin", "z");
  });

  it("lists the files under a prefix in sub-key order, with their index facts", async () => {
    const res = await list(appA, "prefix=listing/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Listing;
    expect(body.files.map((f) => f.sub_key)).toEqual([
      "listing/a.json",
      "listing/b.json",
      "listing/c.json",
    ]);
    expect(body.files[0]).toMatchObject({ size_bytes: 2, mime_type: "application/json" });
    // The registering node's clock, read back as an instant: not merely a
    // parseable date, but this test's own minute.
    expect(Math.abs(Date.parse(body.files[0]!.created_at) - started)).toBeLessThan(60_000);
    expect(body.truncated).toBe(false);
    expect(body.page_token).toBeNull();
  });

  it("pages with limit and page_token", async () => {
    const first = (await (await list(appA, "prefix=listing/&limit=2")).json()) as Listing;
    expect(first.files.map((f) => f.sub_key)).toEqual(["listing/a.json", "listing/b.json"]);
    expect(first.truncated).toBe(true);
    const second = (await (
      await list(
        appA,
        `prefix=listing/&limit=2&page_token=${encodeURIComponent(first.page_token!)}`,
      )
    ).json()) as Listing;
    expect(second.files.map((f) => f.sub_key)).toEqual(["listing/c.json"]);
    expect(second.page_token).toBeNull();
  });

  it("drops a deleted file", async () => {
    await putAppFile(appA, "listing/gone.json", "{}", "application/json");
    await appA.fetch("/app-data/files/listing/gone.json", { method: "DELETE" });
    const body = (await (await list(appA, "prefix=listing/")).json()) as Listing;
    expect(body.files.map((f) => f.sub_key)).not.toContain("listing/gone.json");
  });

  it("lists every file without a prefix", async () => {
    const body = (await (await list(appA, "limit=500")).json()) as Listing;
    const keys = body.files.map((f) => f.sub_key);
    expect(keys).toContain("elsewhere/z.bin");
    expect(keys).toContain("listing/a.json");
  });

  it("lists the same files for a fully qualified prefix", async () => {
    // Every other file route accepts `apps/<appId>/<userId>/syncable/…` as
    // well as a bare sub-key, so the listing does too.
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
    let id: string;
    try {
      ({ id } = db
        .prepare("SELECT id FROM testapp_syncable__starkeep_sync_records WHERE id LIKE ?")
        .get("%/syncable/listing/a.json") as { id: string });
    } finally {
      db.close();
    }
    const qualified = id.slice(0, -"a.json".length);
    const body = (await (
      await list(appA, `prefix=${encodeURIComponent(qualified)}`)
    ).json()) as Listing;
    expect(body.files.map((f) => f.sub_key)).toEqual([
      "listing/a.json",
      "listing/b.json",
      "listing/c.json",
    ]);
  });

  it("refuses a prefix that would leave the app's namespace", async () => {
    expect((await list(appA, "prefix=../other")).status).toBe(400);
    expect((await list(appA, "prefix=/abs")).status).toBe(400);
  });

  it("answers 500 for a file row whose created_at is not an HLC", async () => {
    // The fault is the server's data, not the request, so the status is 500.
    await putAppFile(appA, "corrupt/x.json", "{}", "application/json");
    const table = "testapp_syncable__starkeep_sync_records";
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"));
    try {
      const { id, created_at: was } = db
        .prepare(`SELECT id, created_at FROM ${table} WHERE id LIKE ?`)
        .get("%/syncable/corrupt/x.json") as { id: string; created_at: string };
      db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(
        "2026-10-27T00:00:00.000Z",
        id,
      );
      try {
        const res = await list(appA, "prefix=corrupt/");
        expect(res.status).toBe(500);
        expect(((await res.json()) as { error: string }).error).toBe(
          `File index row ${id} has created_at "2026-10-27T00:00:00.000Z", not a serialized HLC`,
        );
      } finally {
        db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(was, id);
      }
    } finally {
      db.close();
    }
  });

  it("refuses an app that declared files:false", async () => {
    const res = await list(appB, "");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'App "app-b" did not opt in to syncable files',
    );
  });
});

describe("reserved sync-records table", () => {
  function tableNames(): string[] {
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"), { readOnly: true });
    try {
      return (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
    } finally {
      db.close();
    }
  }

  it("created only for apps that enabled files sync", async () => {
    const names = tableNames();
    expect(names).toContain("testapp_syncable__starkeep_sync_records"); // files: true
    expect(names).toContain("testapp_syncable_notes");
    expect(names).toContain("app_b_syncable_notes");
    expect(names.some((n) => n.startsWith("app_b_") && n.includes("_starkeep_sync_records"))).toBe(
      false,
    ); // files: false
  });
});
