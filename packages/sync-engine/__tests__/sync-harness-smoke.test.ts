import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

describe("sync test harness — smoke", () => {
  it("S0-001: SR / neither + local-insert / 1r → both sides have record + blob", async () => {
    const w = await setupCase({ dt: "SR", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert" });
    await w.exchange({ rounds: 1 });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);

    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeDefined();
  });

  it("S2-001: SR / cloud-only + cloud-deleted / 1r → local receives tombstone", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
      tomb: "cd",
    });
    await w.exchange({ rounds: 1 });

    const local = await w.getRecord("local");
    expect(local).not.toBeNull();
    expect(local?.deletedAt).not.toBeNull();
  });

  it("S1-007: SR / both-diverged + local-update / 1r → local update wins (later HLC)", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-diverged",
      blob: "bb",
    });

    await w.driveOperation({ side: "local", verb: "update", withBlob: true });
    const localAfterUpdate = await w.getRecord("local");
    expect(localAfterUpdate).not.toBeNull();

    await w.exchange({ rounds: 1 });

    const cloudCopy = await w.getRecord("cloud");
    expect(cloudCopy?.updatedAt).toEqual(localAfterUpdate!.updatedAt);
    expect(cloudCopy?.contentHash).toBe(localAfterUpdate!.contentHash);
  });

  it("S3-001: SR / local-only + persistent blob-upload-fails / 2r → record never ships, watermark stays empty", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });

    await w.exchange({
      rounds: 2,
      inject: { kind: "blob-upload-fails", recov: "persistent" },
    });

    expect(await w.recordExists("cloud")).toBe(false);
    expect(await w.blobExists("cloud")).toBe(false);

    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeUndefined();
  });

  it("S3-002: SR / local-only + transient blob-upload-fails / 2r → round 2 succeeds, record converges", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });

    await w.exchange({
      rounds: 2,
      inject: { kind: "blob-upload-fails", recov: "transient" },
    });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);

    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeDefined();
  });
});
