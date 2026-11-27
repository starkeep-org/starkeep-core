/**
 * The backward-deploy guard on a real git repository: it compares patches,
 * not SHAs, so a rebased commit counts as present.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNotBackward, compareWithDeployed } from "../../src/operations/deploy-guard.js";
import { withCode } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): {
  dir: string;
  git: (...args: string[]) => string;
  commit: (file: string, text: string) => string;
} {
  const dir = mkdtempSync(join(tmpdir(), "deploy-guard-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    git("add", file);
    git("commit", "-q", "-m", `edit ${file}`);
    return git("rev-parse", "HEAD");
  };
  commit("base.txt", "base");
  return { dir, git, commit };
}

const at = (commit: string, dirty = false) => ({ commit, dirty, branch: null });

describe("compareWithDeployed", () => {
  it("has nothing to compare without a record", () => {
    const { dir } = repo();
    expect(compareWithDeployed(dir, null).kind).toBe("no-record");
    expect(compareWithDeployed(dir, { commit: null, dirty: false, branch: null }).kind).toBe(
      "no-record",
    );
  });

  it("passes a deploy of the recorded commit, and one ahead of it", () => {
    const { dir, commit } = repo();
    const deployed = commit("a.txt", "a");
    expect(compareWithDeployed(dir, at(deployed)).kind).toBe("ok");
    commit("b.txt", "b");
    expect(compareWithDeployed(dir, at(deployed)).kind).toBe("ok");
  });

  it("refuses a checkout that lacks a commit the cloud runs, and names it", () => {
    const { dir, git, commit } = repo();
    git("checkout", "-q", "-b", "feature");
    const feature = commit("feature.txt", "new table");
    git("checkout", "-q", "main");
    commit("main.txt", "other");
    const result = compareWithDeployed(dir, at(feature));
    expect(result).toMatchObject({
      kind: "backward",
      missing: [{ commit: feature, subject: "edit feature.txt" }],
    });
    expect(() => assertNotBackward(result, "The cloud data server", "`--force`")).toThrow(
      withCode("DEPLOY_BACKWARD"),
    );
    expect(() => assertNotBackward(result, "The cloud data server", "`--force`")).toThrow(
      /runs 1 commit\(s\) that this checkout lacks:\n {2}[0-9a-f]{8} edit feature\.txt/,
    );
  });

  // SHA ancestry fails here: main holds the feature's patch under a new SHA.
  it("marks the missing commits that change the app's folder, in a repository that holds several apps (APP-LIFE-276)", () => {
    const { dir, git, commit } = repo();
    execFileSync("mkdir", [join(dir, "dice"), join(dir, "platform")]);
    commit("dice/app.ts", "v1");
    git("checkout", "-q", "-b", "feature");
    commit("platform/core.ts", "new core");
    const own = commit("dice/app.ts", "v2");
    git("checkout", "-q", "main");
    const refusal = () =>
      assertNotBackward(
        compareWithDeployed(dir, at(own)),
        "dice in the cloud",
        "`starkeep install dice --cloud --force`",
        { dir: join(dir, "dice"), name: "dice" },
      );
    expect(refusal).toThrow(/edit platform\/core\.ts\n/);
    expect(refusal).toThrow(/edit dice\/app\.ts {2}\(changes dice\)/);
    expect(refusal).toThrow("1 of them change dice's folder.");
  });

  it("says when none of the missing commits change the app's folder", () => {
    const { dir, git, commit } = repo();
    execFileSync("mkdir", [join(dir, "dice"), join(dir, "platform")]);
    commit("dice/app.ts", "v1");
    git("checkout", "-q", "-b", "feature");
    const platformOnly = commit("platform/core.ts", "new core");
    git("checkout", "-q", "main");
    expect(() =>
      assertNotBackward(
        compareWithDeployed(dir, at(platformOnly)),
        "dice in the cloud",
        "`starkeep install dice --cloud --force`",
        { dir: join(dir, "dice"), name: "dice" },
      ),
    ).toThrow("None of them change dice's folder. They change other parts of this repository.");
  });

  it("passes a checkout whose branch holds the deployed patch rebased", () => {
    const { dir, git, commit } = repo();
    git("checkout", "-q", "-b", "feature");
    const feature = commit("feature.txt", "new table");
    git("checkout", "-q", "main");
    commit("main.txt", "other");
    git("cherry-pick", feature);
    expect(() => git("merge-base", "--is-ancestor", feature, "HEAD")).toThrow();
    expect(compareWithDeployed(dir, at(feature)).kind).toBe("ok");
  });

  // The clone lacks the commit until the guard fetches it; once fetched, the
  // checkout still lacks the patch, so the deploy is backward.
  it("fetches a commit it lacks once, then compares", () => {
    const upstream = repo();
    const clone = mkdtempSync(join(tmpdir(), "deploy-guard-clone-"));
    dirs.push(clone);
    execFileSync("git", ["clone", "-q", upstream.dir, clone]);
    const pushedLater = upstream.commit("later.txt", "later");
    expect(compareWithDeployed(clone, at(pushedLater)).kind).toBe("backward");
  });

  it("refuses a commit no remote holds, and names it", () => {
    const { dir } = repo();
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const result = compareWithDeployed(dir, at(missing), { fetch: false });
    expect(result).toEqual({ kind: "unknown-commit", recorded: missing });
    expect(() => assertNotBackward(result, "photos in the cloud", "`--force`")).toThrow(
      /runs commit 0123456789ab, which no remote of this checkout holds/,
    );
  });

  it("cannot compare a folder outside git", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-guard-plain-"));
    dirs.push(dir);
    expect(compareWithDeployed(dir, at("abc")).kind).toBe("outside-git");
  });
});
