/**
 * "Replace existing canonical stand-ins", end to end on one desktop.
 *
 * The restamp rules are table-tested in shared-space-api; this pins that the
 * daemon runs them as a job over the whole library, reports its progress, and
 * resumes an unfinished job after a restart. No cloud is configured, so the
 * desktop is the whole library and knows its own value.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { builtinAppCreds, registerWithBytes, type InstalledApp } from "./helpers.js";

const BIG = 2 * 1024 * 1024;

let server: LocalDataServer;
let drive: InstalledApp;

beforeAll(async () => {
  server = await startLocalDataServer();
  drive = await builtinAppCreds(server, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

async function register(over: Record<string, unknown>): Promise<string> {
  const { status, body } = await registerWithBytes(drive, over as never);
  expect(status, JSON.stringify(body)).toBeLessThan(300);
  return body.record!.id;
}

async function record(id: string): Promise<Record<string, unknown>> {
  const res = await drive.fetch(`/data/records/${id}`);
  return ((await res.json()) as { record: Record<string, unknown> }).record;
}

async function liveStandIns(parentId: string): Promise<Array<[string, number]>> {
  const where = encodeURIComponent(JSON.stringify({ parent_id: parentId }));
  const res = await drive.fetch(`/data/records?where=${where}&include=stand-ins`);
  const { records } = (await res.json()) as { records: Array<{ stand_in_role: string; fidelity: number }> };
  return records.map((r) => [r.stand_in_role, r.fidelity] as [string, number]).sort((a, b) => a[1] - b[1]);
}

async function residency(): Promise<{
  restamp: { running: boolean; total: number; restamped: number; promoted: number } | null;
  earlierThreshold: Record<string, number>;
  backlog: Record<string, { count: number }>;
}> {
  return (await (await fetch(`${server.url}/residency/stand-ins`)).json()) as never;
}

async function finished(): Promise<NonNullable<Awaited<ReturnType<typeof residency>>["restamp"]>> {
  for (let i = 0; i < 100; i++) {
    const { restamp } = await residency();
    if (restamp && !restamp.running) return restamp;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the replacement job did not finish");
}

/**
 * An original stamped at the library's current value, with its canonical
 * stand-in at that value and one smaller stand-in.
 */
async function photographWithStandIns(name: string, canonical: number, smaller: number): Promise<string> {
  const id = await register({ type: "image/jpeg", sizeBytes: BIG, fidelity: 6000, fileName: `${name}.jpg` });
  for (const [role, fidelity] of [["canonical", canonical], ["smaller", smaller]] as const) {
    await register({
      type: "image/avif",
      parentId: id,
      fileName: `${name}-${fidelity}`,
      standIn: { role, fidelity },
    });
  }
  return id;
}

describe("replacing existing canonical stand-ins", () => {
  it("saves a lower value without touching existing originals unless asked", async () => {
    const kept = await photographWithStandIns("kept", 4272, 2560);
    const res = await fetch(`${server.url}/library/stand-in-standards`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ standIns: { image: { canonicalThreshold: 3200 } } }),
    });
    expect(((await res.json()) as { restamp: unknown }).restamp).toBeNull();
    expect((await record(kept)).canonical_threshold).toBe(4272);
    expect((await residency()).earlierThreshold.image).toBe(1);
  });

  it("describes the impact before replacing", async () => {
    const res = await fetch(`${server.url}/library/stand-in-standards/impact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ standIns: { image: { canonicalThreshold: 2560 } } }),
    });
    const { impact } = (await res.json()) as { impact: Record<string, unknown> };
    expect(impact.image).toMatchObject({ restamp: 1, promoted: 1, fromCanonical: 0 });
  });

  it("restamps every existing original and promotes a smaller stand-in at the new value", async () => {
    const second = await photographWithStandIns("second", 3200, 2560);
    const res = await fetch(`${server.url}/library/stand-in-standards`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ standIns: { image: { canonicalThreshold: 2560 } }, replaceExisting: ["image"] }),
    });
    expect(res.status).toBe(200);
    const job = await finished();
    expect(job).toMatchObject({ total: 2, restamped: 2, promoted: 2 });
    expect((await record(second)).canonical_threshold).toBe(2560);
    expect(await liveStandIns(second)).toEqual([["canonical", 2560]]);
    expect((await residency()).earlierThreshold.image).toBe(0);
  });

  it("refuses a replaceExisting it cannot read", async () => {
    const res = await fetch(`${server.url}/library/stand-in-standards`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ standIns: {}, replaceExisting: ["audio"] }),
    });
    expect(res.status).toBe(422);
  });

  it("resumes an unfinished job after a restart", async () => {
    const third = await photographWithStandIns("third", 2560, 1280);
    await fetch(`${server.url}/library/stand-in-standards`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ standIns: { image: { canonicalThreshold: 5120 } } }),
    });
    await server.stopKeepData();

    // A job the previous process started and never finished.
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"));
    const current = (await import("@starkeep/protocol-primitives")).standardsFromSettings({
      standIns: { image: { canonicalThreshold: 5120 } },
    });
    db.prepare(
      `INSERT INTO library_restamp_job (id, categories_json, standards_json, cursor, total, restamped, promoted, started_at, finished_at)
       VALUES ('current', ?, ?, NULL, 3, 0, 0, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET categories_json = excluded.categories_json, standards_json = excluded.standards_json,
         cursor = NULL, total = 3, restamped = 0, promoted = 0, started_at = excluded.started_at, finished_at = NULL`,
    ).run(JSON.stringify(["image"]), JSON.stringify(current), new Date().toISOString());
    db.close();

    server = await startLocalDataServer({ starkeepDir: server.starkeepDir });
    drive = await builtinAppCreds(server, "starkeep-drive");
    const job = await finished();
    expect(job.restamped).toBe(3);
    expect((await record(third)).canonical_threshold).toBe(5120);
  });
});
