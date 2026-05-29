import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S2 — tombstone × one-round exchange (SR only).
 *
 * AR (S2-008..011) and AW (S2-012..015) live in their own files once the
 * harness gains AR/AW seeding.
 */
describe("S2 — tombstone × 1-round (SR)", () => {
  it("S2-001: cd + cloud-only — local receives tombstone (no blob pulled)", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
      tomb: "cd",
    });
    await w.exchange({ rounds: 1 });

    const local = await w.getRecord("local");
    expect(local).not.toBeNull();
    expect(local?.deletedAt).not.toBeNull();
    // Cloud held the blob, but tombstone propagation doesn't pull the blob —
    // pullBlobIfNeeded short-circuits on deletedAt.
    expect(await w.blobExists("local")).toBe(false);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S2-002: cd + both-same — local applies tombstone; both blobs remain", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      tomb: "cd",
    });
    await w.exchange({ rounds: 1 });

    const local = await w.getRecord("local");
    expect(local?.deletedAt).not.toBeNull();
    expect(await w.blobExists("local")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S2-003: ld + local-only — cloud receives tombstone (no blob pushed)", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
      tomb: "ld",
    });
    await w.exchange({ rounds: 1 });

    const cloud = await w.getRecord("cloud");
    expect(cloud).not.toBeNull();
    expect(cloud?.deletedAt).not.toBeNull();
    expect(await w.blobExists("cloud")).toBe(false);
    expect(await w.blobExists("local")).toBe(true);
  });

  it("S2-004: ld + both-same — cloud applies tombstone; both blobs remain", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      tomb: "ld",
    });
    await w.exchange({ rounds: 1 });

    const cloud = await w.getRecord("cloud");
    expect(cloud?.deletedAt).not.toBeNull();
    expect(await w.blobExists("local")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S2-005: bd + both-same — both already tombstoned; converges, blobs retained", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
      tomb: "bd",
    });
    await w.exchange({ rounds: 1 });

    const local = await w.getRecord("local");
    const cloud = await w.getRecord("cloud");
    expect(local?.deletedAt).not.toBeNull();
    expect(cloud?.deletedAt).not.toBeNull();
    expect(await w.blobExists("local")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S2-006: bd-diff-ts + both-diverged — later deletedAt wins LWW", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-diverged",
      blob: "bb",
      tomb: "bd-diff-ts",
    });
    // Seeding applies cloud.delete first, then local.delete — so local's
    // tombstone HLC is strictly later. After exchange the cloud copy should
    // converge to local's later deletedAt.
    const localBeforeExchange = await w.getRecord("local");
    await w.exchange({ rounds: 1 });

    const cloud = await w.getRecord("cloud");
    expect(cloud?.deletedAt).toEqual(localBeforeExchange!.deletedAt);
    expect(cloud?.updatedAt).toEqual(localBeforeExchange!.updatedAt);
  });

  it("S2-007: cdu + both-diverged — later HLC wins (local update beats cloud delete)", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-diverged",
      blob: "bb",
      tomb: "cdu",
    });
    // Seeding does: cloud.delete(t3), then local.update(t4). t4 > t3 → local
    // update wins; cloud should land on local's live updated state.
    const localBeforeExchange = await w.getRecord("local");
    expect(localBeforeExchange?.deletedAt).toBeNull();
    expect(localBeforeExchange?.contentHash).toBe("sha256:local-updated");

    await w.exchange({ rounds: 1 });

    const cloud = await w.getRecord("cloud");
    expect(cloud?.deletedAt).toBeNull();
    expect(cloud?.updatedAt).toEqual(localBeforeExchange!.updatedAt);
    expect(cloud?.contentHash).toBe("sha256:local-updated");
  });
});
