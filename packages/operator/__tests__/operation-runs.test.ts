/**
 * Operation runs on the shared slots: the event lines a follower reads, and a
 * second start on a busy slot.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEventLine, type OperationEvent } from "../src/events";

const dataDir = mkdtempSync(join(tmpdir(), "operator-operation-runs-"));
process.env.STARKEEP_DIR = dataDir;

const { startRun, runStatus } = await import("../src/runs");
const { followOperation, operationCommand, runOperationInSlot, SlotBusyError } =
  await import("../src/operation-runs");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** A run that prints `lines`, one per line, then sleeps `ms` and exits `code`. */
function fakeRun(slot: string, lines: string[], code = 0, ms = 0, owner?: string) {
  const script = `for (const l of JSON.parse(process.argv[1])) console.log(l); setTimeout(() => process.exit(${code}), ${ms});`;
  startRun(slot, process.execPath, ["-e", script, JSON.stringify(lines)], {
    cwd: dataDir,
    env: process.env,
    ...(owner ? { owner } : {}),
  });
}

describe("operationCommand", () => {
  it("runs the named operation with its input as one argument", () => {
    expect(operationCommand("install-drive", { a: 1 })).toEqual({
      command: "pnpm",
      args: [
        "--filter",
        "@starkeep/admin-installer",
        "--silent",
        "run-operation",
        "install-drive",
        '{"a":1}',
      ],
    });
  });
});

describe("followOperation", () => {
  it("hands over every event but the result, and returns the result", async () => {
    fakeRun("drive", [
      encodeEventLine({ type: "progress", message: "Installing Drive…" }),
      "pulumi: up",
      encodeEventLine({ type: "result", ok: true, data: { installed: true } }),
    ]);
    const seen: OperationEvent[] = [];
    const { result, code } = await followOperation("drive", 0, (e) => seen.push(e));
    expect(seen).toEqual([
      { type: "progress", message: "Installing Drive…" },
      { type: "log", line: "pulumi: up" },
    ]);
    expect(result).toEqual({ type: "result", ok: true, data: { installed: true } });
    expect(code).toBe(0);
  });

  it("stands in a failed result for a run that ended without one", async () => {
    fakeRun("drive", ["Killed"], 137);
    const { result } = await followOperation("drive", 0, () => {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("without a result");
  });
});

describe("runOperationInSlot", () => {
  it("refuses a slot that runs something else", async () => {
    fakeRun("app", [], 0, 2_000, "photos (web)");
    await expect(
      runOperationInSlot({
        name: "install-cloud-app",
        input: { appId: "dice" },
        owner: "dice (web)",
        env: process.env,
        onEvent: () => {},
      }),
    ).rejects.toBeInstanceOf(SlotBusyError);
  });

  it("follows a run that does the same thing instead of starting a second", async () => {
    fakeRun(
      "cloud-data-server",
      [encodeEventLine({ type: "result", ok: true })],
      0,
      500,
      "cloud data server install",
    );
    const before = runStatus("cloud-data-server");
    const outcome = await runOperationInSlot({
      name: "install-cloud-data-server",
      input: {},
      owner: "cloud data server install",
      env: process.env,
      onEvent: () => {},
    });
    expect(outcome.followed).toBe(true);
    expect(outcome.result.ok).toBe(true);
    // The same run, not a second one.
    const after = runStatus("cloud-data-server");
    expect(before.state).toBe("running");
    expect(after.state).toBe("ended");
    expect((after as { runId: string }).runId).toBe((before as { runId: string }).runId);
  });
});
