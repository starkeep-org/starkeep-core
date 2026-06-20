/**
 * The real-state guard in starkeepDir(): under a test runner it must never
 * resolve to the operator's live ~/.starkeep, so a harness that forgets to set
 * STARKEEP_DIR fails loudly instead of clobbering real local state. These tests
 * run under Vitest, so VITEST is set and the guard is armed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { starkeepDir } from "../src/paths.js";

let saved: string | undefined;
let savedGuard: string | undefined;

beforeEach(() => {
  saved = process.env.STARKEEP_DIR;
  savedGuard = process.env.STARKEEP_TEST_GUARD;
});

afterEach(() => {
  if (saved === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = saved;
  if (savedGuard === undefined) delete process.env.STARKEEP_TEST_GUARD;
  else process.env.STARKEEP_TEST_GUARD = savedGuard;
});

describe("starkeepDir real-state guard", () => {
  it("allows a throwaway directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "paths-test-"));
    try {
      process.env.STARKEEP_DIR = dir;
      expect(starkeepDir()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when STARKEEP_DIR is unset (the fail-open default is real ~/.starkeep)", () => {
    delete process.env.STARKEEP_DIR;
    expect(() => starkeepDir()).toThrow(/real Starkeep state directory/);
  });

  it("throws when STARKEEP_DIR points straight at real ~/.starkeep", () => {
    process.env.STARKEEP_DIR = join(homedir(), ".starkeep");
    expect(() => starkeepDir()).toThrow(/real Starkeep state directory/);
  });

  it("throws for a path nested under real ~/.starkeep", () => {
    process.env.STARKEEP_DIR = join(homedir(), ".starkeep", "app-creds");
    expect(() => starkeepDir()).toThrow(/real Starkeep state directory/);
  });

  it("does not confuse a sibling dir whose name shares the prefix", () => {
    // ~/.starkeep-decoy must not be treated as "under" ~/.starkeep.
    const decoy = `${join(homedir(), ".starkeep")}-decoy`;
    process.env.STARKEEP_DIR = decoy;
    expect(starkeepDir()).toBe(decoy);
  });
});
