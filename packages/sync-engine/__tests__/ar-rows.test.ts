import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * AR — app-record rows (the reserved `_starkeep_sync_records` table in an
 * app's namespace). Covers cross-seed AR candidates:
 *
 *   S0-003, S0-004, S1-015..020, S2-008..011, S3-011/012/014, S4-006/007.
 */
describe("AR — app-record rows", () => {
  // ---- S0 baseline ----

  it("S0-003: clean AR local-insert with blob — app namespace happy path", async () => {
    const w = await setupCase({ dt: "AR", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert", withBlob: true });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S0-004: clean AR local-insert no blob — metadata-only app record", async () => {
    const w = await setupCase({ dt: "AR", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert", withBlob: false });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(false);
  });

  // ---- S1 presence × op ----

  it("S1-015: AR L-insert into neither (no blob) — both sides have row, no blob", async () => {
    const w = await setupCase({ dt: "AR", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert", withBlob: false });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("local")).toBe(true);
    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("local")).toBe(false);
    expect(await w.blobExists("cloud")).toBe(false);
  });

  it("S1-016: AR L-insert into neither (with blob) — both sides have row + blob", async () => {
    const w = await setupCase({ dt: "AR", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert", withBlob: true });
    await w.exchange({ rounds: 1 });
    expect(await w.blobExists("local")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S1-017: AR C-insert into neither (with blob) — mirror of S1-016", async () => {
    const w = await setupCase({ dt: "AR", presence: "neither" });
    await w.driveOperation({ side: "cloud", verb: "insert", withBlob: true });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(true);
  });

  it("S1-018: AR L-update on both-same — LWW; blob path tests app-namespace routing", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "local", verb: "update", withBlob: true });
    const localRow = await w.getAppRow("local");
    await w.exchange({ rounds: 1 });
    const cloudRow = await w.getAppRow("cloud");
    expect(cloudRow?.timestamp).toEqual(localRow!.timestamp);
    expect(cloudRow?.row?.["content_hash"]).toBe(
      localRow!.row?.["content_hash"],
    );
  });

  it("S1-019: AR C-update on both-diverged — LWW: cloud's later update wins", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-diverged",
      blob: "bb",
    });
    await w.driveOperation({ side: "cloud", verb: "update", withBlob: true });
    const cloudRow = await w.getAppRow("cloud");
    await w.exchange({ rounds: 1 });
    const localRow = await w.getAppRow("local");
    expect(localRow?.timestamp).toEqual(cloudRow!.timestamp);
    expect(localRow?.row?.["content_hash"]).toBe(
      cloudRow!.row?.["content_hash"],
    );
  });

  it("S1-020: AR L-soft-delete on both-same — cloud receives tombstone (app namespace)", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "local", verb: "soft-delete" });
    await w.exchange({ rounds: 1 });
    expect(await w.residency("cloud")).toBe("tombstoned");
    // Blobs retained.
    expect(await w.blobExists("local")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  // ---- S2 tombstones ----

  it("S2-008: AR cd + both-same — local applies tombstone (app namespace)", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-same",
      blob: "bb",
      tomb: "cd",
    });
    await w.exchange({ rounds: 1 });
    expect(await w.residency("local")).toBe("tombstoned");
    expect(await w.blobExists("local")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S2-009: AR ld + both-same — cloud applies tombstone", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-same",
      blob: "bb",
      tomb: "ld",
    });
    await w.exchange({ rounds: 1 });
    expect(await w.residency("cloud")).toBe("tombstoned");
  });

  it("S2-010: AR bd + both-diverged — later tombstone wins LWW", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-diverged",
      blob: "nb",
      tomb: "bd-diff-ts",
    });
    const localBefore = await w.getAppRow("local");
    await w.exchange({ rounds: 1 });
    const cloudAfter = await w.getAppRow("cloud");
    expect(cloudAfter?.timestamp).toEqual(localBefore!.timestamp);
  });

  it("S2-011: AR cdu + both-diverged (metadata only) — local update beats cloud delete", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-diverged",
      blob: "nb",
      tomb: "cdu",
    });
    const localBefore = await w.getAppRow("local");
    expect(localBefore?.op).toBe("insert");
    await w.exchange({ rounds: 1 });
    const cloudAfter = await w.getAppRow("cloud");
    expect(cloudAfter?.op).toBe("insert");
    expect(cloudAfter?.row?.["content_hash"]).toBe("sha256:local-updated");
  });

  // ---- S3 blob failure (AR variants) ----

  it("S3-011: AR lb + persistent upload-fails / 2r — record never ships (app namespace)", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "local-only",
      blob: "lb",
    });
    await w.exchange({
      rounds: 2,
      inject: { kind: "blob-upload-fails", recov: "persistent" },
    });
    expect(await w.recordExists("cloud")).toBe(false);
    expect(await w.blobExists("cloud")).toBe(false);
  });

  it("S3-012: AR cb + transient download-fails / 2r — round 2 pulls blob", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "cloud-only",
      blob: "cb",
    });
    await w.exchange({
      rounds: 2,
      inject: { kind: "blob-download-fails", recov: "transient" },
    });
    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(true);
  });

  it("S3-014: AR no-blob + no-failure / 1r — metadata-only app record syncs", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "local-only",
      blob: "nb",
    });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(false);
  });

  // ---- S4 watermark reset ----

  it("S4-006: AR lR + both-same — re-sync after local reset; no data drift", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-same",
      blob: "bb",
      wm: "lR",
    });
    const cloudBefore = await w.getAppRow("cloud");
    await w.exchange({ rounds: "until-converged" });
    expect(await w.getAppRow("cloud")).toEqual(cloudBefore);
  });

  it("S4-007: AR cR + both-same — local re-ships; cloud applies as no-op", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-same",
      blob: "bb",
      wm: "cR",
    });
    const cloudBefore = await w.getAppRow("cloud");
    await w.exchange({ rounds: "until-converged" });
    expect(await w.getAppRow("cloud")).toEqual(cloudBefore);
  });
});
