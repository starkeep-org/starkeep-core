import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S3 — multi-record blob-failure cases (SR).
 *
 * S3-005: per-nodeId contiguous-prefix rule under persistent mid-batch upload fail.
 * S3-006: same + transient → full convergence on retry.
 * S3-007: multi-mixed-nodes — failed nodeId's tail blocked; other nodeIds untouched.
 * S3-008: inbound mirror — own watermark advances only over contiguous successful prefix.
 */
describe("S3 — blob × failure (SR, multi-record)", () => {
  it("S3-005: multi-homogeneous + persistent middle upload-fails / 1r — prefix ships, tail blocked", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "multi-homogeneous",
      batchCount: 5,
    });
    await w.exchange({
      rounds: 1,
      inject: {
        kind: "blob-upload-fails",
        target: "middle",
        recov: "persistent",
      },
    });

    // r[0], r[1] (prefix before the failure) land on cloud.
    expect(await w.recordExists("cloud", w.subjectIds[0])).toBe(true);
    expect(await w.recordExists("cloud", w.subjectIds[1])).toBe(true);
    // r[2] (the failure) and r[3..4] (blocked tail) do not.
    expect(await w.recordExists("cloud", w.subjectIds[2])).toBe(false);
    expect(await w.recordExists("cloud", w.subjectIds[3])).toBe(false);
    expect(await w.recordExists("cloud", w.subjectIds[4])).toBe(false);

    // peerWatermark sits at r[1].
    const { peer } = await w.watermarks();
    const r1 = (await w.getRecord("local", w.subjectIds[1]))!;
    expect(peer[w.local.nodeId]).toEqual(r1.updatedAt);
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

  it("S3-007: multi-mixed-nodes + persistent same-nodeId mid-batch fail — other nodeId still ships", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "multi-mixed-nodes",
      batchCount: 6,
    });
    // subjectIds creation order alternates origin: [L0, C0, L1, C1, L2, C2].
    // Fail L1 (subjectIds[2]) specifically. The local-nodeId bucket is
    // [L0, L1, L2] in HLC order — L0 ships, L1 fails, L2 blocked.
    // The cloud-nodeId bucket [C0, C1, C2] is independent and all ships.
    const localIds = [w.subjectIds[0]!, w.subjectIds[2]!, w.subjectIds[4]!];
    const cloudIds = [w.subjectIds[1]!, w.subjectIds[3]!, w.subjectIds[5]!];
    const failingLocal = localIds[1]!;

    await w.exchange({
      rounds: 1,
      inject: {
        kind: "blob-upload-fails",
        target: { id: failingLocal },
        recov: "persistent",
      },
    });

    // Local-nodeId bucket: L0 lands, L1 blocked (failure), L2 blocked (tail).
    expect(await w.recordExists("cloud", localIds[0]!)).toBe(true);
    expect(await w.recordExists("cloud", failingLocal)).toBe(false);
    expect(await w.recordExists("cloud", localIds[2]!)).toBe(false);

    // Cloud-nodeId bucket: all three ship, unaffected by the local-nodeId failure.
    for (const id of cloudIds) {
      expect(await w.recordExists("cloud", id)).toBe(true);
      expect(await w.blobExists("cloud", w.objectKey(id))).toBe(true);
    }
  });

  it("S3-008: multi-homogeneous + persistent middle download-fails / 1r — own watermark contiguous-prefix", async () => {
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

    // Metadata for r[2] is applied locally before the blob pull is attempted,
    // and r[3..4] also get their metadata + blobs (only middle's download
    // fails). But the contiguous-prefix rule keeps ownWatermark behind r[2].
    expect(await w.blobExists("local", w.objectKey(w.subjectIds[0]))).toBe(
      true,
    );
    expect(await w.blobExists("local", w.objectKey(w.subjectIds[1]))).toBe(
      true,
    );
    expect(await w.blobExists("local", w.objectKey(w.subjectIds[2]))).toBe(
      false,
    );

    const { own } = await w.watermarks();
    // ownWatermark advanced over the contiguous prefix only — r[1]'s HLC.
    const r1 = (await w.getRecord("cloud", w.subjectIds[1]))!;
    expect(own[w.cloud.nodeId]).toEqual(r1.updatedAt);
  });
});
