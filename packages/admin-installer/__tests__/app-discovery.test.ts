/**
 * The scan rule admin-web's app list and the per-app cloud CLIs share, run
 * against real temp folders.
 */

import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanApps } from "../src/app-discovery.js";
import { appDirFor, resolveAppDir, takeAppDirFlag } from "../src/app-cli-config.js";

function manifest(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    version: "1.0.0",
    tier: "community",
    infraRequirements: {
      fileAccess: [{ types: ["image/png"], access: "read", rationale: "test" }],
    },
  };
}

function folder(...parts: string[]): string {
  const dir = join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an app folder; `content` is the manifest, or raw text for a broken one. */
function app(parent: string, name: string, content: Record<string, unknown> | string): string {
  const dir = folder(parent, name);
  writeFileSync(
    join(dir, "starkeep.manifest.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return dir;
}

const root = mkdtempSync(join(tmpdir(), "app-discovery-"));
const locked: string[] = [];

afterAll(() => {
  // Let the temp cleanup read what the unreadable-folder case locked.
  for (const dir of locked) chmodSync(dir, 0o755);
});

describe("scanApps", () => {
  it("treats a configured folder that holds a manifest as one app, without looking inside", () => {
    const direct = app(folder(root, "direct-case"), "dice", manifest("dice", "Dice"));
    app(direct, "nested", manifest("nested", "Nested"));

    const result = scanApps([direct]);
    expect(result.apps.map((a) => [a.appId, a.appDir])).toEqual([["dice", direct]]);
    expect(result.dirs).toEqual([
      { dir: direct, apps: [{ appId: "dice", name: "Dice" }], problems: [] },
    ]);
  });

  it("treats any other configured folder as a container of apps", () => {
    const container = folder(root, "container-case");
    app(container, "photos", manifest("photos", "Photos"));
    app(container, "drive", manifest("drive-like", "Drive"));
    folder(container, "docs");

    const result = scanApps([container]);
    expect(result.dirs[0]!.apps).toEqual([
      { appId: "drive-like", name: "Drive" },
      { appId: "photos", name: "Photos" },
    ]);
    expect(result.problems).toEqual([]);
  });

  it("expands a leading ~ and keeps the folder as configured in the report", () => {
    const result = scanApps(["~/starkeep-app-discovery-test-no-such-folder"]);
    expect(result.dirs[0]!.dir).toBe("~/starkeep-app-discovery-test-no-such-folder");
    expect(result.problems[0]!.dir).not.toContain("~");
  });

  it("reports a missing folder, a file, and an unreadable folder", () => {
    const missing = join(root, "no-such-folder");
    const file = join(folder(root, "file-case"), "notes.txt");
    writeFileSync(file, "not a folder");
    const unreadable = folder(root, "unreadable-case");
    app(unreadable, "inner", manifest("inner", "Inner"));
    chmodSync(unreadable, 0o000);
    locked.push(unreadable);

    const result = scanApps([missing, file, unreadable]);
    expect(result.apps).toEqual([]);
    expect(result.dirs.map((d) => d.problems.map((p) => p.reason))).toEqual([
      ["The folder does not exist."],
      ["The path is a file, not a folder."],
      [expect.stringMatching(/^The folder could not be read: /)],
    ]);
    expect(result.problems.map((p) => p.dir)).toEqual([missing, file, unreadable]);
  });

  it("reports invalid JSON, a JSON array, and a manifest the schema refuses", () => {
    const container = folder(root, "invalid-case");
    app(container, "bad-json", "{ not json");
    app(container, "array", "[]");
    app(container, "no-name", { ...manifest("no-name", "x"), name: undefined });
    app(container, "good", manifest("good", "Good"));

    const result = scanApps([container]);
    expect(result.apps.map((a) => a.appId)).toEqual(["good"]);
    const reasons = Object.fromEntries(result.problems.map((p) => [p.dir, p.reason]));
    expect(reasons[join(container, "bad-json")]).toMatch(
      /^Invalid manifest found for bad-json: .*JSON/,
    );
    expect(reasons[join(container, "array")]).toMatch(/^Invalid manifest found for array: /);
    expect(reasons[join(container, "no-name")]).toMatch(
      /^Invalid manifest found for no-name: name: /,
    );
    expect(result.dirs[0]!.apps).toEqual([{ appId: "good", name: "Good" }]);
  });

  it("keeps the first of two apps with one id and reports the second", () => {
    const first = folder(root, "dup-case", "first");
    const second = folder(root, "dup-case", "second");
    const kept = app(first, "dice", manifest("dice", "Dice"));
    const skipped = app(second, "dice-copy", manifest("dice", "Dice copy"));

    const result = scanApps([first, second]);
    expect(result.apps.map((a) => a.appDir)).toEqual([kept]);
    expect(result.dirs[1]).toEqual({
      dir: second,
      apps: [],
      problems: [
        {
          configuredDir: second,
          dir: skipped,
          reason: `dice-copy uses the app id "dice", which ${kept} already uses.`,
        },
      ],
    });
  });

  it("reports nothing for a folder reached twice, and credits it to both configured folders", () => {
    const container = folder(root, "twice-case");
    const dice = app(container, "dice", manifest("dice", "Dice"));
    const link = join(root, "twice-link");
    symlinkSync(container, link);

    const result = scanApps([container, dice, link]);
    expect(result.apps.map((a) => a.appDir)).toEqual([dice]);
    expect(result.problems).toEqual([]);
    for (const entry of result.dirs) expect(entry.apps).toEqual([{ appId: "dice", name: "Dice" }]);
  });

  it("skips node_modules and dot-folders inside a container", () => {
    const container = folder(root, "skip-case");
    app(folder(container, "node_modules"), "pkg", manifest("from-node-modules", "x"));
    app(container, "node_modules-sibling", manifest("kept", "Kept"));
    writeFileSync(join(container, "node_modules", "starkeep.manifest.json"), "{}");
    app(container, ".hidden", manifest("hidden", "x"));

    const result = scanApps([container]);
    expect(result.apps.map((a) => a.appId)).toEqual(["kept"]);
    expect(result.problems).toEqual([]);
  });

  it("never looks past a container's direct children", () => {
    const container = folder(root, "depth-case");
    app(folder(container, "group"), "deep", manifest("deep", "Deep"));

    const result = scanApps([container]);
    expect(result.apps).toEqual([]);
    expect(result.dirs[0]).toEqual({ dir: container, apps: [], problems: [] });
  });

  it("scans nothing for an empty list", () => {
    expect(scanApps([])).toEqual({ apps: [], problems: [], dirs: [] });
  });
});

describe("resolveAppDir", () => {
  const config = (appParentDirs?: string[]) => ({
    stackPrefix: "sk",
    userPoolId: "us-east-1_x",
    userPoolClientId: "c",
    identityPoolId: "i",
    ...(appParentDirs ? { appParentDirs } : {}),
  });

  it("finds a directly configured app folder", () => {
    const direct = app(folder(root, "resolve-direct"), "dice", manifest("dice", "Dice"));
    expect(resolveAppDir(config([direct]), "dice")).toBe(direct);
  });

  it("finds an app in a container", () => {
    const container = folder(root, "resolve-container");
    const dice = app(container, "dice", manifest("dice", "Dice"));
    expect(resolveAppDir(config([container]), "dice")).toBe(dice);
  });

  it("scans nothing when appParentDirs is absent, and names the scan's problems", () => {
    expect(() => resolveAppDir(config(), "dice")).toThrow(/appParentDirs is empty/);
    const missing = join(root, "resolve-missing");
    expect(() => resolveAppDir(config([missing]), "dice")).toThrow(
      `${missing}: The folder does not exist.`,
    );
  });

  it("takes --app-dir after checking the manifest names the app", () => {
    const dice = app(folder(root, "flag-case"), "dice", manifest("dice", "Dice"));
    expect(appDirFor(config(), "dice", dice)).toBe(dice);
    expect(() => appDirFor(config(), "photos", dice)).toThrow(/names the app "dice", not "photos"/);
  });
});

describe("takeAppDirFlag", () => {
  it("splits the flag and its folder out of the arguments", () => {
    expect(takeAppDirFlag(["dice", "--app-dir", "/apps/dice", "--web"])).toEqual({
      appDir: "/apps/dice",
      rest: ["dice", "--web"],
    });
    expect(takeAppDirFlag(["dice"])).toEqual({ rest: ["dice"] });
    expect(() => takeAppDirFlag(["dice", "--app-dir"])).toThrow(/needs a folder/);
  });
});
