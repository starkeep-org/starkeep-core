/**
 * Tier-1 watcher: a real watched temp directory driven through the
 * loopback-authorized /watches surface, with ingestion observed through the
 * Drive identity on the shared-records plane. (Plan §3 "Watcher".)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, appendFile, unlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { builtinAppCreds, eventually, listRecords, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let drive: InstalledApp;
let watchDir: string;
let watchId: string;

interface WatchStatus {
  id: string;
  directoryPath: string;
  state: string;
  totalFiles: number;
  syncedFiles: number;
  lastScanAt: string | null;
}

async function getWatches(s: LocalDataServer): Promise<WatchStatus[]> {
  const res = await fetch(`${s.url}/watches`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { watches: WatchStatus[] }).watches;
}

async function fileStatus(
  s: LocalDataServer,
  filePath: string,
): Promise<{ watched: boolean; synced: boolean; watchId?: string; recordId?: string }> {
  const res = await fetch(`${s.url}/watches/file-status?path=${encodeURIComponent(filePath)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { watched: boolean; synced: boolean; recordId?: string };
}

beforeAll(async () => {
  server = await startLocalDataServer();
  drive = await builtinAppCreds(server, "starkeep-drive");

  watchDir = await mkdtemp(join(tmpdir(), "starkeep-watch-"));
  await writeFile(join(watchDir, "a.jpg"), "jpeg-bytes-a");
  await mkdir(join(watchDir, "sub"));
  await writeFile(join(watchDir, "sub", "b.txt"), "text-bytes-b");
  // Default-excluded name and a caller-excluded pattern.
  await writeFile(join(watchDir, ".DS_Store"), "junk");
  await writeFile(join(watchDir, "skip.tmp"), "tmp-bytes");
  // Over the 100 MB ingest ceiling — sparse, so it costs nothing on disk.
  await writeFile(join(watchDir, "big.bin"), "");
  await truncate(join(watchDir, "big.bin"), 100 * 1024 * 1024 + 1);
}, 60_000);

afterAll(async () => {
  await server.stop();
  await rm(watchDir, { recursive: true, force: true });
});

describe("initial scan", () => {
  it("registers a watch and ingests the eligible files only", async () => {
    const res = await fetch(`${server.url}/watches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directoryPath: watchDir,
        recursive: true,
        excludePatterns: ["*.tmp"],
      }),
    });
    expect(res.status).toBe(200);
    const { watch } = (await res.json()) as { watch: WatchStatus };
    watchId = watch.id;
    expect(watch.state).toBe("watching");
    // a.jpg and sub/b.txt; .DS_Store and *.tmp excluded, big.bin skipped.
    expect(watch.totalFiles).toBe(2);
    expect(watch.syncedFiles).toBe(2);

    const records = await listRecords(drive);
    const names = records.map((r) => r.original_filename);
    expect(names).toContain("a.jpg");
    expect(names).toContain("b.txt");
    expect(names).not.toContain("skip.tmp");
    expect(names).not.toContain(".DS_Store");
    expect(names).not.toContain("big.bin");
  });

  it("rejects a duplicate watch for the same directory", async () => {
    const res = await fetch(`${server.url}/watches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directoryPath: watchDir }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects a watch for a missing directory", async () => {
    const res = await fetch(`${server.url}/watches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directoryPath: join(watchDir, "does-not-exist") }),
    });
    expect(res.status).toBe(400);
  });

  it("serves the watched file's bytes through the object store (symlink path)", async () => {
    const records = await listRecords(drive);
    const aRecord = records.find((r) => r.original_filename === "a.jpg")!;
    expect(aRecord).toBeDefined();

    const urlRes = await drive.fetch(`/data/records/${aRecord.id}/file-url`);
    expect(urlRes.status).toBe(200);
    const { url } = (await urlRes.json()) as { url: string };
    const bytes = await fetch(url);
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("jpeg-bytes-a");
  });

  it("reports file and directory watch status", async () => {
    const file = await fileStatus(server, join(watchDir, "a.jpg"));
    expect(file).toMatchObject({ watched: true, synced: true, watchId });
    expect(file.recordId).toBeTruthy();

    const dirRes = await fetch(
      `${server.url}/watches/directory-status?path=${encodeURIComponent(join(watchDir, "sub"))}`,
    );
    expect(await dirRes.json()).toMatchObject({ watched: true, watchId });

    const outside = await fileStatus(server, "/somewhere/else/file.jpg");
    expect(outside).toMatchObject({ watched: false, synced: false });
  });
});

describe("live filesystem events", () => {
  it("a file added on disk becomes a record", async () => {
    await writeFile(join(watchDir, "c.png"), "png-bytes-c");
    await eventually(async () => {
      const records = await listRecords(drive);
      expect(records.map((r) => r.original_filename)).toContain("c.png");
    });
  });

  it("a modified file is re-ingested under a new record", async () => {
    const before = await fileStatus(server, join(watchDir, "a.jpg"));
    await appendFile(join(watchDir, "a.jpg"), "-modified");
    await eventually(async () => {
      const after = await fileStatus(server, join(watchDir, "a.jpg"));
      expect(after.synced).toBe(true);
      expect(after.recordId).toBeTruthy();
      expect(after.recordId).not.toBe(before.recordId);
    });
    // The new record serves the new bytes.
    const after = await fileStatus(server, join(watchDir, "a.jpg"));
    const urlRes = await drive.fetch(`/data/records/${after.recordId}/file-url`);
    const { url } = (await urlRes.json()) as { url: string };
    expect(await (await fetch(url)).text()).toBe("jpeg-bytes-a-modified");
  });

  it("a file deleted on disk tombstones its record", async () => {
    const tracked = await fileStatus(server, join(watchDir, "c.png"));
    expect(tracked.recordId).toBeTruthy();
    await unlink(join(watchDir, "c.png"));
    await eventually(async () => {
      const records = await listRecords(drive);
      expect(records.map((r) => r.id)).not.toContain(tracked.recordId);
    });
  });

  it("excluded patterns are honored for files added after the scan", async () => {
    await writeFile(join(watchDir, "later.tmp"), "late-tmp");
    await writeFile(join(watchDir, "later.txt"), "late-txt");
    await eventually(async () => {
      const records = await listRecords(drive);
      expect(records.map((r) => r.original_filename)).toContain("later.txt");
    });
    const records = await listRecords(drive);
    expect(records.map((r) => r.original_filename)).not.toContain("later.tmp");
  });
});

describe("persistence across restart", () => {
  it("watches.json restores the watch and catches up on files added while down", async () => {
    await server.stopKeepData();
    await writeFile(join(watchDir, "offline.pdf"), "pdf-bytes-offline");

    server = await startLocalDataServer({ starkeepDir: server.starkeepDir });
    drive = await builtinAppCreds(server, "starkeep-drive");

    const watches = await getWatches(server);
    expect(watches.map((w) => w.id)).toContain(watchId);

    await eventually(async () => {
      const records = await listRecords(drive);
      expect(records.map((r) => r.original_filename)).toContain("offline.pdf");
    });
  });

  it("DELETE /watches/:id stops the watch and removes it from config", async () => {
    const res = await fetch(`${server.url}/watches/${watchId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await getWatches(server)).toEqual([]);

    // No longer watched: a new file does not become a record.
    await writeFile(join(watchDir, "after-stop.txt"), "ignored");
    await new Promise((r) => setTimeout(r, 500));
    const records = await listRecords(drive);
    expect(records.map((r) => r.original_filename)).not.toContain("after-stop.txt");
  });
});
