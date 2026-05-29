import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S5 — concurrent updates × 2-round exchange.
 *
 * Implemented via two `driveOperation` calls before any exchange: the second
 * call's HLC is naturally later (shared wallclock advances) so the second
 * side wins LWW. To exercise both directions, swap the order.
 *
 * S5-011 (identical HLC tie-break) is the only candidate that needs raw HLC
 * construction — done at the end of this file by writing the records
 * directly with matched (wallTime, counter) but distinct nodeIds.
 */
describe("S5 — concurrent updates × 2 rounds", () => {
  // ---- SR ----

  it("S5-001: SR both-same + both-update (local later HLC) — local wins", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "cloud", verb: "update" });
    await w.driveOperation({ side: "local", verb: "update" });
    const localAfter = await w.getRecord("local");

    await w.exchange({ rounds: 2 });

    const cloudAfter = await w.getRecord("cloud");
    expect(cloudAfter?.updatedAt).toEqual(localAfter!.updatedAt);
    expect(cloudAfter?.contentHash).toBe("sha256:local-updated");
  });

  it("S5-002: SR both-same + both-update (cloud later HLC) — cloud wins", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "local", verb: "update" });
    await w.driveOperation({ side: "cloud", verb: "update" });
    const cloudAfter = await w.getRecord("cloud");

    await w.exchange({ rounds: 2 });

    const localAfter = await w.getRecord("local");
    expect(localAfter?.updatedAt).toEqual(cloudAfter!.updatedAt);
    expect(localAfter?.contentHash).toBe("sha256:cloud-updated");
  });

  it("S5-003: SR both-diverged + both-update — LWW winner persists; r2 no-op", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-diverged",
      blob: "bb",
    });
    await w.driveOperation({ side: "cloud", verb: "update" });
    await w.driveOperation({ side: "local", verb: "update" });
    const winnerHlc = (await w.getRecord("local"))!.updatedAt;

    const [, r2] = await w.exchange({ rounds: 2 });

    expect((await w.getRecord("cloud"))!.updatedAt).toEqual(winnerHlc);
    expect((await w.getRecord("local"))!.updatedAt).toEqual(winnerHlc);
    // r2 should be a no-op — convergence reached in r1.
    expect(r2!.applied).toBe(0);
  });

  it("S5-004: SR cdu — local-update beats cloud-delete (local later HLC)", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    await w.driveOperation({ side: "local", verb: "update" });

    await w.exchange({ rounds: 2 });

    const cloudAfter = await w.getRecord("cloud");
    expect(cloudAfter?.deletedAt).toBeNull();
    expect(cloudAfter?.contentHash).toBe("sha256:local-updated");
  });

  it("S5-005: SR cdu mirror — cloud-update beats local-delete", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "local", verb: "soft-delete" });
    await w.driveOperation({ side: "cloud", verb: "update" });

    await w.exchange({ rounds: 2 });

    const localAfter = await w.getRecord("local");
    expect(localAfter?.deletedAt).toBeNull();
    expect(localAfter?.contentHash).toBe("sha256:cloud-updated");
  });

  // ---- AR ----

  it("S5-006: AR both-same + both-update — LWW winner persists", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "cloud", verb: "update" });
    await w.driveOperation({ side: "local", verb: "update" });

    await w.exchange({ rounds: 1 });

    const cloudRow = await w.getAppRow("cloud");
    expect(cloudRow?.row?.["content_hash"]).toBe("sha256:local-updated");
  });

  it("S5-007: AR cdu mirror — cloud-update beats local-delete", async () => {
    const w = await setupCase({
      dt: "AR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "local", verb: "soft-delete" });
    await w.driveOperation({ side: "cloud", verb: "update" });

    await w.exchange({ rounds: 1 });

    const localRow = await w.getAppRow("local");
    expect(localRow?.op).toBe("insert");
    expect(localRow?.row?.["content_hash"]).toBe("sha256:cloud-updated");
  });

  // ---- AW ----

  it("S5-008: AW both-same + both-update — LWW on timestamp", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-same" });
    await w.driveOperation({ side: "cloud", verb: "update" });
    await w.driveOperation({ side: "local", verb: "update" });

    await w.exchange({ rounds: 1 });

    const cloudRow = await w.getAppRow("cloud");
    expect(cloudRow?.row?.["payload"]).toBe("local-updated");
  });

  it("S5-009: AW cdu mirror — cloud-update beats local-delete", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-same" });
    await w.driveOperation({ side: "local", verb: "soft-delete" });
    await w.driveOperation({ side: "cloud", verb: "update" });

    await w.exchange({ rounds: 1 });

    const localRow = await w.getAppRow("local");
    expect(localRow?.op).toBe("insert");
    expect(localRow?.row?.["payload"]).toBe("cloud-updated");
  });

  // ---- Blob conflict ----

  it("S5-010: SR both-update + blob change — LWW winner's contentHash persists", async () => {
    // Note: content-addressable storage means a *real* blob change would
    // produce a new object_storage_key per update, so "loser blob discarded"
    // at the storage layer is implicit (the loser's bytes live at the
    // loser's key, the record points at the winner's key). The harness
    // driveOperation reuses the original key, so we assert the metadata
    // outcome (winning contentHash) rather than blob byte equality.
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({
      side: "cloud",
      verb: "update",
      withBlob: true,
    });
    await w.driveOperation({
      side: "local",
      verb: "update",
      withBlob: true,
    });

    await w.exchange({ rounds: 2 });

    const cloudRecord = await w.getRecord("cloud");
    expect(cloudRecord?.contentHash).toBe("sha256:local-updated");
  });

  // ---- HLC tie-break ----

  it("S5-011: SR both-same + both-update at identical (wallTime, counter) — larger nodeId wins (local)", async () => {
    // Use the harness to bootstrap, then directly write two records with
    // matched (wallTime, counter) but different nodeIds. The harness's shared
    // wallclock can't naturally produce a tie because each clock.now() call
    // advances it.
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    const baseline = (await w.getRecord("local"))!;

    const tiedHlc = {
      wallTime: 9_999_999,
      counter: 7,
    };
    await w.local.db.put({
      ...baseline,
      updatedAt: { ...tiedHlc, nodeId: w.local.nodeId },
      contentHash: "sha256:tie-local",
    });
    await w.cloud.db.put({
      ...baseline,
      updatedAt: { ...tiedHlc, nodeId: w.cloud.nodeId },
      contentHash: "sha256:tie-cloud",
    });

    // Wipe any watermarks so both sides ship.
    await w.syncState.setWatermarks({});
    await w.syncState.setPeerWatermarks({});

    await w.exchange({ rounds: 1 });

    // `"local" > "cloud"` lexicographically, so compareHLC's nodeId tie-break
    // gives local the win on both sides.
    const cloudAfter = await w.getRecord("cloud");
    expect(cloudAfter?.contentHash).toBe("sha256:tie-local");
    const localAfter = await w.getRecord("local");
    expect(localAfter?.contentHash).toBe("sha256:tie-local");
  });
});
