import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S6 — exceeds-page-limit × until-converged (SR subset).
 *
 * Strategy: cap `pageLimit` small (5) and seed a slightly larger batch (6)
 * so pagination kicks in. The invariants — `hasMore`, multi-round resume,
 * no dupes, watermark fan-out — are exercised at full fidelity without
 * seeding thousands of rows.
 *
 * AR (S6-006) and AW (S6-007) pagination need AR/AW multi-record seeding,
 * which isn't yet wired; tracked as TODO.
 *
 * S6-003 (partial-response-truncated + transient) is essentially redundant
 * with S6-001 in our in-process model — the truncation is what the engine
 * already does when more records exist than fit in one response.
 */
describe("S6 — pagination / exceeds-page-limit (SR)", () => {
  it("S6-001: local-originated 6 records, pageLimit=5, until-converged — all land, no dupes", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "exceeds-page-limit",
      batchCount: 6,
      pageLimit: 5,
    });

    await w.exchange({ rounds: "until-converged" });

    for (const id of w.subjectIds) {
      expect(await w.recordExists("cloud", id)).toBe(true);
      expect(await w.blobExists("cloud", w.objectKey(id))).toBe(true);
    }

    // Final peerWatermark sits at the last record's HLC (highest local HLC
    // among the 6).
    const last = (await w.getRecord("local", w.subjectIds[5]))!;
    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toEqual(last.updatedAt);
  });

  it("S6-002: cloud-originated 6 records, pageLimit=5, until-converged — mirror", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
      batch: "exceeds-page-limit",
      batchCount: 6,
      pageLimit: 5,
    });

    await w.exchange({ rounds: "until-converged" });

    for (const id of w.subjectIds) {
      expect(await w.recordExists("local", id)).toBe(true);
      expect(await w.blobExists("local", w.objectKey(id))).toBe(true);
    }
    const last = (await w.getRecord("cloud", w.subjectIds[5]))!;
    const { own } = await w.watermarks();
    expect(own[w.cloud.nodeId]).toEqual(last.updatedAt);
  });

  it("S6-004: 2 explicit rounds — round 1 ships pageLimit, round 2 finishes the remainder", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "exceeds-page-limit",
      batchCount: 6,
      pageLimit: 5,
    });

    const [r1, r2] = await w.exchange({ rounds: 2 });

    expect(r1!.shipped).toBe(5);
    expect(r2!.shipped).toBe(1);
    for (const id of w.subjectIds) {
      expect(await w.recordExists("cloud", id)).toBe(true);
    }
  });

  it("S6-005: pagination + transient middle blob-upload-fails / until-converged — full convergence", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "exceeds-page-limit",
      batchCount: 6,
      pageLimit: 5,
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

  it("regression: backlog exceeds a single scan page — cursor advances across pages so no records strand", async () => {
    // Forces the outbound cursor loop to traverse multiple DB pages within
    // one exchange round. With the pre-cursor code (`query({ limit: pageLimit })`
    // and no cursor), the scan would return the same first-N rows each round
    // — already-shipped after the first — and records past the first page
    // would never ship. The cursor advances over filtered (already-shipped)
    // rows so subsequent pages are reachable.
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "multi-homogeneous",
      batchCount: 10,
      pageLimit: 3,
      scanPageSize: 2,
    });

    await w.exchange({ rounds: "until-converged" });

    for (const id of w.subjectIds) {
      expect(await w.recordExists("cloud", id)).toBe(true);
      expect(await w.blobExists("cloud", w.objectKey(id))).toBe(true);
    }
  });

  it("S6-008: multi-mixed-nodes pagination — watermark fan-out across nodeIds", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      batch: "multi-mixed-nodes",
      batchCount: 6,
      pageLimit: 4,
    });

    await w.exchange({ rounds: "until-converged" });

    for (const id of w.subjectIds) {
      expect(await w.recordExists("cloud", id)).toBe(true);
    }
    // Both nodeIds end with watermarks at the last record they originated.
    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeDefined();
    expect(peer[w.cloud.nodeId]).toBeDefined();

    // Each watermark should equal the highest HLC seen for that nodeId.
    const localOrigin = w.subjectIds.filter((_, i) => i % 2 === 0);
    const cloudOrigin = w.subjectIds.filter((_, i) => i % 2 === 1);
    const lastLocal = (await w.getRecord(
      "local",
      localOrigin[localOrigin.length - 1]!,
    ))!;
    const lastCloud = (await w.getRecord(
      "local",
      cloudOrigin[cloudOrigin.length - 1]!,
    ))!;
    expect(peer[w.local.nodeId]).toEqual(lastLocal.updatedAt);
    expect(peer[w.cloud.nodeId]).toEqual(lastCloud.updatedAt);
  });
});
