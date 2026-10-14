import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S3 — multi-record blob-failure cases (SR).
 *
 * S3-005: a persistent mid-batch upload failure — rows all ship, the peer's
 *         bytes watermark stops at the failed file.
 * S3-006: same + transient → full convergence on retry.
 * S3-007: multi-mixed-nodes — only the failed author's bytes watermark stops.
 * S3-008: inbound mirror — rows watermark passes every row, bytes watermark
 *         advances only over the contiguous run of landed files.
 */
describe("S3 — blob × failure (SR, multi-record)", () => {
  it("S3-005: multi-homogeneous + persistent middle upload-fails / 2r — every row ships, the peer's bytes watermark stops at the failure", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "multi-homogeneous",
      batchCount: 5,
    });
    // Two rounds: the cloud reports its bytes watermark at the start of the
    // exchange that follows an upload.
    await w.exchange({
      rounds: 2,
      inject: {
        kind: "blob-upload-fails",
        target: "middle",
        recov: "persistent",
      },
    });

    // Every row lands, the failure's included: rows no longer wait for files.
    for (const id of w.subjectIds) {
      expect(await w.recordExists("cloud", id)).toBe(true);
    }
    // Every file but the failing one arrives, the ones above it included.
    expect(await w.blobExists("cloud", w.objectKey(w.subjectIds[0]))).toBe(true);
    expect(await w.blobExists("cloud", w.objectKey(w.subjectIds[1]))).toBe(true);
    expect(await w.blobExists("cloud", w.objectKey(w.subjectIds[2]))).toBe(false);
    expect(await w.blobExists("cloud", w.objectKey(w.subjectIds[3]))).toBe(true);
    expect(await w.blobExists("cloud", w.objectKey(w.subjectIds[4]))).toBe(true);

    // Rows watermark at the last row; bytes watermark at the last file before
    // the hole, which is what keeps the failed upload owed.
    const { peer, peerBytes } = await w.watermarks();
    const r1 = (await w.getRecord("local", w.subjectIds[1]))!;
    const r4 = (await w.getRecord("local", w.subjectIds[4]))!;
    expect(peer[w.local.nodeId]).toEqual(r4.updatedAt);
    expect(peerBytes?.[w.local.nodeId]).toEqual(r1.updatedAt);
  });

  it("S3-006: multi-homogeneous + transient middle upload-fails / until-converged — full convergence", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "multi-homogeneous",
      batchCount: 5,
    });
    await w.exchange({
      rounds: "until-converged",
      inject: {
        kind: "blob-upload-fails",
        target: "middle",
        recov: "transient",
      },
    });

    for (const id of w.subjectIds) {
      expect(await w.recordExists("cloud", id)).toBe(true);
      expect(await w.blobExists("cloud", w.objectKey(id))).toBe(true);
    }
  });

  it("S3-007: multi-mixed-nodes + persistent same-nodeId mid-batch fail — only that author's bytes watermark stops", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "multi-mixed-nodes",
      batchCount: 6,
    });
    // subjectIds creation order alternates origin: [L0, C0, L1, C1, L2, C2].
    // Fail L1 (subjectIds[2]) specifically.
    const localIds = [w.subjectIds[0]!, w.subjectIds[2]!, w.subjectIds[4]!];
    const cloudIds = [w.subjectIds[1]!, w.subjectIds[3]!, w.subjectIds[5]!];
    const failingLocal = localIds[1]!;

    await w.exchange({
      rounds: 2,
      inject: {
        kind: "blob-upload-fails",
        target: { id: failingLocal },
        recov: "persistent",
      },
    });

    // Every row ships.
    for (const id of [...localIds, ...cloudIds]) {
      expect(await w.recordExists("cloud", id)).toBe(true);
    }
    // Local-nodeId bucket: L1's file is the only one missing.
    expect(await w.blobExists("cloud", w.objectKey(localIds[0]!))).toBe(true);
    expect(await w.blobExists("cloud", w.objectKey(failingLocal))).toBe(false);
    expect(await w.blobExists("cloud", w.objectKey(localIds[2]!))).toBe(true);
    // Cloud-nodeId bucket: unaffected by the local-nodeId failure.
    for (const id of cloudIds) {
      expect(await w.blobExists("cloud", w.objectKey(id))).toBe(true);
    }

    const { peerBytes } = await w.watermarks();
    const l0 = (await w.getRecord("local", localIds[0]!))!;
    const c2 = (await w.getRecord("local", cloudIds[2]!))!;
    expect(peerBytes?.[w.local.nodeId]).toEqual(l0.updatedAt);
    expect(peerBytes?.[w.cloud.nodeId]).toEqual(c2.updatedAt);
  });

  it("S3-008: multi-homogeneous + persistent middle download-fails / 1r — rows watermark passes, bytes watermark stops at the hole", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
      batch: "multi-homogeneous",
      batchCount: 5,
    });
    await w.exchange({
      rounds: 1,
      inject: {
        kind: "blob-download-fails",
        target: "middle",
        recov: "persistent",
      },
    });

    // Every row applies; every file but the middle one lands, later ones too.
    for (const id of w.subjectIds) {
      expect(await w.recordExists("local", id)).toBe(true);
    }
    expect(await w.blobExists("local", w.objectKey(w.subjectIds[0]))).toBe(true);
    expect(await w.blobExists("local", w.objectKey(w.subjectIds[1]))).toBe(true);
    expect(await w.blobExists("local", w.objectKey(w.subjectIds[2]))).toBe(false);
    expect(await w.blobExists("local", w.objectKey(w.subjectIds[3]))).toBe(true);
    expect(await w.blobExists("local", w.objectKey(w.subjectIds[4]))).toBe(true);

    const { own, ownBytes } = await w.watermarks();
    const r1 = (await w.getRecord("cloud", w.subjectIds[1]))!;
    const r4 = (await w.getRecord("cloud", w.subjectIds[4]))!;
    // The rows watermark passes every row, so the cloud sends none again.
    expect(own[w.cloud.nodeId]).toEqual(r4.updatedAt);
    // The bytes watermark stops before the missing file, so it stays owed.
    expect(ownBytes?.[w.cloud.nodeId]).toEqual(r1.updatedAt);
  });
});
