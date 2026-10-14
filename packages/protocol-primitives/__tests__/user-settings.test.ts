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
  withoutPairedDevice,
  withPairedDevice,
  type DataRecord,
  type PairedDevice,
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

describe("paired devices in the settings file", () => {
  const phone: PairedDevice = {
    deviceId: "dev_abc-123",
    label: "Pixel 8",
    appIds: ["starkeep-drive"],
    pairedAt: "2026-10-13T12:00:00.000Z",
  };

  it("reads a list of paired devices, and keeps the standards at their defaults", () => {
    const parsed = parseUserSettings(bytes({ pairedDevices: [phone, { ...phone, deviceId: "two", label: null }] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.pairedDevices).toEqual([phone, { ...phone, deviceId: "two", label: null }]);
    expect(parsed.standards).toEqual(STD);
  });

  it("round-trips through the file's bytes", () => {
    const parsed = parseUserSettings(serializeUserSettings({ pairedDevices: [phone] }));
    expect(parsed.ok && parsed.settings.pairedDevices).toEqual([phone]);
  });

  it.each([
    ["not a list", { pairedDevices: {} }, "pairedDevices must be a list"],
    ["an entry that is not an object", { pairedDevices: ["x"] }, "pairedDevices[0] must be an object"],
    ["a device id that could walk an SSM path", { pairedDevices: [{ ...phone, deviceId: "../app-creds/photos" }] }, "pairedDevices[0].deviceId"],
    ["an empty device id", { pairedDevices: [{ ...phone, deviceId: "" }] }, "pairedDevices[0].deviceId"],
    ["a duplicate device id", { pairedDevices: [phone, phone] }, "appears more than once"],
    ["a label that is not a string", { pairedDevices: [{ ...phone, label: 7 }] }, "pairedDevices[0].label"],
    ["a label that is too long", { pairedDevices: [{ ...phone, label: "x".repeat(101) }] }, "pairedDevices[0].label"],
    ["no app ids", { pairedDevices: [{ ...phone, appIds: [] }] }, "pairedDevices[0].appIds"],
    ["an app id that is not a string", { pairedDevices: [{ ...phone, appIds: [3] }] }, "pairedDevices[0].appIds"],
    ["a pairing time that is not a date", { pairedDevices: [{ ...phone, pairedAt: "yesterday" }] }, "pairedDevices[0].pairedAt"],
  ])("refuses %s", (_name, value, problem) => {
    const parsed = parseUserSettings(bytes(value));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join("\n")).toContain(problem);
  });

  it("accepts a label at the length limit", () => {
    expect(parseUserSettings(bytes({ pairedDevices: [{ ...phone, label: "x".repeat(100) }] })).ok).toBe(true);
  });

  it("adds a device, and replaces an entry with the same id rather than duplicating it", () => {
    const once = withPairedDevice({}, phone);
    expect(once.pairedDevices).toEqual([phone]);
    const relabelled = withPairedDevice(once, { ...phone, label: "Old phone" });
    expect(relabelled.pairedDevices).toEqual([{ ...phone, label: "Old phone" }]);
  });

  it("keeps every other setting when the list changes", () => {
    const settings = { trash: { retentionDays: 90 }, standIns: { image: { canonicalThreshold: 6000 } } };
    const added = withPairedDevice(settings, phone);
    expect(added.trash).toEqual(settings.trash);
    expect(added.standIns).toEqual(settings.standIns);
    expect(withoutPairedDevice(added, phone.deviceId)).toEqual({ ...settings, pairedDevices: [] });
  });

  it("removes only the named device, and leaves the value unchanged for an absent id", () => {
    const two = withPairedDevice(withPairedDevice({}, phone), { ...phone, deviceId: "two" });
    expect(withoutPairedDevice(two, "two").pairedDevices).toEqual([phone]);
    expect(withoutPairedDevice(two, "absent")).toBe(two);
  });
});
