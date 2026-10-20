import { describe, expect, it } from "vitest";
import {
  APP_GRANTABLE_CATEGORIES,
  DEFAULT_STAND_IN_STANDARDS as STD,
  EXTENSIONS,
  hasMetadataTable,
  isGrantableCategory,
  parseDeploymentSettings,
  retentionDaysFromSettings,
  serializeDeploymentSettings,
  settingsFromStandards,
  SETTINGS_TYPE_ID,
  standardsFromSettings,
  typeCategory,
  withDeploymentSettingsChange,
} from "../src/index.js";

const text = (value: unknown) => JSON.stringify(value);

describe("the retired settings type", () => {
  it("keeps the Drive-only starkeep category, with no extension and no metadata table", () => {
    expect(typeCategory(SETTINGS_TYPE_ID)).toBe("starkeep");
    expect(Object.values(EXTENSIONS)).not.toContain(SETTINGS_TYPE_ID);
    expect(isGrantableCategory("starkeep")).toBe(false);
    expect(hasMetadataTable("starkeep")).toBe(false);
    expect(APP_GRANTABLE_CATEGORIES).not.toContain("starkeep");
    expect(APP_GRANTABLE_CATEGORIES).not.toContain("other");
    expect(isGrantableCategory("image")).toBe(true);
  });
});

describe("parsing the deployment's settings", () => {
  it("reads a threshold and an advisory long edge, and defaults the rest", () => {
    const parsed = parseDeploymentSettings(
      text({
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
    expect(parsed.standards.video.advisoryLongEdges).toEqual({
      canonical: 1920,
      bySize: { 2000: 960 },
    });
  });

  it("reads an empty object as the defaults", () => {
    const parsed = parseDeploymentSettings(text({}));
    expect(parsed.ok && parsed.standards).toEqual(STD);
  });

  it("refuses what is not JSON, not an object, the wrong shape or out of range", () => {
    const cases: Array<[string, RegExp]> = [
      ["{not json", /not valid JSON/],
      [text([1, 2]), /JSON object/],
      [text({ trash: { retentionDays: 0 } }), /positive whole number of days/],
      [text({ standIns: { image: { canonicalThreshold: "big" } } }), /positive whole number/],
      [text({ standIns: { image: { canonicalThreshold: 100 } } }), /must be from 1280 to 16384/],
      [text({ standIns: { video: { canonicalThreshold: 90000 } } }), /must be from 1000 to 50000/],
      [
        text({ standIns: { video: { advisoryLongEdges: { bySize: { "999": 640 } } } } }),
        /names no standard video size/,
      ],
    ];
    for (const [input, problem] of cases) {
      const parsed = parseDeploymentSettings(input);
      expect(parsed.ok, String(problem)).toBe(false);
      if (!parsed.ok) expect(parsed.problems.join("\n")).toMatch(problem);
    }
  });

  it("round-trips the standards it was written from", () => {
    const standards = standardsFromSettings({ standIns: { video: { canonicalThreshold: 8000 } } });
    const parsed = parseDeploymentSettings(
      serializeDeploymentSettings(settingsFromStandards(standards)),
    );
    expect(parsed.ok && parsed.standards).toEqual(standards);
  });

  it("ignores a field it does not know, such as the retired device list", () => {
    const parsed = parseDeploymentSettings(
      text({ pairedDevices: [{}], trash: { retentionDays: 90 } }),
    );
    expect(parsed.ok && retentionDaysFromSettings(parsed.settings)).toBe(90);
  });
});

describe("changing one setting", () => {
  const current = {
    trash: { retentionDays: 90 },
    standIns: { image: { canonicalThreshold: 6000 } },
  };

  it("keeps the standards when only the trash window changes", () => {
    const next = withDeploymentSettingsChange(current, { trash: { retentionDays: 14 } });
    expect(next.trash).toEqual({ retentionDays: 14 });
    expect(standardsFromSettings(next)).toEqual(standardsFromSettings(current));
  });

  it("keeps the trash window and the untouched category when one threshold changes", () => {
    const next = withDeploymentSettingsChange(current, {
      standIns: { video: { canonicalThreshold: 8000 } },
    });
    expect(next.trash).toEqual({ retentionDays: 90 });
    const standards = standardsFromSettings(next);
    expect(standards.image.canonicalThreshold).toBe(6000);
    expect(standards.video.canonicalThreshold).toBe(8000);
  });

  it("writes nothing for an empty document and an empty change", () => {
    expect(withDeploymentSettingsChange({}, {})).toEqual({});
  });
});
