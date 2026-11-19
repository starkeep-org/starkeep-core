/**
 * The next due time of a scheduled job, across clock changes.
 */
import { describe, expect, it } from "vitest";
import {
  isKnownTimeZone,
  nextDueAt,
  selectableTimeZones,
  zoneOrUtc,
} from "../src/job-schedule.js";

const iso = (t: number) => new Date(t).toISOString();
const at = (s: string) => Date.parse(s);

describe("nextDueAt", () => {
  it("answers today when the time is still ahead, tomorrow otherwise", () => {
    expect(iso(nextDueAt("UTC", "06:30", at("2026-03-01T05:00:00Z")))).toBe(
      "2026-03-01T06:30:00.000Z",
    );
    expect(iso(nextDueAt("UTC", "06:30", at("2026-03-01T06:30:00Z")))).toBe(
      "2026-03-02T06:30:00.000Z",
    );
    expect(iso(nextDueAt("UTC", "06:30", at("2026-03-01T07:00:00Z")))).toBe(
      "2026-03-02T06:30:00.000Z",
    );
  });

  it("applies the zone's offset", () => {
    // Los Angeles is UTC-8 in January.
    expect(iso(nextDueAt("America/Los_Angeles", "06:30", at("2026-01-10T00:00:00Z")))).toBe(
      "2026-01-10T14:30:00.000Z",
    );
    // The local date, not the UTC date, decides "today": 23:00 in Los Angeles
    // is already the next day in UTC.
    expect(iso(nextDueAt("America/Los_Angeles", "23:30", at("2026-01-11T07:00:00Z")))).toBe(
      "2026-01-11T07:30:00.000Z",
    );
  });

  it("handles a zone with a 30-minute offset", () => {
    // Kolkata is UTC+5:30 all year.
    expect(iso(nextDueAt("Asia/Kolkata", "06:00", at("2026-06-01T00:00:00Z")))).toBe(
      "2026-06-01T00:30:00.000Z",
    );
  });

  describe("spring forward moves a skipped time to the end of the gap", () => {
    it("in Los Angeles", () => {
      // 2026-03-08: 02:00 PST jumps to 03:00 PDT (10:00Z).
      expect(iso(nextDueAt("America/Los_Angeles", "02:30", at("2026-03-08T08:00:00Z")))).toBe(
        "2026-03-08T10:00:00.000Z",
      );
      // The next day runs at 02:30 PDT again.
      expect(iso(nextDueAt("America/Los_Angeles", "02:30", at("2026-03-08T10:00:00Z")))).toBe(
        "2026-03-09T09:30:00.000Z",
      );
    });

    it("in London", () => {
      // 2026-03-29: 01:00 GMT jumps to 02:00 BST (01:00Z).
      expect(iso(nextDueAt("Europe/London", "01:15", at("2026-03-29T00:00:00Z")))).toBe(
        "2026-03-29T01:00:00.000Z",
      );
    });
  });

  describe("fall back runs once, at the first occurrence", () => {
    it("in Los Angeles", () => {
      // 2026-11-01: 02:00 PDT falls back to 01:00 PST. 01:30 happens at
      // 08:30Z (PDT) and again at 09:30Z (PST).
      expect(iso(nextDueAt("America/Los_Angeles", "01:30", at("2026-11-01T07:00:00Z")))).toBe(
        "2026-11-01T08:30:00.000Z",
      );
      // After the first occurrence, the next run is tomorrow, not the repeat.
      expect(iso(nextDueAt("America/Los_Angeles", "01:30", at("2026-11-01T08:30:00Z")))).toBe(
        "2026-11-02T09:30:00.000Z",
      );
    });

    it("in London", () => {
      // 2026-10-25: 02:00 BST falls back to 01:00 GMT. 01:30 happens at
      // 00:30Z and at 01:30Z.
      expect(iso(nextDueAt("Europe/London", "01:30", at("2026-10-25T00:00:00Z")))).toBe(
        "2026-10-25T00:30:00.000Z",
      );
      expect(iso(nextDueAt("Europe/London", "01:30", at("2026-10-25T00:30:00Z")))).toBe(
        "2026-10-26T01:30:00.000Z",
      );
    });
  });

  it("reads an unknown zone as UTC", () => {
    expect(iso(nextDueAt("Mars/Olympus_Mons", "06:30", at("2026-03-01T05:00:00Z")))).toBe(
      "2026-03-01T06:30:00.000Z",
    );
  });

  it("refuses a malformed time of day", () => {
    expect(() => nextDueAt("UTC", "6:30", 0)).toThrow();
    expect(() => nextDueAt("UTC", "24:00", 0)).toThrow();
  });
});

describe("zones", () => {
  it("knows IANA zones and refuses others", () => {
    expect(isKnownTimeZone("America/New_York")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("Not/A_Zone")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
    expect(zoneOrUtc("Not/A_Zone")).toBe("UTC");
    expect(zoneOrUtc(undefined)).toBe("UTC");
    expect(zoneOrUtc("Europe/London")).toBe("Europe/London");
  });

  it("offers UTC first, once", () => {
    const zones = selectableTimeZones();
    expect(zones[0]).toBe("UTC");
    expect(zones.filter((z) => z === "UTC")).toHaveLength(1);
    expect(zones).toContain("America/Los_Angeles");
  });
});
