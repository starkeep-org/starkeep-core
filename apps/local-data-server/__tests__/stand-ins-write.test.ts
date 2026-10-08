/**
 * Writing stand-ins and fidelity through `POST /data/records`, end to end.
 *
 * The rules themselves are table-tested in protocol-primitives; this suite pins
 * that the server applies them — the right status, the right body, nothing
 * written on a refusal — and the two effects only a server has: recording the
 * original's fidelity as a platform write, and the 409 that names the stand-in
 * to reuse.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
/** Writes AVIF, cannot read the JPEG originals. */
let blindApp: InstalledApp;

beforeAll(async () => {
  server = await startLocalDataServer();
  app = await installApp(server, standInAppManifest());
  blindApp = await installApp(
    server,
    standInAppManifest({
      id: "blind",
      name: "Blind",
      infraRequirements: {
        fileAccess: [{ types: ["image/avif"], access: "readwrite", metadataWrite: false, rationale: "test" }],
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await server.stop();
});

async function getRecord(id: string): Promise<Record<string, unknown>> {
  const res = await app.fetch(`/data/records/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { record: Record<string, unknown> }).record;
}

async function original(over: Record<string, unknown> = {}): Promise<string> {
  const { status, body } = await registerWithBytes(app, {
    type: "image/jpeg",
    sizeBytes: BIG,
    fileName: `orig-${Math.random()}.jpg`,
    ...over,
  });
  expect(status, JSON.stringify(body)).toBeLessThan(300);
  return body.record!.id;
}

function standIn(parentId: string, role: string, fidelity: number, over: Record<string, unknown> = {}) {
  return registerWithBytes(app, {
    type: "image/avif",
    parentId,
    fileName: `${role}-${fidelity}`,
    standIn: { role, fidelity },
    ...over,
  });
}

describe("an original reporting its fidelity", () => {
  it("stores the fidelity on the record", async () => {
    const id = await original({ fidelity: 6000 });
    expect(await getRecord(id)).toMatchObject({ fidelity: 6000, stand_in_role: null });
  });

  it("refuses a fidelity outside the stand-in categories", async () => {
    const res = await registerWithBytes(
      await installApp(server, {
        id: "docs",
        name: "Docs",
        version: "1.0.0",
        tier: "community",
        infraRequirements: {
          fileAccess: [{ types: ["document/pdf"], access: "readwrite", metadataWrite: false, rationale: "t" }],
        },
      }),
      { type: "document/pdf", fidelity: 12 },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("fidelity-outside-stand-in-category");
  });

  it("refuses a fidelity on a derived record", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await registerWithBytes(app, { type: "image/jpeg", parentId: parent, fidelity: 640 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("fidelity-on-derived-record");
  });

  it("records a reported fidelity on bytes another registration left without one", async () => {
    const bytes = `shared-bytes-${Math.random()}`;
    const first = await registerWithBytes(app, { type: "image/jpeg", bytes, fileName: "same.jpg" });
    const second = await registerWithBytes(app, { type: "image/jpeg", bytes, fileName: "same.jpg", fidelity: 3000 });
    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
    expect(second.body.record!.id).toBe(first.body.record!.id);
    expect(await getRecord(first.body.record!.id)).toMatchObject({ fidelity: 3000 });
  });

  it("answers 409 for a dedup that reports a different fidelity", async () => {
    const bytes = `shared-bytes-${Math.random()}`;
    await registerWithBytes(app, { type: "image/jpeg", bytes, fileName: "x.jpg", fidelity: 3000 });
    const again = await registerWithBytes(app, { type: "image/jpeg", bytes, fileName: "x.jpg", fidelity: 3001 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("fidelity-mismatch");
  });
});

describe("a stand-in write", () => {
  it("records a smaller stand-in with its role and fidelity", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await standIn(parent, "smaller", 640);
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ stand_in_role: "smaller", fidelity: 640, parent_id: parent });
  });

  it("records a canonical stand-in at the threshold", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await standIn(parent, "canonical", 4272);
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ stand_in_role: "canonical", fidelity: 4272 });
  });

  it("records the original's fidelity from the first stand-in, as a platform write", async () => {
    const parent = await original();
    const before = await getRecord(parent);
    expect(before.fidelity).toBeNull();
    const res = await standIn(parent, "smaller", 320, { parentFidelity: 5000 });
    expect(res.status).toBe(200);
    const after = await getRecord(parent);
    expect(after.fidelity).toBe(5000);
    expect(after.version).toBe((before.version as number) + 1);
    expect(after.updated_at >= (before.updated_at as string)).toBe(true);
  });

  it("requires the original's fidelity", async () => {
    const parent = await original();
    const res = await standIn(parent, "smaller", 320);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("parent-fidelity-unknown");
  });

  it("answers 409 for a reported fidelity that disagrees with the recorded one", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await standIn(parent, "smaller", 320, { parentFidelity: 5999 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("parent-fidelity-mismatch");
  });

  it("refuses a disallowed format", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await registerWithBytes(app, {
      type: "image/jpeg",
      parentId: parent,
      standIn: { role: "smaller", fidelity: 640 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("type-not-allowed");
  });

  it("refuses a size off the standard set", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await standIn(parent, "smaller", 512);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("not-a-standard-size");
  });

  it("refuses a canonical stand-in for a self-canonical original", async () => {
    const parent = await original({ fidelity: 3000 });
    const res = await standIn(parent, "canonical", 3000);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("original-takes-no-canonical");
  });

  it("refuses a canonical stand-in for an original under the size floor", async () => {
    const parent = await registerWithBytes(app, { type: "image/jpeg", fidelity: 8000 });
    const res = await standIn(parent.body.record!.id, "canonical", 4272);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("original-takes-no-canonical");
  });

  it("refuses a smaller stand-in at or above a self-canonical original's own fidelity", async () => {
    const parent = await original({ fidelity: 2000 });
    const res = await standIn(parent, "smaller", 2560);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("exceeds-canonical");
  });

  it("refuses a stand-in for another stand-in", async () => {
    const parent = await original({ fidelity: 6000 });
    const canonical = await standIn(parent, "canonical", 4272);
    const res = await standIn(canonical.body.record!.id, "smaller", 640);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("parent-is-stand-in");
  });

  it("answers 404 for a missing original", async () => {
    const res = await standIn("01NOSUCHRECORD000000000000", "smaller", 640);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("parent-not-found");
  });

  it("answers 404 when the writer cannot read the original", async () => {
    const parent = await original({ fidelity: 6000 });
    const res = await registerWithBytes(blindApp, {
      type: "image/avif",
      parentId: parent,
      standIn: { role: "smaller", fidelity: 640 },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("parent-not-found");
  });

  it("answers 409 with the existing stand-in when the slot is taken", async () => {
    const parent = await original({ fidelity: 6000 });
    const first = await standIn(parent, "smaller", 640);
    const second = await standIn(parent, "smaller", 640, { bytes: "different encoder output" });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "StandInExists", existing: first.body.record!.id });

    const canonical = await standIn(parent, "canonical", 4272);
    const again = await standIn(parent, "canonical", 4272, { bytes: "another canonical" });
    expect(again.status).toBe(409);
    expect(again.body.existing).toBe(canonical.body.record!.id);
  });

  it("returns an identical retry as a dedup rather than a conflict", async () => {
    const parent = await original({ fidelity: 6000 });
    const first = await standIn(parent, "smaller", 640, { bytes: "same" });
    const retry = await standIn(parent, "smaller", 640, { bytes: "same" });
    expect(retry.status).toBe(200);
    expect(retry.body.deduped).toBe(true);
    expect(retry.body.record!.id).toBe(first.body.record!.id);
  });

  it("refuses a top-level fidelity on a stand-in and a parentFidelity without one", async () => {
    const parent = await original({ fidelity: 6000 });
    const a = await standIn(parent, "smaller", 640, { fidelity: 640 });
    expect(a.status).toBe(400);
    expect(a.body.code).toBe("fidelity-on-stand-in");
    const b = await registerWithBytes(app, { type: "image/jpeg", parentFidelity: 5 });
    expect(b.status).toBe(400);
    expect(b.body.code).toBe("parent-fidelity-without-stand-in");
  });

  it("writes nothing on a refusal", async () => {
    const parent = await original();
    await standIn(parent, "smaller", 512, { parentFidelity: 6000 });
    // The fidelity rode a refused write, so it must not have landed.
    expect((await getRecord(parent)).fidelity).toBeNull();
  });

  it("refuses per-category metadata on a stand-in, through either door", async () => {
    const parent = await original({ fidelity: 6000 });
    const inline = await standIn(parent, "smaller", 640, { metadata: { width: 640, height: 480 } });
    expect(inline.status).toBe(400);
    expect(inline.body.error).toBe("StandInMetadata");

    const small = await standIn(parent, "smaller", 640);
    const later = await app.fetch(`/data/records/${small.body.record!.id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image", metadata: { width: 640 } }),
    });
    expect(later.status).toBe(400);
    expect(((await later.json()) as { error: string }).error).toBe("StandInMetadata");
  });

  it("takes a video canonical stand-in at the original's own bitrate", async () => {
    const parent = await registerWithBytes(app, {
      type: "video/mp4",
      sizeBytes: BIG,
      fidelity: 3000,
      fileName: "clip.mp4",
    });
    const res = await registerWithBytes(app, {
      type: "video/webm",
      parentId: parent.body.record!.id,
      standIn: { role: "canonical", fidelity: 3000 },
    });
    expect(res.status).toBe(200);
  });

  it("stores no canonical stand-in that is no smaller than its original, and marks the original", async () => {
    const parent = await registerWithBytes(app, {
      type: "video/mp4",
      sizeBytes: BIG,
      fidelity: 3000,
      fileName: "low-bitrate.mp4",
    });
    const id = parent.body.record!.id;
    const res = await registerWithBytes(app, {
      type: "video/webm",
      parentId: id,
      sizeBytes: BIG,
      standIn: { role: "canonical", fidelity: 3000 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ selfCanonical: true, original: { id, self_canonical: true } });
    expect(res.body.record).toBeUndefined();
    expect(await getRecord(id)).toMatchObject({ self_canonical: true, fidelity: 3000 });

    // It stands in for itself now, so no canonical stand-in is taken.
    const again = await registerWithBytes(app, {
      type: "video/webm",
      parentId: id,
      standIn: { role: "canonical", fidelity: 3000 },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("original-takes-no-canonical");
  });
});

describe("the canonical threshold stamp", () => {
  it("stamps an original that reports its fidelity with the threshold it is judged by", async () => {
    const parent = await original({ fidelity: 6000 });
    expect(await getRecord(parent)).toMatchObject({ fidelity: 6000, canonical_threshold: 4272 });
  });

  it("leaves an original with no fidelity unstamped, and stamps it with the first report", async () => {
    const parent = await original();
    expect((await getRecord(parent)).canonical_threshold).toBeNull();
    await standIn(parent, "smaller", 320, { parentFidelity: 5000 });
    expect(await getRecord(parent)).toMatchObject({ fidelity: 5000, canonical_threshold: 4272 });
  });

  it("stamps an original whose fidelity is reported after the fact", async () => {
    const parent = await original();
    const res = await app.fetch(`/data/records/${parent}/fidelity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fidelity: 5000 }),
    });
    expect(await res.json()).toMatchObject({ fidelity: 5000, canonical_threshold: 4272, recorded: true });
  });
});

describe("POST /data/records/:id/fidelity", () => {
  async function report(actor: InstalledApp, id: string, fidelity: unknown) {
    const res = await actor.fetch(`/data/records/${id}/fidelity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fidelity }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("records an original's fidelity after the fact, once", async () => {
    const id = await original();
    const first = await report(app, id, 300);
    expect(first).toMatchObject({ status: 200, body: { fidelity: 300, recorded: true } });
    expect(await getRecord(id)).toMatchObject({ fidelity: 300 });
    const again = await report(app, id, 300);
    expect(again.body.recorded).toBe(false);
    expect((await report(app, id, 301)).status).toBe(409);
  });

  it("lets a small original the watcher registered stand in for itself", async () => {
    const small = await registerWithBytes(app, { type: "image/jpeg", fileName: "tiny.jpg" });
    const id = small.body.record!.id;
    await report(app, id, 200);
    const where = encodeURIComponent(JSON.stringify({ id }));
    const res = await app.fetch(`/data/records?where=${where}`);
    const record = ((await res.json()) as { records: Array<{ stand_ins: { status: string; top: number } }> }).records[0]!;
    expect(record.stand_ins).toMatchObject({ status: "self-canonical", top: 200 });
  });

  it("refuses a stand-in, a derived record, a missing fidelity and a missing record", async () => {
    const parent = await original({ fidelity: 6000 });
    const small = await standIn(parent, "smaller", 640);
    expect((await report(app, small.body.record!.id, 640)).status).toBe(400);
    const derived = await registerWithBytes(app, { type: "image/jpeg", parentId: parent });
    expect((await report(app, derived.body.record!.id, 10)).body.code).toBe("fidelity-on-derived-record");
    expect((await report(app, parent, null)).status).toBe(400);
    expect((await report(app, "01NOSUCHRECORD000000000000", 5)).status).toBe(404);
  });

  it("takes a metadataWrite grant", async () => {
    const id = await original();
    expect((await report(blindApp, id, 300)).status).toBe(403);
  });
});

describe("restoring a stand-in", () => {
  it("answers 409 when another stand-in has taken its slot since the delete", async () => {
    const parent = await original({ fidelity: 6000 });
    const first = await standIn(parent, "smaller", 640);
    const firstId = first.body.record!.id;
    expect((await app.fetch(`/data/records/${firstId}`, { method: "DELETE" })).status).toBe(200);
    const second = await standIn(parent, "smaller", 640, { bytes: "a newer encoder" });
    expect(second.status).toBe(200);

    const res = await app.fetch(`/data/records/${firstId}/restore`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "SlotTaken" });
    // The refusal writes nothing: the first stays deleted, and the second keeps the slot.
    expect((await app.fetch(`/data/records/${firstId}`)).status).toBe(404);
    expect(await getRecord(second.body.record!.id)).toMatchObject({ stand_in_role: "smaller" });
  });
});
