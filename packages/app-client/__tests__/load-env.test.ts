/**
 * The repo-root `.env` / `.env.local` loader behind the "set STARKEEP_DIR in a
 * dotfile" convenience. Precedence must be: an already-exported value >
 * `.env.local` > `.env`, with no key ever clobbered (so explicit exports and
 * test harnesses always win).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStarkeepEnv } from "../src/load-env.js";

let root: string;
const TOUCHED = ["STARKEEP_DIR", "ENV_LOCAL_ONLY", "ENV_ONLY", "EXPORTED_KEY"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "load-env-test-"));
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadStarkeepEnv", () => {
  it(".env.local wins over .env, and .env fills the gaps", () => {
    writeFileSync(join(root, ".env"), "STARKEEP_DIR=/from/env\nENV_ONLY=only-in-env\n");
    writeFileSync(
      join(root, ".env.local"),
      "STARKEEP_DIR=/from/env-local\nENV_LOCAL_ONLY=only-in-local\n",
    );

    loadStarkeepEnv(root);

    expect(process.env.STARKEEP_DIR).toBe("/from/env-local");
    expect(process.env.ENV_ONLY).toBe("only-in-env");
    expect(process.env.ENV_LOCAL_ONLY).toBe("only-in-local");
  });

  it("never overrides an already-exported value", () => {
    process.env.STARKEEP_DIR = "/exported/wins";
    writeFileSync(join(root, ".env.local"), "STARKEEP_DIR=/from/env-local\n");
    writeFileSync(join(root, ".env"), "STARKEEP_DIR=/from/env\n");

    loadStarkeepEnv(root);

    expect(process.env.STARKEEP_DIR).toBe("/exported/wins");
  });

  it("is a no-op when neither file exists", () => {
    loadStarkeepEnv(root);
    expect(process.env.STARKEEP_DIR).toBeUndefined();
  });

  it("honors the STARKEEP_ENV_DIR override when no root arg is given", () => {
    writeFileSync(join(root, ".env.local"), "STARKEEP_DIR=/via/env-dir\n");
    const savedEnvDir = process.env.STARKEEP_ENV_DIR;
    process.env.STARKEEP_ENV_DIR = root;
    try {
      loadStarkeepEnv();
      expect(process.env.STARKEEP_DIR).toBe("/via/env-dir");
    } finally {
      if (savedEnvDir === undefined) delete process.env.STARKEEP_ENV_DIR;
      else process.env.STARKEEP_ENV_DIR = savedEnvDir;
    }
  });
});
