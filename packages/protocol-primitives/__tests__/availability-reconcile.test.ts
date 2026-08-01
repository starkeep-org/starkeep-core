import { describe, it, expect } from "vitest";
import {
  reconcileAvailability,
  vanishedObservation,
  type InventoryRow,
  type StoredAvailabilityLike,
} from "../src/storage/availability-reconcile.js";

const KEY = "shared/image/aa/" + "a".repeat(64);
const OTHER = "shared/image/bb/" + "b".repeat(64);

const row = (over: Partial<InventoryRow> = {}): InventoryRow => ({
  objectStorageKey: KEY,
  storageClass: "INTELLIGENT_TIERING",
  ...over,
});

const stored = (over: Partial<StoredAvailabilityLike> = {}): StoredAvailabilityLike => ({
  objectStorageKey: KEY,
  state: "instant",
  readyAtMs: null,
  restoredUntilMs: null,
  observedAtMs: 1_000,
  ...over,
});

function run(over: {
  rows?: InventoryRow[];
  stored?: StoredAvailabilityLike[];
  snapshotAtMs?: number;
  nowMs?: number;
  expectedInstant?: (k: string) => boolean;
} = {}) {
  return reconcileAvailability({
    rows: over.rows ?? [row()],
    stored: new Map((over.stored ?? []).map((s) => [s.objectStorageKey, s])),
    snapshotAtMs: over.snapshotAtMs ?? 5_000,
    nowMs: over.nowMs ?? 6_000,
    ...(over.expectedInstant ? { expectedInstant: over.expectedInstant } : {}),
  });
}

describe("correcting what events missed", () => {
  // The whole point of a backstop: an object transitioned, the notification was
  // lost or swallowed, and nothing else will ever notice.
  it("marks an object archived when the inventory says so and the store does not", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "instant" })],
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ state: "archived", tier: "DEEP_ARCHIVE" });
  });

  it("marks an object readable again when it is no longer archived", () => {
    const result = run({ rows: [row()], stored: [stored({ state: "archived" })] });
    expect(result.observations[0]).toMatchObject({ state: "instant" });
  });

  // Reading storage class alone would call this readable. It exists and cannot
  // be read — the exact confusion `stat()` was widened to avoid.
  it("sees through Intelligent-Tiering to its asynchronous access tier", () => {
    const result = run({
      rows: [
        row({
          storageClass: "INTELLIGENT_TIERING",
          intelligentTieringAccessTier: "DEEP_ARCHIVE_ACCESS",
        }),
      ],
      stored: [stored({ state: "instant" })],
    });
    expect(result.observations[0]).toMatchObject({
      state: "archived",
      tier: "DEEP_ARCHIVE_ACCESS",
    });
  });

  it("writes nothing when the report agrees with the store", () => {
    expect(run({ rows: [row()], stored: [stored({ state: "instant" })] }).observations).toEqual([]);
  });

  // Instant is the default for a key with no row, so writing one says nothing.
  it("writes nothing for an unknown key that is readable anyway", () => {
    expect(run({ rows: [row()], stored: [] }).observations).toEqual([]);
  });
});

describe("a snapshot is not the present", () => {
  // The failure this prevents: a report generated at 03:00 is read at 05:00 and
  // blindly applied, reverting a transition that happened at 04:00. The record
  // then claims a state it left an hour ago, and stays that way until tomorrow.
  it("does not overwrite an event newer than the snapshot", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "instant", observedAtMs: 9_000 })],
      snapshotAtMs: 5_000,
    });
    expect(result.observations).toEqual([]);
  });

  it("does apply when the snapshot is newer than what is stored", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "instant", observedAtMs: 1_000 })],
      snapshotAtMs: 5_000,
    });
    expect(result.observations).toHaveLength(1);
  });

  // An inventory cannot see restore state at all, so a thawed copy that has not
  // lapsed must be believed over the report — otherwise every reconcile would
  // mark a freshly-restored object unreadable while the user is looking at it.
  it("leaves a live restored copy alone despite an archived storage class", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "instant", restoredUntilMs: 99_000, observedAtMs: 1 })],
      nowMs: 6_000,
    });
    expect(result.observations).toEqual([]);
  });

  it("does re-archive once the restored copy has lapsed", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "instant", restoredUntilMs: 2_000, observedAtMs: 1 })],
      nowMs: 6_000,
    });
    expect(result.observations[0]).toMatchObject({ state: "archived" });
  });
});

describe("restores that got stuck", () => {
  // A lost ObjectRestore:Completed leaves a record `restoring` forever. This is
  // the only thing that ever notices — and the probe set is bounded by
  // outstanding restores rather than library size, which is what keeps it
  // affordable to check every day.
  it("flags a restore whose estimated ready time has passed", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "restoring", readyAtMs: 3_000 })],
      nowMs: 6_000,
    });
    expect(result.needsRestoreProbe).toEqual([KEY]);
  });

  it("leaves a restore that is still within its estimate alone", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "restoring", readyAtMs: 99_000 })],
      nowMs: 6_000,
    });
    expect(result.needsRestoreProbe).toEqual([]);
  });

  // An inventory cannot confirm a restore either way, so its silence about a
  // restoring key must not be read as the object having vanished.
  it("never marks a restoring key as vanished", () => {
    const result = run({
      rows: [],
      stored: [stored({ state: "restoring", readyAtMs: 99_000 })],
    });
    expect(result.vanished).toEqual([]);
  });
});

describe("objects that are gone", () => {
  it("reports a stored key the inventory no longer lists", () => {
    const result = run({ rows: [row({ objectStorageKey: OTHER })], stored: [stored()] });
    expect(result.vanished).toEqual([KEY]);
  });

  it("does not re-report a key already known to be absent", () => {
    const result = run({ rows: [], stored: [stored({ state: "absent" })] });
    expect(result.vanished).toEqual([]);
  });

  it("builds an absent observation carrying the snapshot's time", () => {
    expect(vanishedObservation(KEY, 5_000)).toMatchObject({
      state: "absent",
      observedAtMs: 5_000,
    });
  });
});

describe("things that should never have been archived", () => {
  // Reported rather than corrected, because the fix is not a database write.
  // A rendition in Deep Archive means the lifecycle rule matched something it
  // should not — a bug that repeats every night until somebody looks.
  it("reports an archived object that was expected to stay readable", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "archived" })],
      expectedInstant: () => true,
    });
    expect(result.unexpectedlyArchived).toEqual([KEY]);
    // Not silently "fixed": nothing here can un-archive it, and pretending
    // otherwise would hide the rule that put it there.
    expect(result.observations).toEqual([]);
  });

  it("reports nothing when no expectation was supplied", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "archived" })],
    });
    expect(result.unexpectedlyArchived).toEqual([]);
  });

  it("does not flag an archived object that was meant to be archived", () => {
    const result = run({
      rows: [row({ storageClass: "DEEP_ARCHIVE" })],
      stored: [stored({ state: "archived" })],
      expectedInstant: () => false,
    });
    expect(result.unexpectedlyArchived).toEqual([]);
  });
});
