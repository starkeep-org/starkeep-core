import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S3 — blob state × failure mode (SR single-record subset).
 *
 * Multi-record cases (S3-005..008) need the harness's multi-record seeding.
 * AR variants (S3-011..014) need AR seeding.
 */
describe("S3 — blob × failure (SR, single)", () => {
  it("S3-001: lb + persistent upload-fails / 2r — record never ships; watermark unchanged", async () => {
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

  it("S3-002: lb + transient upload-fails / 2r — round 2 succeeds; convergence reached", async () => {
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

  it("S3-003: cb + persistent download-fails / 2r — local metadata applied, own watermark behind", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
    });
    await w.exchange({
      rounds: 2,
      inject: { kind: "blob-download-fails", recov: "persistent" },
    });

    // Metadata applied locally — the engine puts the snapshot before pulling the blob.
    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(false);
    // Own watermark stays behind the failed record so next round re-pulls.
    const { own } = await w.watermarks();
    expect(own[w.cloud.nodeId]).toBeUndefined();
  });

  it("S3-004: cb + transient download-fails / 2r — round 2 pulls blob, advances watermark", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
    });
    await w.exchange({
      rounds: 2,
      inject: { kind: "blob-download-fails", recov: "transient" },
    });

    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(true);
    const { own } = await w.watermarks();
    expect(own[w.cloud.nodeId]).toBeDefined();
  });

  it("S3-009: nh (neither has blob) + no-failure / 1r — record cannot ship; watermark unchanged", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "nh",
    });
    // Local has the record row but no blob bytes (both sides Staged for it).
    // pushBlobIfNeeded → transferFile → source.get returns null → false →
    // record metadata is excluded from the outbound batch.
    await w.exchange({ rounds: 1 });

    expect(await w.recordExists("cloud")).toBe(false);
    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeUndefined();
  });

  it("S3-010: bb (both have blob) + no-failure / 1r — both Resident; no transfer needed", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.exchange({ rounds: 1 });

    expect(await w.residency("local")).toBe("resident");
    expect(await w.residency("cloud")).toBe("resident");
  });

  it("S3-015: lb + no-failure / 2r — Absent→Resident on cloud after r1; r2 is no-op", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });
    expect(await w.residency("cloud")).toBe("absent");

    const [r1] = await w.exchange({ rounds: 1 });
    expect(r1!.shipped).toBe(1);
    expect(await w.residency("cloud")).toBe("resident");

    const [r2] = await w.exchange({ rounds: 1 });
    expect(r2!.shipped).toBe(0);
    expect(r2!.applied).toBe(0);
    expect(await w.residency("cloud")).toBe("resident");
  });
});
