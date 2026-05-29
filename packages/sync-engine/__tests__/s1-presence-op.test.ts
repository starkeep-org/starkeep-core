import { describe, it, expect } from "vitest";
import { setupCase } from "./sync-test-harness/index.js";

/**
 * S1 — presence × operation (SR rows only).
 *
 * AR rows (S1-015..020) and AW rows (S1-021..025) live in their own files
 * once the harness gains AR/AW seeding.
 *
 * S1-002 and S1-004 in the candidate doc imply same-id collision between a
 * cloud-resident record and a local-originated insert. With ULIDs this is
 * practically impossible; the natural interpretation here — local insert
 * creates a *different* id while cloud already has its own — degenerates into
 * a plain bidirectional-flow check, which we cover.
 */
describe("S1 — presence × operation (SR)", () => {
  // ---- inserts ----

  it("S1-001: L-insert into neither — both sides converge", async () => {
    const w = await setupCase({ dt: "SR", presence: "neither" });
    await w.driveOperation({ side: "local", verb: "insert" });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S1-002: L-insert into cloud-only — bidirectional flow (distinct ids)", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
    });
    const preexistingCloudId = w.subjectId;
    await w.driveOperation({ side: "local", verb: "insert" });
    await w.exchange({ rounds: 1 });

    // The cloud-originated record reaches local.
    expect(await w.recordExists("local", preexistingCloudId)).toBe(true);
    expect(await w.blobExists("local", w.objectKey(preexistingCloudId))).toBe(
      true,
    );

    // The local-originated new record reaches cloud.
    const localId = w.subjectIds[1]!;
    expect(await w.recordExists("cloud", localId)).toBe(true);
  });

  it("S1-003: C-insert into neither — both sides converge", async () => {
    const w = await setupCase({ dt: "SR", presence: "neither" });
    await w.driveOperation({ side: "cloud", verb: "insert" });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(true);
  });

  it("S1-004: C-insert into local-only — bidirectional flow (distinct ids)", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });
    const preexistingLocalId = w.subjectId;
    await w.driveOperation({ side: "cloud", verb: "insert" });
    await w.exchange({ rounds: 1 });

    expect(await w.recordExists("cloud", preexistingLocalId)).toBe(true);
    expect(await w.blobExists("cloud", w.objectKey(preexistingLocalId))).toBe(
      true,
    );
    const cloudId = w.subjectIds[1]!;
    expect(await w.recordExists("local", cloudId)).toBe(true);
  });

  // ---- updates ----

  it("S1-005: L-update on local-only — cloud receives record + blob", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });
    await w.driveOperation({ side: "local", verb: "update" });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("cloud")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S1-006: L-update on both-same — cloud receives bumped updatedAt; blob unchanged", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "local", verb: "update" });
    const localAfter = await w.getRecord("local");
    await w.exchange({ rounds: 1 });
    const cloudAfter = await w.getRecord("cloud");
    expect(cloudAfter?.updatedAt).toEqual(localAfter!.updatedAt);
    expect(cloudAfter?.contentHash).toBe(localAfter!.contentHash);
  });

  it("S1-007: L-update on both-diverged — LWW: local's later update wins on cloud", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-diverged",
      blob: "bb",
    });
    await w.driveOperation({ side: "local", verb: "update", withBlob: true });
    const localAfter = await w.getRecord("local");
    await w.exchange({ rounds: 1 });
    const cloudAfter = await w.getRecord("cloud");
    expect(cloudAfter?.updatedAt).toEqual(localAfter!.updatedAt);
    expect(cloudAfter?.contentHash).toBe(localAfter!.contentHash);
  });

  it("S1-008: C-update on cloud-only — local pulls record + blob", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
    });
    await w.driveOperation({ side: "cloud", verb: "update" });
    await w.exchange({ rounds: 1 });
    expect(await w.recordExists("local")).toBe(true);
    expect(await w.blobExists("local")).toBe(true);
  });

  it("S1-009: C-update on both-same — local receives bumped updatedAt", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "cloud", verb: "update" });
    const cloudAfter = await w.getRecord("cloud");
    await w.exchange({ rounds: 1 });
    const localAfter = await w.getRecord("local");
    expect(localAfter?.updatedAt).toEqual(cloudAfter!.updatedAt);
  });

  it("S1-010: C-update on both-diverged — LWW: cloud's later update wins on local", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-diverged",
      blob: "bb",
    });
    await w.driveOperation({ side: "cloud", verb: "update", withBlob: true });
    const cloudAfter = await w.getRecord("cloud");
    await w.exchange({ rounds: 1 });
    const localAfter = await w.getRecord("local");
    expect(localAfter?.updatedAt).toEqual(cloudAfter!.updatedAt);
    expect(localAfter?.contentHash).toBe(cloudAfter!.contentHash);
  });

  // ---- soft-deletes ----

  it("S1-011: L-soft-delete on local-only — cloud receives tombstone; local blob remains", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "local-only",
      blob: "lb",
    });
    await w.driveOperation({ side: "local", verb: "soft-delete" });
    await w.exchange({ rounds: 1 });
    const cloudCopy = await w.getRecord("cloud");
    expect(cloudCopy).not.toBeNull();
    expect(cloudCopy?.deletedAt).not.toBeNull();
    // Local blob retained — soft-delete doesn't GC.
    expect(await w.blobExists("local")).toBe(true);
  });

  it("S1-012: L-soft-delete on both-same — cloud applies tombstone; blobs remain on both", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "local", verb: "soft-delete" });
    await w.exchange({ rounds: 1 });
    const cloudCopy = await w.getRecord("cloud");
    expect(cloudCopy?.deletedAt).not.toBeNull();
    expect(await w.blobExists("local")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S1-013: C-soft-delete on cloud-only — local receives tombstone; cloud blob remains", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "cloud-only",
      blob: "cb",
    });
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    await w.exchange({ rounds: 1 });
    const localCopy = await w.getRecord("local");
    expect(localCopy).not.toBeNull();
    expect(localCopy?.deletedAt).not.toBeNull();
    expect(await w.blobExists("cloud")).toBe(true);
  });

  it("S1-014: C-soft-delete on both-same — local applies tombstone; blobs remain on both", async () => {
    const w = await setupCase({
      dt: "SR",
      presence: "both-same",
      blob: "bb",
    });
    await w.driveOperation({ side: "cloud", verb: "soft-delete" });
    await w.exchange({ rounds: 1 });
    const localCopy = await w.getRecord("local");
    expect(localCopy?.deletedAt).not.toBeNull();
    expect(await w.blobExists("local")).toBe(true);
    expect(await w.blobExists("cloud")).toBe(true);
  });
});
