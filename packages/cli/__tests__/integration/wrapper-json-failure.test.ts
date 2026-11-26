/**
 * `scripts/starkeep.mjs` under `--json` when it stops before the CLI runs.
 * A script reads one result object at the end of every output (CLI-022),
 * including the run that `starkeep update --platform` continues through the
 * wrapper after it pulls the checkout.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WRAPPER = join(CHECKOUT, "scripts", "starkeep.mjs");
// A PATH with no `pnpm` on it, so the wrapper stops at its first check.
const emptyBin = mkdtempSync(join(tmpdir(), "cli-wrapper-json-"));

afterAll(() => rmSync(emptyBin, { recursive: true, force: true }));

function wrapper(...args: string[]) {
  return spawnSync(process.execPath, [WRAPPER, ...args], {
    env: { ...process.env, PATH: emptyBin },
    encoding: "utf8",
  });
}

describe("the wrapper's own failures", () => {
  it("end --json output with one result object", () => {
    const run = wrapper("--install-first", "update", "--platform", "--json");
    expect(run.status).toBe(1);
    const lines = run.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]!) as {
      type: string;
      ok: boolean;
      error: { message: string };
    };
    expect(result).toMatchObject({ type: "result", ok: false });
    expect(result.error.message).toContain("Starkeep needs a `pnpm` command on your PATH.");
  });

  it("print the message alone without --json", () => {
    const run = wrapper("update", "--platform");
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Starkeep needs a `pnpm` command on your PATH.");
  });
});
