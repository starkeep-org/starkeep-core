/**
 * scripts/wait-for-npm.sh, which `release:publish` runs after a publish, must
 * return only once npm shows every new version, and must fail with the missing
 * versions named when npm never shows them. A fake `npm` on PATH stands in for
 * the registry: each version starts showing after a given number of checks.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "wait-for-npm.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wait-for-npm-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Run the script against a registry where `spec` starts showing on check
 * number `appearsOn[spec]`. A spec left out never shows, and an unknown
 * package answers with an error, as npm does.
 */
function run(specs: string[], appearsOn: Record<string, number>, timeoutS = 5) {
  const fake = join(dir, "npm");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
# npm view <spec> version --prefer-online
spec="$2"
key="$(printf '%s' "$spec" | tr '/@' '__')"
n=$(( $(cat "${dir}/$key" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "${dir}/$key"
echo "$spec $*" >> "${dir}/calls"
case "$spec" in
${Object.entries(appearsOn)
  .map(
    ([s, k]) => `  "${s}") (( n >= ${k} )) && echo "${s.slice(s.lastIndexOf("@") + 1)}"; exit 0 ;;`,
  )
  .join("\n")}
  *) echo "npm error 404" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(fake, 0o755);
  return spawnSync("bash", [SCRIPT, ...specs], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STARKEEP_NPM_WAIT_TIMEOUT_S: String(timeoutS),
      STARKEEP_NPM_WAIT_INTERVAL_S: "0.1",
    },
    encoding: "utf8",
  });
}

describe("wait-for-npm.sh", () => {
  it("returns at once when npm already shows every version", () => {
    const r = run(["@starkeep/a@1.0.0", "@starkeep/b@2.0.0"], {
      "@starkeep/a@1.0.0": 1,
      "@starkeep/b@2.0.0": 1,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("npm shows all 2 version(s).");
    expect(r.stdout).not.toContain("Waiting");
  });

  it("waits until the last version shows, and stops checking a version once it shows", () => {
    const r = run(["@starkeep/a@1.0.0", "@starkeep/b@2.0.0"], {
      "@starkeep/a@1.0.0": 1,
      "@starkeep/b@2.0.0": 3,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Waiting for npm to show 1 of 2 version(s): @starkeep/b@2.0.0");
    const calls = readFileSync(join(dir, "calls"), "utf8");
    expect(calls.match(/^@starkeep\/a@1\.0\.0 /gm)).toHaveLength(1);
    expect(calls.match(/^@starkeep\/b@2\.0\.0 /gm)).toHaveLength(3);
    expect(calls).toContain("--prefer-online");
  });

  it("fails after the timeout and names only the versions npm never showed", () => {
    const r = run(["@starkeep/a@1.1.0", "@starkeep/new@0.1.0"], { "@starkeep/a@1.1.0": 2 }, 1);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm still does not show these after 1s:");
    expect(r.stderr).toContain("  @starkeep/new@0.1.0");
    expect(r.stderr).not.toContain("@starkeep/a@1.1.0");
  });

  it("refuses to run with no versions", () => {
    const r = run([], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});
