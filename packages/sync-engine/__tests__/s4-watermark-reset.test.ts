import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S4 — watermark reset × multi-homogeneous (SR single-record subset).
 *
 * Multi-record cases (S4-010 specifically, and the `until-converged` shape
 * of every other S4 candidate) currently exercise the engine on one record
 * because the harness doesn't yet seed batches. The invariants under test
 * (rebuild watermarks without data drift / re-ship after reset) still hold
 * at N=1; multi-record will be revisited when the seeding extension lands.
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

  it("S4-002: cR + both-same — local re-ships; cloud applies as no-op; no data drift", async () => {
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
});
