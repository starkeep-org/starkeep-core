/**
 * `scripts/install.sh` against this checkout as a file URL. A stand-in `node`
 * on PATH records the hand-off to `starkeep setup`, so the test checks the
 * clone, the second run's pull and the arguments without a full install.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = join(CHECKOUT, "scripts", "install.sh");
const scratch = mkdtempSync(join(tmpdir(), "cli-install-sh-"));
const fakeBin = join(scratch, "bin");
const handoff = join(scratch, "handoff.txt");

mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "node"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "${handoff}"\n`);
chmodSync(join(fakeBin, "node"), 0o755);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function install(...args: string[]) {
  return installWithPath(`${fakeBin}:${process.env.PATH}`, ...args);
}

function installWithPath(path: string, ...args: string[]) {
  return spawnSync("/bin/sh", [SCRIPT, "--repo", pathToFileURL(CHECKOUT).href, ...args], {
    env: { ...process.env, PATH: path, HOME: scratch },
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("install.sh", () => {
  const dir = join(scratch, "platform");

  it("clones the checkout and hands every other argument to setup", () => {
    const run = install("--dir", dir, "--local", "--yes", "it's quoted");
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain("@starkeep/data-protocol");
    const [cwd, ...args] = readFileSync(handoff, "utf8").trim().split("\n");
    expect(resolve(cwd!)).toBe(resolve(dir));
    expect(args).toEqual(["scripts/starkeep.mjs", "setup", "--local", "--yes", "it's quoted"]);
  });

  it("pulls on a second run instead of cloning again", () => {
    const run = install("--dir", dir);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Updating the Starkeep checkout");
    expect(
      execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("true");
  });

  it("refuses a pull that local work blocks, and keeps the work (CLI-003)", () => {
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", dir, ...a], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "T",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "T",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      }).trim();
    // A local commit on an older base: the branch and its upstream diverge.
    git("reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(dir, "mine.txt"), "mine\n");
    git("add", "mine.txt");
    git("commit", "-q", "-m", "mine");
    const mine = git("rev-parse", "HEAD");
    const run = install("--dir", dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `Could not update ${dir} with git pull --ff-only. Commit or stash your changes there, then run this again.`,
    );
    expect(git("rev-parse", "HEAD")).toBe(mine);
  });

  it("names the missing tool and clones nothing (CLI-005)", () => {
    const noGit = join(scratch, "no-git");
    const run = installWithPath(fakeBin, "--dir", noGit);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "Starkeep needs git. Install it (on macOS: xcode-select --install), then run this again.",
    );
    const gitOnly = join(scratch, "git-only");
    mkdirSync(gitOnly);
    const gitPath = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    symlinkSync(gitPath, join(gitOnly, "git"));
    const noNode = installWithPath(gitOnly, "--dir", noGit);
    expect(noNode.status).toBe(1);
    expect(noNode.stderr).toContain(
      "Starkeep needs Node 24 or later. Install it (for example with nvm: nvm install 24), then run this again.",
    );
    expect(existsSync(noGit)).toBe(false);
  });

  it("refuses a folder that holds something other than a checkout", () => {
    const other = join(scratch, "other");
    mkdirSync(other);
    writeFileSync(join(other, "keep.txt"), "mine");
    const run = install("--dir", other);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is not a Starkeep checkout");
    expect(readFileSync(join(other, "keep.txt"), "utf8")).toBe("mine");
  });
});
