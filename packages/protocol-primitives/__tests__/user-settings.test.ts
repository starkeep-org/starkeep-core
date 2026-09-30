import { describe, expect, it } from "vitest";
import {
  APP_GRANTABLE_CATEGORIES,
  createDataRecord,
  createHLCClock,
  DEFAULT_STAND_IN_STANDARDS as STD,
  EXTENSIONS,
  hasMetadataTable,
  isGrantableCategory,
  parseUserSettings,
  pickSettingsRecord,
  serializeUserSettings,
  settingsFromStandards,
  SETTINGS_TYPE_ID,
  standardsFromSettings,
  typeCategory,
  USER_SETTINGS_FILE_NAME,
  type DataRecord,
} from "../src/index.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("the settings type", () => {
  it("sits in the Drive-only starkeep category, with no extension and no metadata table", () => {
    expect(typeCategory(SETTINGS_TYPE_ID)).toBe("starkeep");
    expect(Object.values(EXTENSIONS)).not.toContain(SETTINGS_TYPE_ID);
    expect(isGrantableCategory("starkeep")).toBe(false);
    expect(hasMetadataTable("starkeep")).toBe(false);
    expect(APP_GRANTABLE_CATEGORIES).not.toContain("starkeep");
    expect(APP_GRANTABLE_CATEGORIES).not.toContain("other");
    expect(isGrantableCategory("image")).toBe(true);
  });
});

describe("parsing a settings file", () => {
  it("reads a threshold and an advisory long edge, and defaults the rest", () => {
    const parsed = parseUserSettings(
      bytes({
        standIns: {
          image: { canonicalThreshold: 6000 },
          video: { advisoryLongEdges: { bySize: { "2000": 960 } } },
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.standards.image.canonicalThreshold).toBe(6000);
    expect(parsed.standards.video.canonicalThreshold).toBe(STD.video.canonicalThreshold);
    expect(parsed.standards.video.advisoryLongEdges).toEqual({ canonical: 1920, bySize: { 2000: 960 } });
  });

  it("reads an empty object as the defaults", () => {
    const parsed = parseUserSettings(bytes({}));
    expect(parsed.ok && parsed.standards).toEqual(STD);
  });

  it("refuses what is not JSON, not an object, the wrong shape or out of range", () => {
    const cases: Array<[Uint8Array, RegExp]> = [
      [new TextEncoder().encode("{not json"), /not valid JSON/],
      [bytes([1, 2]), /JSON object/],
      [bytes({ standIns: { image: { canonicalThreshold: "big" } } }), /positive whole number/],
      [bytes({ standIns: { image: { canonicalThreshold: 100 } } }), /must be from 1280 to 16384/],
      [bytes({ standIns: { video: { canonicalThreshold: 90000 } } }), /must be from 1000 to 50000/],
      [bytes({ standIns: { video: { advisoryLongEdges: { bySize: { "999": 640 } } } } }), /names no standard video size/],
    ];
    for (const [input, problem] of cases) {
      const parsed = parseUserSettings(input);
      expect(parsed.ok, String(problem)).toBe(false);
      if (!parsed.ok) expect(parsed.problems.join("\n")).toMatch(problem);
    }
  });

  it("round-trips the standards it was written from", () => {
    const standards = standardsFromSettings({ standIns: { video: { canonicalThreshold: 8000 } } });
    const parsed = parseUserSettings(serializeUserSettings(settingsFromStandards(standards)));
    expect(parsed.ok && parsed.standards).toEqual(standards);
  });
});

describe("pickSettingsRecord", () => {
  function settingsRecord(nodeId: string, wallTime: number, hash: string): DataRecord {
    const clock = createHLCClock({ nodeId, wallClockFunction: () => wallTime });
    return createDataRecord(
      {
        type: SETTINGS_TYPE_ID,
        originAppId: "starkeep-drive",
        contentHash: hash,
        objectStorageKey: `shared/starkeep/00/${hash}`,
        sizeBytes: 10,
        originalFilename: USER_SETTINGS_FILE_NAME,
      },
      clock,
    );
  }

  it("keeps the newest live settings record and names the rest", () => {
    const older = settingsRecord("A", 1, "a");
    const newer = settingsRecord("B", 2, "b");
    const tombstoned = { ...settingsRecord("C", 3, "c"), deletedAt: { wallTime: 4, counter: 0, nodeId: "C" } };
    const picked = pickSettingsRecord([older, newer, tombstoned]);
    expect(picked.winner?.id).toBe(newer.id);
    expect(picked.losers.map((r) => r.id)).toEqual([older.id]);
  });

  it("picks nothing from no live settings record", () => {
    expect(pickSettingsRecord([])).toEqual({ winner: null, losers: [] });
  });
});
