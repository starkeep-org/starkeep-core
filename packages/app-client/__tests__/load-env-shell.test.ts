/**
 * The shell counterpart of the TS loader: `scripts/load-env.sh`, sourced by the
 * teardown/reset scripts. Same precedence contract — an already-exported value >
 * `.env.local` > `.env`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HELPER = join(REPO_ROOT, "scripts/load-env.sh");

// Source the helper with STARKEEP_ENV_DIR pointed at `envDir`, then echo the
// resulting STARKEEP_DIR. Returns stdout trimmed.
function runHelper(envDir: string, exported?: Record<string, string>): string {
  const res = spawnSync("bash", ["-c", `source "${HELPER}"; printf '%s' "\${STARKEEP_DIR:-}"`], {
    env: { ...process.env, STARKEEP_ENV_DIR: envDir, ...exported },
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`load-env.sh failed (${res.status}): ${res.stderr}`);
  }
  return res.stdout;
}

let envDir: string;

beforeEach(() => {
  envDir = mkdtempSync(join(tmpdir(), "load-env-sh-"));
  delete process.env.STARKEEP_DIR;
});

afterEach(() => {
  rmSync(envDir, { recursive: true, force: true });
});

describe("scripts/load-env.sh", () => {
  it(".env.local wins over .env", () => {
    writeFileSync(join(envDir, ".env"), "STARKEEP_DIR=/from/env\n");
    writeFileSync(join(envDir, ".env.local"), "STARKEEP_DIR=/from/env-local\n");
    expect(runHelper(envDir)).toBe("/from/env-local");
  });

  it("an exported STARKEEP_DIR is preserved", () => {
    writeFileSync(join(envDir, ".env.local"), "STARKEEP_DIR=/from/env-local\n");
    expect(runHelper(envDir, { STARKEEP_DIR: "/exported/wins" })).toBe("/exported/wins");
  });

  it("handles quotes and an `export ` prefix", () => {
    writeFileSync(join(envDir, ".env.local"), 'export STARKEEP_DIR="/quoted/path"\n');
    expect(runHelper(envDir)).toBe("/quoted/path");
  });

  it("is a no-op when no dotfile exists", () => {
    expect(runHelper(envDir)).toBe("");
  });
});
