import { describe, it, expect } from "vitest";
import {
  isReadableNow,
  estimateRestore,
  DEFAULT_AVAILABILITY,
  RESTORE_TIERS,
  type RecordAvailability,
} from "../src/storage/availability.js";

describe("availability defaults", () => {
  // Objects are written to an instantly-readable class and only *become*
  // archived by a transition, which is an event the store is told about. So
  // "no row" genuinely means "nothing has moved it".
  it("assumes instant for an object nothing has reported on", () => {
    expect(DEFAULT_AVAILABILITY).toEqual({ state: "instant" });
  });

  // The direction matters. Being wrong this way costs a recoverable 409 from
  // the read path, which self-corrects once an event or the reconcile lands.
  // Defaulting to archived would be safe in the opposite direction and
  // useless — every record would look unreadable until proven otherwise.
  it("treats only instant as readable now", () => {
    const cases: RecordAvailability[] = [
      { state: "instant" },
      { state: "restoring", readyAt: null },
      { state: "archived", tier: "DEEP_ARCHIVE", expectedLatencyHours: 12 },
      { state: "absent" },
    ];
    expect(cases.map(isReadableNow)).toEqual([true, false, false, false]);
  });
});

describe("restore estimates", () => {
  const GB = 1024 ** 3;

  it("prices Standard retrieval per gigabyte", () => {
    const estimate = estimateRestore(10 * GB, 1, "Standard", 7);
    expect(estimate.estimatedHours).toBe(12);
    expect(estimate.estimatedCostUsd).toBeCloseTo(10 * RESTORE_TIERS.Standard.usdPerGb, 6);
  });

  // Standard rather than Bulk for a single item: the difference is hundredths
  // of a cent and thirty-six hours. Bulk earns its wait only when the object
  // count makes the cents add up.
  it("makes Bulk much cheaper and much slower", () => {
    const standard = estimateRestore(100 * GB, 1, "Standard", 7);
    const bulk = estimateRestore(100 * GB, 1, "Bulk", 7);
    expect(bulk.estimatedCostUsd).toBeLessThan(standard.estimatedCostUsd);
    expect(bulk.estimatedHours).toBeGreaterThan(standard.estimatedHours);
    // The whole trade, in one number: four times the wait to save under two
    // dollars on a hundred gigabytes.
    expect(standard.estimatedCostUsd - bulk.estimatedCostUsd).toBeLessThan(2);
  });

  it("carries the object count and how long the thawed copy lasts", () => {
    const estimate = estimateRestore(GB, 42, "Standard", 7);
    expect(estimate.objectCount).toBe(42);
    // A week, so a print session or an export does not re-thaw the same object
    // repeatedly — the charge is per restore and the second buys nothing.
    expect(estimate.availableForDays).toBe(7);
  });

  it("costs nothing for nothing", () => {
    expect(estimateRestore(0, 0, "Standard", 7).estimatedCostUsd).toBe(0);
  });
});
