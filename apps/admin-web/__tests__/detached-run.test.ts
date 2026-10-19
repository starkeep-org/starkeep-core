/**
 * The detached runner with a real `sh` wrapper and a real child: the part the
 * install routes' tests fake. The child is `node -e`, so nothing here reaches
 * AWS or the operator's data.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "adminweb-detached-run-"));
process.env.STARKEEP_DIR = dataDir;

const { followRun, runLogPath, runStatus, startRun } = await import("../src/lib/detached-run");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Follow a run to its end, collecting what the follower saw. */
function followToEnd(
  key: string,
  from: number | "end" = 0,
): Promise<{ lines: string[]; offsets: number[]; code: number | null }> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const offsets: number[] = [];
    followRun(key, {
      from,
      onLine: (line, offset) => {
        seen.push(line);
        offsets.push(offset);
      },
      onEnd: (code) => resolve({ lines: seen, offsets, code }),
    });
  });
}

const run = (key: string, script: string, ...args: string[]) =>
  startRun(key, process.execPath, ["-e", script, ...args], { cwd: dataDir, env: process.env });

describe("a detached run", () => {
  it("records the installer's output, stdout and stderr together, and its exit code", async () => {
    run("basic", "console.log('one'); console.error('two'); process.stdout.write('three'); process.exit(3)");
    const { lines, code } = await followToEnd("basic");
    expect(lines).toEqual(["one", "two", "three"]);
    expect(code).toBe(3);
    expect(runStatus("basic")).toMatchObject({ state: "ended", code: 3 });
  });

  it("passes arguments to the installer as words the shell never parses", async () => {
    const marker = join(dataDir, "pwned");
    run("quoting", "console.log(process.argv[1])", `$(touch ${marker}); echo "quoted"`);
    const { lines, code } = await followToEnd("quoting");
    expect(code).toBe(0);
    expect(lines).toEqual([`$(touch ${marker}); echo "quoted"`]);
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps the log the owner's alone", async () => {
    run("mode", "console.log('x')");
    await followToEnd("mode");
    expect(statSync(runLogPath("mode")).mode & 0o777).toBe(0o600);
  });

  it("keeps running when its follower stops, and a later follower sees how it ended", async () => {
    run("outlives", "setTimeout(() => { console.log('late'); process.exit(0); }, 400)");
    const stop = followRun("outlives", { from: 0, onLine: () => {}, onEnd: () => {} });
    stop();
    expect(runStatus("outlives").state).toBe("running");

    const { lines, code } = await followToEnd("outlives");
    expect(code).toBe(0);
    expect(lines).toEqual(["late"]);
  });

  it("reads a run whose process died without recording an exit code as ended with none", async () => {
    const child = run("killed", "setTimeout(() => {}, 60_000)");
    await new Promise((r) => setTimeout(r, 200));
    process.kill(-child.pid!, "SIGKILL");
    const { code } = await followToEnd("killed");
    expect(code).toBeNull();
  });

  it("reports each line's end offset, from which a later follower picks up the next line", async () => {
    // "é" is two bytes, so a character count would put the resume point mid-line.
    run("offsets", "console.log('été'); console.log(''); console.log('two'); console.log('three')");
    const all = await followToEnd("offsets");
    expect(all.lines).toEqual(["été", "two", "three"]);
    expect(all.offsets).toEqual([6, 11, 17]);

    const resumed = await followToEnd("offsets", all.offsets[0]);
    expect(resumed.lines).toEqual(["two", "three"]);
  });

  it("gives each run its own id", async () => {
    run("ids", "console.log('a')");
    await followToEnd("ids");
    const first = runStatus("ids");
    run("ids", "console.log('b')");
    await followToEnd("ids");
    const second = runStatus("ids");
    expect(first.state === "ended" && first.runId).toMatch(/^[0-9a-f]{16}$/);
    expect(second.state === "ended" && second.runId).not.toBe(first.state === "ended" && first.runId);
  });

  it("reports no run for a slot that never had one", () => {
    expect(runStatus("never")).toEqual({ state: "none" });
  });
});
