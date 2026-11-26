/**
 * The fetch step of `starkeep update` against real git repositories: an
 * upstream, a clone that tracks it, and the refusals that keep a person's own
 * work safe.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "cli-update-"));
process.env.STARKEEP_DIR = join(scratch, "dot-starkeep");

let fetchAll: typeof import("../src/commands/update").fetchAll;
let createIo: typeof import("../src/io").createIo;
let readUpdates: typeof import("../src/git").readUpdates;
beforeAll(async () => {
  ({ fetchAll } = await import("../src/commands/update"));
  ({ createIo } = await import("../src/io"));
  ({ readUpdates } = await import("../src/git"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

let n = 0;
/** An upstream with one commit, and a clone of it that tracks `main`. */
function repoPair(): { upstream: string; clone: string; work: string } {
  const id = ++n;
  const work = join(scratch, `work-${id}`);
  const upstream = join(scratch, `upstream-${id}.git`);
  const clone = join(scratch, `clone-${id}`);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "app.txt"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "one");
  execFileSync("git", ["clone", "-q", "--bare", work, upstream]);
  git(work, "remote", "add", "origin", upstream);
  git(work, "fetch", "-q", "origin");
  git(work, "branch", "-q", "--set-upstream-to=origin/main", "main");
  execFileSync("git", ["clone", "-q", upstream, clone]);
  return { upstream, clone, work };
}

/** A new commit on the upstream, pushed from the work tree. */
function pushUpstream(work: string, text: string): void {
  writeFileSync(join(work, "app.txt"), text);
  git(work, "commit", "-q", "-am", text.trim());
  git(work, "push", "-q", "origin", "main");
}

function target(dir: string) {
  return {
    row: { appId: "notes", status: "active", manifest: {}, sourceDir: dir },
    repo: dir,
  };
}

function quietIo() {
  const lines: string[] = [];
  return {
    io: createIo({ json: false, cwd: scratch, stdout: (t) => lines.push(t), stderr: () => {} }),
    lines,
  };
}

describe("fetchAll", () => {
  it("fast-forwards a clean clone and records the commits before and after", () => {
    const { clone, work } = repoPair();
    const before = git(clone, "rev-parse", "HEAD");
    pushUpstream(work, "two\n");
    const moved = fetchAll(quietIo().io, [target(clone)]);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.before).toBe(before);
    expect(moved[0]!.after).toBe(git(clone, "rev-parse", "HEAD"));
    expect(readFileSync(join(clone, "app.txt"), "utf8")).toBe("two\n");
  });

  it("refuses a repository with uncommitted changes to tracked files, and pulls nothing", () => {
    const { clone, work } = repoPair();
    const before = git(clone, "rev-parse", "HEAD");
    pushUpstream(work, "two\n");
    writeFileSync(join(clone, "app.txt"), "my edit\n");
    expect(() => fetchAll(quietIo().io, [target(clone)])).toThrow(/uncommitted changes/);
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(clone, "app.txt"), "utf8")).toBe("my edit\n");
  });

  it("leaves untracked files alone and still pulls", () => {
    const { clone, work } = repoPair();
    pushUpstream(work, "two\n");
    writeFileSync(join(clone, "notes.local"), "mine\n");
    expect(fetchAll(quietIo().io, [target(clone)])).toHaveLength(1);
    expect(readFileSync(join(clone, "notes.local"), "utf8")).toBe("mine\n");
  });

  it("refuses a branch that has diverged from its upstream", () => {
    const { clone, work } = repoPair();
    pushUpstream(work, "two\n");
    writeFileSync(join(clone, "local.txt"), "local\n");
    git(clone, "add", "local.txt");
    git(clone, "commit", "-q", "-m", "local");
    const before = git(clone, "rev-parse", "HEAD");
    expect(() => fetchAll(quietIo().io, [target(clone)])).toThrow(/diverged/);
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
  });

  it("skips a folder outside git and says so", () => {
    const plain = mkdtempSync(join(scratch, "plain-"));
    const { io, lines } = quietIo();
    expect(fetchAll(io, [{ ...target(plain), repo: null }])).toEqual([]);
    expect(lines.join("")).toContain("not in a git repository");
  });

  it("checks every repository before it pulls any", () => {
    const a = repoPair();
    const b = repoPair();
    pushUpstream(a.work, "two\n");
    const aBefore = git(a.clone, "rev-parse", "HEAD");
    writeFileSync(join(b.clone, "app.txt"), "dirty\n");
    expect(() => fetchAll(quietIo().io, [target(a.clone), target(b.clone)])).toThrow(/uncommitted/);
    expect(git(a.clone, "rev-parse", "HEAD")).toBe(aBefore);
  });

  it("records a pull that went through when a later pull fails, so --undo can return it", () => {
    const a = repoPair();
    const b = repoPair();
    pushUpstream(a.work, "two\n");
    // The upstream adds a file the clone holds untracked, so git refuses the pull.
    writeFileSync(join(b.work, "new.txt"), "upstream\n");
    git(b.work, "add", "new.txt");
    git(b.work, "commit", "-q", "-m", "add new.txt");
    git(b.work, "push", "-q", "origin", "main");
    writeFileSync(join(b.clone, "new.txt"), "mine\n");
    const aBefore = git(a.clone, "rev-parse", "HEAD");

    expect(() => fetchAll(quietIo().io, [target(a.clone), target(b.clone)])).toThrow(
      /starkeep update --undo/,
    );
    const aAfter = git(a.clone, "rev-parse", "HEAD");
    expect(aAfter).not.toBe(aBefore);
    expect(readUpdates().at(-1)?.repos).toEqual([
      { root: a.clone, before: aBefore, after: aAfter },
    ]);
    expect(readFileSync(join(b.clone, "new.txt"), "utf8")).toBe("mine\n");
  });
});
