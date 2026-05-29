import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * AW — app-syncable rows (non-reserved, DB-only). Covers:
 *
 *   S0-005, S1-021..025, S2-012..015, S4-008/009, S7-001..006.
 *
 * S7-007 (identical wallTime+counter tie-break) needs a custom clock setup
 * the harness doesn't yet expose; tracked as TODO.
 */
describe("AW — app-syncable rows", () => {
  // ---- S0 baseline ----

  it("S0-005: clean AW local-insert — DB-only happy path", async () => {
    const w = await setupCase({ dt: "AW", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert" });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("cloud")).toBe(true);
    const row = await w.getAppRow("cloud");
    expect(row?.row?.["payload"]).toBe("local-insert");
  });

  // ---- S1 presence × op ----

  it("S1-021: AW L-insert into neither — both sides have row", async () => {
    const w = await setupCase({ dt: "AW", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert" });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("local")).toBe(true);
    expect(await w.recordExists("cloud")).toBe(true);
  });

  it("S1-022: AW C-insert into neither — both sides have row", async () => {
    const w = await setupCase({ dt: "AW", presence: "neither" });
    await w.driveOperation({ side: "cloud", verb: "insert" });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("local")).toBe(true);
    expect(await w.recordExists("cloud")).toBe(true);
  });

  it("S1-023: AW L-update on both-same — LWW on timestamp", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-same" });
    await w.driveOperation({ side: "local", verb: "update" });
    const localRow = await w.getAppRow("local");
    await w.exchange({ rounds: 1 });
    const cloudRow = await w.getAppRow("cloud");
    expect(cloudRow?.timestamp).toEqual(localRow!.timestamp);
    expect(cloudRow?.row?.["payload"]).toBe("local-updated");
  });

  it("S1-024: AW C-update on both-diverged — LWW: cloud wins", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-diverged" });
    await w.driveOperation({ side: "cloud", verb: "update" });
    const cloudRow = await w.getAppRow("cloud");
    await w.exchange({ rounds: 1 });
    const localRow = await w.getAppRow("local");
    expect(localRow?.timestamp).toEqual(cloudRow!.timestamp);
    expect(localRow?.row?.["payload"]).toBe("cloud-updated");
  });

  it("S1-025: AW L-soft-delete on both-same — tombstone propagates", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-same" });
    await w.driveOperation({ side: "local", verb: "soft-delete" });
    await w.exchange({ rounds: 1 });
    expect(await w.residency("cloud")).toBe("tombstoned");
  });

  // ---- S2 tombstones ----

  it("S2-012: AW cd + both-same — local applies tombstone", async () => {
    const w = await setupCase({
      dt: "AW",
      presence: "both-same",
      tomb: "cd",
    });
    await w.exchange({ rounds: 1 });
    expect(await w.residency("local")).toBe("tombstoned");
  });

  it("S2-013: AW ld + both-same — cloud applies tombstone", async () => {
    const w = await setupCase({
      dt: "AW",
      presence: "both-same",
      tomb: "ld",
    });
    await w.exchange({ rounds: 1 });
    expect(await w.residency("cloud")).toBe("tombstoned");
  });

  it("S2-014: AW bd + both-diverged — later tombstone wins", async () => {
    const w = await setupCase({
      dt: "AW",
      presence: "both-diverged",
      tomb: "bd-diff-ts",
    });
    const localBefore = await w.getAppRow("local");
    await w.exchange({ rounds: 1 });
    const cloudAfter = await w.getAppRow("cloud");
    expect(cloudAfter?.timestamp).toEqual(localBefore!.timestamp);
  });

  it("S2-015: AW cdu + both-diverged — LWW on timestamp; local update beats cloud delete", async () => {
    const w = await setupCase({
      dt: "AW",
      presence: "both-diverged",
      tomb: "cdu",
    });
    await w.exchange({ rounds: 1 });
    const cloudAfter = await w.getAppRow("cloud");
    expect(cloudAfter?.op).toBe("insert");
    expect(cloudAfter?.row?.["payload"]).toBe("local-updated");
  });

  // ---- S4 watermark reset ----

  it("S4-008: AW lR + both-same — DB-only re-sync after local reset", async () => {
    const w = await setupCase({
      dt: "AW",
      presence: "both-same",
      wm: "lR",
    });
    const cloudBefore = await w.getAppRow("cloud");
    await w.exchange({ rounds: "until-converged" });
    expect(await w.getAppRow("cloud")).toEqual(cloudBefore);
  });

  it("S4-009: AW cR + both-same — local re-ships; no data drift", async () => {
    const w = await setupCase({
      dt: "AW",
      presence: "both-same",
      wm: "cR",
    });
    const cloudBefore = await w.getAppRow("cloud");
    await w.exchange({ rounds: "until-converged" });
    expect(await w.getAppRow("cloud")).toEqual(cloudBefore);
  });
});

describe("S7 — AW conflict-deleted-vs-updated", () => {
  it("S7-001: both-same, local-update wins (later HLC) — cloud accepts update, tombstone discarded", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-same" });
    // Cloud deletes first, then local updates — local's HLC is later.
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    await w.driveOperation({ side: "local", verb: "update" });
    await w.exchange({ rounds: 1 });
    const cloudAfter = await w.getAppRow("cloud");
    expect(cloudAfter?.op).toBe("insert");
    expect(cloudAfter?.row?.["payload"]).toBe("local-updated");
  });

  it("S7-002: both-same, cloud-delete wins (later HLC) — local accepts tombstone, update discarded", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-same" });
    // Local updates first, then cloud deletes — cloud's HLC is later.
    await w.driveOperation({ side: "local", verb: "update" });
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    await w.exchange({ rounds: 1 });
    expect(await w.residency("local")).toBe("tombstoned");
  });

  it("S7-003: both-diverged, local-update wins", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-diverged" });
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    await w.driveOperation({ side: "local", verb: "update" });
    await w.exchange({ rounds: 1 });
    const cloudAfter = await w.getAppRow("cloud");
    expect(cloudAfter?.op).toBe("insert");
    expect(cloudAfter?.row?.["payload"]).toBe("local-updated");
  });

  it("S7-004: both-diverged, cloud-delete wins", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-diverged" });
    await w.driveOperation({ side: "local", verb: "update" });
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    await w.exchange({ rounds: 1 });
    expect(await w.residency("local")).toBe("tombstoned");
  });

  it("S7-005: 2r idempotency — local-update wins, r2 is no-op", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-same" });
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    await w.driveOperation({ side: "local", verb: "update" });
    const [r1, r2] = await w.exchange({ rounds: 2 });
    expect(r1!.shipped + r1!.applied).toBeGreaterThan(0);
    // After r1 both sides are converged; r2 must be a no-op.
    expect(r2!.applied).toBe(0);
  });

  it("S7-006: 2r idempotency mirror — cloud-delete wins, r2 is no-op", async () => {
    const w = await setupCase({ dt: "AW", presence: "both-same" });
    await w.driveOperation({ side: "local", verb: "update" });
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    const [, r2] = await w.exchange({ rounds: 2 });
    expect(r2!.applied).toBe(0);
  });
});
