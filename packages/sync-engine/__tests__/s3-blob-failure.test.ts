import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S3 — blob state × failure mode (SR single-record subset).
 *
 * Multi-record cases (S3-005..008) need the harness's multi-record seeding.
 * AR variants (S3-011..014) need AR seeding.
 */
describe("S3 — blob × failure (SR, single)", () => {
  it("S3-001: lb + persistent upload-fails / 2r — row ships, file stays owed against the peer's bytes watermark", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });
    const results = await w.exchange({
      rounds: 2,
      inject: { kind: "blob-upload-fails", recov: "persistent" },
    });

    // The row no longer waits for its file.
    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(false);
    const { peer, peerBytes } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeDefined();
    // The cloud says it lacks the file, so the upload is still owed.
    expect(peerBytes?.[w.local.nodeId]).toBeUndefined();
    expect(results.every((r) => r.blocked)).toBe(true);
  });

  it("S3-002: lb + transient upload-fails / 2r — round 2 succeeds; convergence reached", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });
    await w.exchange({
      rounds: 2,
      inject: { kind: "blob-upload-fails", recov: "transient" },
    });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
    const { peer } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeDefined();
  });

  it("S3-003: cb + persistent download-fails / 2r — row applied, rows watermark advances, bytes watermark holds", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
    });
    const results = await w.exchange({
      rounds: 2,
      inject: { kind: "blob-download-fails", recov: "persistent" },
    });

    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(false);
    // The row is held, so the rows watermark passes it and the cloud does not
    // send it again; the file is owed against the bytes watermark instead.
    const { own, ownBytes } = await w.watermarks();
    expect(own[w.cloud.nodeId]).toBeDefined();
    expect(ownBytes?.[w.cloud.nodeId]).toBeUndefined();
    // The cloud holds the file, so a failed download is a fault, not a wait.
    expect(results.every((r) => r.blocked)).toBe(true);
  });

  it("S3-004: cb + transient download-fails / 2r — round 2 pulls blob, advances watermark", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
    });
    await w.exchange({
      rounds: 2,
      inject: { kind: "blob-download-fails", recov: "transient" },
    });

    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(true);
    const { own } = await w.watermarks();
    expect(own[w.cloud.nodeId]).toBeDefined();
  });

  it("S3-009: nh (neither has blob) + no-failure / 1r — row ships; the file is owed to nobody this node can reach", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "nh",
    });
    // Local has the record row but no bytes. The row still ships: what is
    // owed is the file, and only a node holding it can send it.
    const [r1] = await w.exchange({ rounds: 1 });

    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(false);
    const { peer, peerBytes } = await w.watermarks();
    expect(peer[w.local.nodeId]).toBeDefined();
    expect(peerBytes?.[w.local.nodeId]).toBeUndefined();
    // Nothing failed here: this node never held the file to send.
    expect(r1!.blocked).toBe(false);
    expect(r1!.uploaded).toBe(0);
  });

  it("S3-010: bb (both have blob) + no-failure / 1r — both Resident; no transfer needed", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.exchange({ rounds: 1 });

    expect(await w.residency("local")).toBe("resident");
    expect(await w.residency("cloud")).toBe("resident");
  });

  it("S3-015: lb + no-failure / 2r — Absent→Resident on cloud after r1; r2 is no-op", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });
    expect(await w.residency("cloud")).toBe("absent");

    const [r1] = await w.exchange({ rounds: 1 });
    expect(r1!.shipped).toBe(1);
    expect(await w.residency("cloud")).toBe("resident");

    const [r2] = await w.exchange({ rounds: 1 });
    expect(r2!.shipped).toBe(0);
    expect(r2!.applied).toBe(0);
    expect(await w.residency("cloud")).toBe("resident");
  });
});
