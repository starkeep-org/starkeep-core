/**
 * The cloud data server's deployed record against a platform checkout: each
 * kind of difference, on a real git repository.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { platformFingerprint } from "@starkeep/admin-installer/deployed-source";

// The module reads STARKEEP_DIR when it loads.
process.env.STARKEEP_DIR = mkdtempSync(join(tmpdir(), "deployment-state-sk-"));
const { comparePlatform, platformLine, platformNeedsDeploy } =
  await import("../src/deployment-state");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "deployment-state-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const commit = (file: string, text: string) => {
    write(file, text);
    git("add", file);
    git("commit", "-q", "-m", `edit ${file}`);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  commit("pnpm-lock.yaml", "lock");
  commit("packages/admin-installer/index.ts", "one");
  return { dir, git, commit, write };
}

function recordOf(dir: string, commit: string) {
  return {
    commit,
    dirty: false,
    branch: "main",
    fingerprint: platformFingerprint(dir),
    deployedAt: "2026-11-26T00:00:00Z",
  };
}

describe("comparePlatform", () => {
  it("has no record before the first recorded deploy", () => {
    const { dir } = checkout();
    const c = comparePlatform(dir, null);
    expect(c.kind).toBe("no-record");
    expect(platformNeedsDeploy(c)).toBe(true);
  });

  it("is current when the checkout's platform code matches the record", () => {
    const { dir, git } = checkout();
    const c = comparePlatform(dir, recordOf(dir, git("rev-parse", "HEAD")));
    expect(c.kind).toBe("current");
    expect(platformNeedsDeploy(c)).toBe(false);
  });

  it("stays current after a commit outside the deployed packages", () => {
    const { dir, git, commit } = checkout();
    const record = recordOf(dir, git("rev-parse", "HEAD"));
    commit("packages/cli/src/bin.ts", "cli only");
    commit("docs/readme.md", "docs");
    expect(comparePlatform(dir, record).kind).toBe("current");
  });

  it("is behind when the checkout has platform commits the cloud lacks", () => {
    const { dir, git, commit } = checkout();
    const record = recordOf(dir, git("rev-parse", "HEAD"));
    commit("packages/admin-installer/two.ts", "two");
    const c = comparePlatform(dir, record);
    expect(c).toMatchObject({
      kind: "behind",
      cloudLacks: [{ subject: "edit packages/admin-installer/two.ts" }],
    });
    expect(platformLine(c)).toMatch(
      /^behind this checkout by 1 commit\(s\); runs [0-9a-f]{8} \(main\)$/,
    );
  });

  it("is ahead when the cloud runs a branch's commits, and diverged when both sides moved", () => {
    const { dir, git, commit } = checkout();
    git("checkout", "-q", "-b", "feature");
    const feature = commit("packages/admin-installer/jobs.ts", "jobs");
    const record = recordOf(dir, feature);
    git("checkout", "-q", "main");
    expect(comparePlatform(dir, record).kind).toBe("ahead");
    commit("packages/admin-installer/other.ts", "other");
    expect(comparePlatform(dir, record)).toMatchObject({
      kind: "diverged",
      checkoutLacks: [{ commit: feature }],
    });
  });

  it("names uncommitted changes when the commits match but the code differs", () => {
    const { dir, git, write } = checkout();
    const record = recordOf(dir, git("rev-parse", "HEAD"));
    write("packages/admin-installer/index.ts", "edited");
    expect(comparePlatform(dir, record).kind).toBe("changes");
  });

  it("says to fetch a recorded commit the repository lacks", () => {
    const { dir } = checkout();
    const c = comparePlatform(dir, {
      ...recordOf(dir, "0123456789abcdef0123456789abcdef01234567"),
      fingerprint: "other",
    });
    expect(c.kind).toBe("unknown-commit");
    expect(platformLine(c)).toContain("run git fetch");
  });
});
