/**
 * The local archive gate.
 *
 * This route existed only on the cloud data server, and every local derivation
 * logged a 404 against it. That was survivable while the cloud did the
 * deriving; it stops being survivable when the node that completes a ladder is
 * the machine holding the bytes, because the gate is the only way an original
 * is ever marked archivable.
 *
 * The decision is deliberately split between two parties that can each only
 * refuse: the app asserts its ladder is complete — only Photos knows what
 * complete means — and the platform applies its own floors. Neither alone can
 * freeze anything, which is what these assertions are about.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { installApp, testAppManifest, createRecordWithBytes, type InstalledApp } from "./helpers.js";

let server: LocalDataServer;
let app: InstalledApp;

// Above the archive floor, so the size refusal is not what is being measured.
const BIG = Buffer.alloc(2 * 1024 * 1024, "p");
const SMALL = Buffer.from("too small to be worth freezing");

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, testAppManifest());
}, 60_000);

afterAll(async () => {
  await server.stop();
});

const gate = (id: string, body: unknown) =>
  app.fetch(`/data/records/${id}/archive-gate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function storedTags(key: string): Promise<Record<string, string> | undefined> {
  const sidecar = join(server.starkeepDir, "objects", `${key}.meta.json`);
  const parsed = JSON.parse(await readFile(sidecar, "utf8")) as { tags?: Record<string, string> };
  return parsed.tags;
}

describe("asserting a complete ladder", () => {
  it("tags the object, and says it tagged rather than transitioned", async () => {
    const { record } = await createRecordWithBytes(app, { bytes: BIG, fileName: "big.jpg" });
    const res = await gate(record.id, { ladderComplete: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tagged: boolean; archived: boolean; refusals: string[] };
    expect(body.tagged).toBe(true);
    // Tagging is not transitioning. A lifecycle rule performs the move after
    // the hold period, which is what buys a week to catch a derivation bug
    // before the input is behind a 48-hour thaw.
    expect(body.archived).toBe(false);
    expect(body.refusals).toEqual([]);

    const tags = await storedTags(record.object_storage_key as string);
    expect(tags?.["starkeep:intent"]).toBe("archive");
    expect(tags?.["starkeep:ladder"]).toBe("complete");
  }, 30_000);

  it("is idempotent, so a sweep may call it after every pass", async () => {
    const { record } = await createRecordWithBytes(app, { bytes: BIG, fileName: "again.jpg" });
    await gate(record.id, { ladderComplete: true });
    const second = await gate(record.id, { ladderComplete: true });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { tagged: boolean }).tagged).toBe(true);
  }, 30_000);
});

describe("what the gate refuses", () => {
  it("refuses when the app does not assert a complete ladder", async () => {
    const { record } = await createRecordWithBytes(app, { bytes: BIG, fileName: "partial.jpg" });
    const body = (await (await gate(record.id, {})).json()) as {
      tagged: boolean;
      refusals: string[];
    };
    expect(body.tagged).toBe(false);
    expect(body.refusals.join(" ")).toContain("ladderComplete");
    // And nothing was tagged — a refusal must not half-apply. The sidecar
    // itself exists from the upload; what must be absent is the tags on it.
    expect(await storedTags(record.object_storage_key as string)).toBeUndefined();
  }, 30_000);

  it("refuses an object too small for archiving to pay for itself", async () => {
    const { record } = await createRecordWithBytes(app, { bytes: SMALL, fileName: "tiny.jpg" });
    const body = (await (await gate(record.id, { ladderComplete: true })).json()) as {
      tagged: boolean;
      refusals: string[];
    };
    // The app was right and the platform still said no. Each side can only
    // refuse, and this is the platform exercising its half.
    expect(body.tagged).toBe(false);
    expect(body.refusals.join(" ")).toContain("floor");
  }, 30_000);

  it("404s a record that does not exist", async () => {
    const res = await gate("no-such-record", { ladderComplete: true });
    expect(res.status).toBe(404);
  }, 30_000);
});
