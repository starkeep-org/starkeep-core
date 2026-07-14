import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S4 — watermark reset (SR).
 *
 * `wm: "cR"` seeds the *real* post-cloud-redeploy watermark state: both maps
 * preserved, peerWatermarks still claiming the cloud holds everything. The
 * actual data loss is modeled separately via `world.wipeCloud()` — see the
 * S4-012+ redeploy-recovery cases, which are the regression tests for the
 * push-is-peer-authoritative fix (they hang forever shipping nothing if the
 * requester trusts its own cache instead of `responderWatermarks`).
 *
 * AR (S4-006/007) and AW (S4-008/009) live in their own files.
 */
describe("S4 — watermark reset (SR)", () => {
  it("S4-001: lR + both-same — local rebuilds watermarks; no data drift", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      wm: "lR",
    });
    const localBefore = await w.getRecord("local");
    const cloudBefore = await w.getRecord("cloud");

    await w.exchange({ rounds: "until-converged" });

    expect(await w.getRecord("local")).toEqual(localBefore);
    expect(await w.getRecord("cloud")).toEqual(cloudBefore);

    // Both watermark maps have been rebuilt for the record's nodeId.
    const { own, peer } = await w.watermarks();
    expect(own[w.local.nodeId]).toBeDefined();
    expect(peer[w.local.nodeId]).toBeDefined();
  });

  it("S4-002: cR + both-same — stale-high peer cache against an intact cloud is steady state; no spurious re-ship", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      wm: "cR",
    });
    const cloudBefore = await w.getRecord("cloud");

    await w.exchange({ rounds: "until-converged" });

    expect(await w.getRecord("cloud")).toEqual(cloudBefore);
    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeDefined();
  });

  it("S4-003: lR + local-only — cloud receives the data via re-ship after reset", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      wm: "lR",
    });
    expect(await w.recordExists("cloud")).toBe(false);

    await w.exchange({ rounds: "until-converged" });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S4-004: cR + cloud-only — local pulls data after cloud reset model", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
      wm: "cR",
    });
    expect(await w.recordExists("local")).toBe(false);

    await w.exchange({ rounds: "until-converged" });

    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(true);
  });

  it("S4-005: lR + both-diverged — LWW resolves and watermarks rebuild together", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-diverged",
      blob: "bb",
      wm: "lR",
    });
    // Cloud held the later HLC (seeded second under shared clock).
    const cloudBefore = await w.getRecord("cloud");

    await w.exchange({ rounds: "until-converged" });

    // After convergence the cloud version (later HLC) propagates to local
    // even though local had a different version pre-exchange.
    const localAfter = await w.getRecord("local");
    expect(localAfter?.updatedAt).toEqual(cloudBefore!.updatedAt);
    expect(localAfter?.contentHash).toBe(cloudBefore!.contentHash);
  });

  it("S4-010: lR + both-same + multi-homogeneous + 1r — first round picks up some but not all (hasMore semantics)", async () => {
    // Cap pageLimit at 2 so 5 records straddle multiple rounds. After lR
    // local has no watermarks; cloud's responder ships 2 records and signals
    // hasMore=true. We verify the single-round result rather than fully
    // converging.
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      wm: "lR",
      batch: "multi-homogeneous",
      batchCount: 5,
      pageLimit: 2,
    });
    const [result] = await w.exchange({ rounds: 1 });
    expect(result!.hasMore).toBe(true);
  });

  it("S4-011: cR + local-only — fresh-install full first sync", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      wm: "cR",
    });
    expect(await w.recordExists("cloud")).toBe(false);

    await w.exchange({ rounds: "until-converged" });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Redeploy-bug regressions (cloud-lost-after-sync): a fully-synced pair,
  // then the cloud is wiped while local's peerWatermarks still claim the
  // cloud holds everything. Recovery must be driven by the responder's
  // coverage report — local bookkeeping alone can never detect this state.
  // Before the peer-authoritative fix these tests fail: nothing ever ships
  // because every record is "covered" by the stale cache.
  // ---------------------------------------------------------------------

  it("S4-012: cloud-lost-after-sync (single) — wiped cloud recovers record + blob without a manual watermark clear", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      wm: "cR",
    });
    await w.wipeCloud();
    expect(await w.recordExists("cloud")).toBe(false);
    expect(await w.blobExists("cloud")).toBe(false);
    // The bug's precondition holds: local's cache still covers the record.
    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeDefined();

    await w.exchange({ rounds: "until-converged" });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
    expect(await w.getRecord("cloud")).toEqual(await w.getRecord("local"));
  });

  it("S4-013: cloud-lost-after-sync (multi, paginated) — full recovery across rounds", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      wm: "cR",
      batch: "multi-homogeneous",
      batchCount: 5,
      pageLimit: 2,
    });
    await w.wipeCloud();

    await w.exchange({ rounds: "until-converged" });

    for (const id of w.subjectIds) {
      expect(await w.recordExists("cloud", id)).toBe(true);
      expect(await w.blobExists("cloud", w.objectKey(id))).toBe(true);
    }
  });
});
