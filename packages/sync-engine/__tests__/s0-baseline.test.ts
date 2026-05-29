import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S0 — Baseline / regression-net cases (SR only).
 *
 * AR cases (S0-003, S0-004) and AW (S0-005) live in their own files once
 * the harness gains AR/AW seeding + driveOperation.
 */
describe("S0 — baseline (SR)", () => {
  it("S0-001: clean SR local-insert, no prior state — trivial happy path", async () => {
    const w = await setupCase({ dt: "SR", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert" });
    await w.exchange({ rounds: 1 });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S0-002: clean SR cloud-insert, no prior state — mirror", async () => {
    const w = await setupCase({ dt: "SR", presence: "neither" });
    await w.driveOperation({ side: "cloud", verb: "insert" });
    await w.exchange({ rounds: 1 });

    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(true);
  });

  it("S0-006: already-converged 1-round exchange — no-op", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      wm: "cur",
    });
    const [result] = await w.exchange({ rounds: 1 });
    expect(result!.applied).toBe(0);
    expect(result!.shipped).toBe(0);
    expect(result!.hasMore).toBe(false);
  });

  it("S0-007: already-converged 2-round exchange — idempotent no-op", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      wm: "cur",
    });
    const results = await w.exchange({ rounds: 2 });
    for (const r of results) {
      expect(r.applied).toBe(0);
      expect(r.shipped).toBe(0);
    }
    const wmBefore = await w.watermarks();
    await w.exchange({ rounds: 1 });
    const wmAfter = await w.watermarks();
    expect(wmAfter).toEqual(wmBefore);
  });

  it("S0-008: SR local-insert with wm=0 — fresh-start full sync", async () => {
    const w = await setupCase({ dt: "SR", presence: "neither", wm: "0" });
    await w.driveOperation({ side: "local", verb: "insert" });
    await w.exchange({ rounds: "until-converged" });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S0-009: SR local-insert after wm=cur — exchange adds only the new record", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      wm: "cur",
    });
    const originalId = w.subjectId;
    await w.driveOperation({ side: "local", verb: "insert" });
    const [result] = await w.exchange({ rounds: 1 });

    expect(result!.shipped).toBe(1);
    expect(result!.applied).toBe(0);

    // The pre-existing record is still there on both sides — no re-ship.
    expect(await w.recordExists("local", originalId)).toBe(true);
    expect(await w.recordExists("cloud", originalId)).toBe(true);
    // The new record landed on cloud.
    const newId = w.subjectIds[1]!;
    expect(await w.recordExists("cloud", newId)).toBe(true);
  });
});
