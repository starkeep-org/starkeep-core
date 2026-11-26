/**
 * The wrapper's install record, which its stale-build warning compares with
 * the checkout. The root `postinstall` writes it, so a `pnpm install` run by
 * hand, as the warning advises, clears the warning.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = mkdtempSync(join(tmpdir(), "cli-wrapper-record-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the wrapper's install record", () => {
  it("is written by the root postinstall", () => {
    const pkg = JSON.parse(readFileSync(join(CHECKOUT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.postinstall).toContain("node scripts/starkeep.mjs --record-install");
  });

  it("records the lockfile's hash under --record-install, without installing", () => {
    // A copy of the wrapper in a folder outside git, so the commit is null.
    mkdirSync(join(scratch, "scripts"));
    mkdirSync(join(scratch, "node_modules"));
    copyFileSync(
      join(CHECKOUT, "scripts", "starkeep.mjs"),
      join(scratch, "scripts", "starkeep.mjs"),
    );
    writeFileSync(join(scratch, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const result = spawnSync(
      process.execPath,
      [join(scratch, "scripts", "starkeep.mjs"), "--record-install"],
      {
        // No pnpm on PATH: recording must not need one.
        env: { ...process.env, PATH: dirname(process.execPath) },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(
      readFileSync(join(scratch, "node_modules", ".starkeep-install.json"), "utf8"),
    ) as { commit: string | null; lockfile: string };
    expect(record.lockfile).toBe(
      createHash("sha256").update("lockfileVersion: '9.0'\n").digest("hex"),
    );
  });
});
