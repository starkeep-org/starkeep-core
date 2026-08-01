import { describe, it, expect } from "vitest";
import {
  observationFor,
  shouldReplace,
  isArchivedClass,
  expectedLatencyHoursFor,
  type AvailabilityEvent,
} from "../src/storage/availability-events.js";

const event = (over: Partial<AvailabilityEvent> = {}): AvailabilityEvent => ({
  kind: "transition",
  objectStorageKey: "shared/image/aa/" + "a".repeat(64),
  observedAtMs: 1_000,
  ...over,
});

describe("what counts as unreadable", () => {
  it("treats Deep Archive and Glacier as archived", () => {
    expect(isArchivedClass("DEEP_ARCHIVE")).toBe(true);
    expect(isArchivedClass("GLACIER")).toBe(true);
  });

  // Our bucket must never enable Intelligent-Tiering's asynchronous tiers, and
  // the installer asserts no such configuration is created. Handled anyway
  // because "must never" is doing a lot of work in a sentence about someone
  // else's console, and the cost of ignoring them is a read that hangs for
  // twelve hours while availability insists everything is fine.
  it("treats I-T's asynchronous tiers as archived even though we never enable them", () => {
    expect(isArchivedClass("DEEP_ARCHIVE_ACCESS")).toBe(true);
    expect(isArchivedClass("ARCHIVE_ACCESS")).toBe(true);
  });

  it("treats every instantly-readable class as readable", () => {
    for (const cls of ["STANDARD", "INTELLIGENT_TIERING", "STANDARD_IA", undefined]) {
      expect(isArchivedClass(cls), String(cls)).toBe(false);
    }
  });

  it("reports a longer wait for Deep Archive than for Glacier", () => {
    expect(expectedLatencyHoursFor("DEEP_ARCHIVE")).toBeGreaterThan(
      expectedLatencyHoursFor("GLACIER"),
    );
  });
});

describe("mapping events to observations", () => {
  it("records a transition into an archived class as archived, with the wait", () => {
    const o = observationFor(event({ kind: "transition", storageClass: "DEEP_ARCHIVE" }))!;
    expect(o.state).toBe("archived");
    expect(o.tier).toBe("DEEP_ARCHIVE");
    expect(o.expectedLatencyHours).toBeGreaterThan(0);
  });

  // One row per object per tiering decision, all saying the same thing, is
  // churn rather than information.
  it("records nothing for a transition between readable classes", () => {
    expect(observationFor(event({ storageClass: "INTELLIGENT_TIERING" }))).toBeNull();
    expect(observationFor(event({ storageClass: "STANDARD_IA" }))).toBeNull();
  });

  it("records a completed restore as readable, carrying its expiry", () => {
    const o = observationFor(
      event({ kind: "restore-completed", restoredUntilMs: 9_999 }),
    )!;
    // A caller asking "can I read this" wants yes. The expiry is what lets a
    // later reconcile notice it has passed without another round trip.
    expect(o.state).toBe("instant");
    expect(o.restoredUntilMs).toBe(9_999);
  });

  // The event most easily forgotten. Without it an object reads as available
  // forever after one restore — fine for a week, wrong for months.
  it("records an expired restore as archived again", () => {
    const o = observationFor(event({ kind: "restore-expired" }))!;
    expect(o.state).toBe("archived");
    expect(o.restoredUntilMs).toBeNull();
  });

  it("records a removal as absent, not as archived", () => {
    const o = observationFor(event({ kind: "removed" }))!;
    // Archived bytes exist and can be thawed; absent bytes cannot. Collapsing
    // them would send a caller to a restore endpoint with nothing to restore.
    expect(o.state).toBe("absent");
    expect(o.tier).toBeNull();
  });

  it("carries the event's own timestamp, not the time it was processed", () => {
    expect(observationFor(event({ kind: "removed", observedAtMs: 42 }))!.observedAtMs).toBe(42);
  });
});

describe("resolving disagreements", () => {
  it("accepts an observation about a key nothing has reported on", () => {
    expect(shouldReplace(null, { observedAtMs: 1 })).toBe(true);
  });

  it("prefers the newer observation", () => {
    expect(shouldReplace({ observedAtMs: 1 }, { observedAtMs: 2 })).toBe(true);
  });

  // The case that motivates storing a timestamp at all: a nightly inventory
  // snapshot taken at 03:00 arrives after a transition event that happened at
  // 04:00. Comparing arrival order instead leaves the record claiming a state
  // it left an hour earlier.
  it("rejects an older observation that arrives later", () => {
    expect(shouldReplace({ observedAtMs: 5 }, { observedAtMs: 3 })).toBe(false);
  });

  // At-least-once delivery means the same event arrives twice; rewriting on a
  // tie is pure churn.
  it("keeps what is stored on an exact tie", () => {
    expect(shouldReplace({ observedAtMs: 5 }, { observedAtMs: 5 })).toBe(false);
  });
});
