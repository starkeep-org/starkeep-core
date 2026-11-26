/**
 * `starkeep update --platform` when the checkout moved: the process that
 * pulled hands the rest to a new process, which prints its own progress and
 * its own result. The first process then adds nothing, so `--json` output
 * still ends with exactly one result.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.STARKEEP_DIR = mkdtempSync(join(tmpdir(), "cli-update-continues-"));

const continued = vi.hoisted(() => ({ code: 1, calls: 0 }));

vi.mock("../src/git", async (original) => {
  let head = "a".repeat(40);
  return {
    ...(await original<typeof import("../src/git")>()),
    upstreamOf: () => "origin/main",
    trackedChanges: () => [],
    fetchUpstream: () => {},
    aheadBehind: () => ({ ahead: 0, behind: 1 }),
    headCommit: () => head,
    pullFastForward: () => {
      head = "b".repeat(40);
    },
  };
});
vi.mock("../src/commands/platform", async (original) => ({
  ...(await original<typeof import("../src/commands/platform")>()),
  // The new process printed its own failure and result before it exited.
  continueAfterPull: () => {
    continued.calls++;
    return continued.code;
  },
}));

let main: typeof import("../src/main").main;
beforeAll(async () => {
  ({ main } = await import("../src/main"));
});

async function run(argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    cwd: process.cwd(),
    interactive: false,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

describe("an update that continues in a new process", () => {
  it("exits with the new process's code and prints no second result under --json", async () => {
    continued.code = 1;
    const { code, out } = await run(["update", "--platform", "--json"]);
    expect(continued.calls).toBe(1);
    expect(code).toBe(1);
    const results = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string })
      .filter((e) => e.type === "result");
    expect(results).toEqual([]);
  });

  it("adds no message of its own to the new process's failure", async () => {
    continued.code = 3;
    const { code, err } = await run(["update", "--platform"]);
    expect(code).toBe(3);
    expect(err).not.toContain("The update stopped");
  });
});
