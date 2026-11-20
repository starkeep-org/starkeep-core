/**
 * The runner: the event lines, the exit codes, the credential failures it
 * recognizes, and the environment it leaves the operation.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeEventLine,
  exitCodeFor,
  parseEventLine,
  toOperationError,
  OperationError,
  type OperationEvent,
} from "../../src/operations/index.js";
import { processAdminLane } from "../../src/operations/admin-lane.js";
import { runOperation } from "../../src/operations/run.js";
import { INSTALLED_CONFIG, starkeepDirWith } from "./helpers.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("event lines", () => {
  it("round-trips every event through a line", () => {
    const events: OperationEvent[] = [
      { type: "progress", message: "Installing…\n  two lines" },
      { type: "log", line: "pulumi: up" },
      { type: "prompt-needed", reason: "consent", detail: "May read photos" },
      { type: "result", ok: false, error: { message: "no", code: "NOT_SIGNED_IN" } },
    ];
    for (const e of events) {
      const line = encodeEventLine(e);
      expect(line.includes("\n")).toBe(false);
      expect(parseEventLine(line)).toEqual(e);
    }
  });

  it("reads a line without the prefix, or with a broken event, as a log line", () => {
    expect(parseEventLine("Updating (sktest):")).toEqual({
      type: "log",
      line: "Updating (sktest):",
    });
    const broken = '@@starkeep-event {"type":"result"}';
    expect(parseEventLine(broken)).toEqual({ type: "log", line: broken });
    expect(parseEventLine("@@starkeep-event not json")).toEqual({
      type: "log",
      line: "@@starkeep-event not json",
    });
  });
});

describe("errors", () => {
  it("maps codes to exit codes", () => {
    expect(exitCodeFor("INVALID_INPUT")).toBe(2);
    expect(exitCodeFor("NOT_SIGNED_IN")).toBe(3);
    expect(exitCodeFor("NOT_CONFIRMED")).toBe(3);
    expect(exitCodeFor("CREDENTIALS_EXPIRED")).toBe(1);
    expect(exitCodeFor("INSTALL_FAILED")).toBe(1);
  });

  it("sorts an expired token or a refused DSQL connection into CREDENTIALS_EXPIRED", () => {
    expect(toOperationError(new Error("ExpiredTokenException: The security token")).code).toBe(
      "CREDENTIALS_EXPIRED",
    );
    expect(toOperationError(new Error("unable to accept connection, access denied")).code).toBe(
      "CREDENTIALS_EXPIRED",
    );
    expect(toOperationError(new Error("stack update failed")).code).toBe("INSTALL_FAILED");
    expect(
      toOperationError(new Error("stack update failed"), { sawCredentialFailure: true }).code,
    ).toBe("CREDENTIALS_EXPIRED");
  });
});

describe("runOperation", () => {
  const lane = async () => ({ accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" });

  it("refuses an unknown operation and an input that is not an object", async () => {
    const opts = { starkeepDir: starkeepDirWith(null), emit: () => {}, adminLane: lane };
    expect(await runOperation("make-coffee", {}, opts)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await runOperation("install-drive", [], opts)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("returns the operation's typed error", async () => {
    const outcome = await runOperation(
      "install-drive",
      {},
      {
        starkeepDir: starkeepDirWith(null),
        emit: () => {},
        adminLane: lane,
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "CONFIG_INCOMPLETE" } });
  });

  it("turns a failure after a credential error in the run's output into CREDENTIALS_EXPIRED", async () => {
    const logs: OperationEvent[] = [];
    const outcome = await runOperation(
      "install-drive",
      {},
      {
        starkeepDir: starkeepDirWith(INSTALLED_CONFIG),
        emit: (e) => void logs.push(e),
        adminLane: lane,
        overrides: {
          installDrive: async () => {
            // What Pulumi does: print the AWS error, then throw a summary.
            process.stdout.write(
              "error: ExpiredToken: The security token included in the request is expired\n",
            );
            throw new Error("update failed");
          },
        },
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "CREDENTIALS_EXPIRED" } });
    // The stack of the original failure goes to the log.
    expect(logs.some((e) => e.type === "log" && e.line.includes("update failed"))).toBe(true);
  });

  it("succeeds with the operation's result", async () => {
    const outcome = await runOperation(
      "install-drive",
      {},
      {
        starkeepDir: starkeepDirWith(INSTALLED_CONFIG),
        emit: () => {},
        adminLane: lane,
        overrides: { installDrive: async () => {} },
      },
    );
    expect(outcome).toEqual({ ok: true, data: { installed: true } });
  });
});

describe("the admin lane", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("leaves the process only the given credentials and the region", async () => {
    process.env.AWS_PROFILE = "owner";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::1:role/x";
    process.env.AWS_ACCESS_KEY_ID = "A";
    process.env.AWS_SECRET_ACCESS_KEY = "S";
    process.env.AWS_SESSION_TOKEN = "T";
    delete process.env.AWS_REGION;
    await processAdminLane({ environmentOnly: true })("us-east-2");
    const aws = Object.keys(process.env)
      .filter((k) => k.startsWith("AWS_"))
      .sort();
    expect(aws).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_REGION",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]);
    expect(process.env.AWS_REGION).toBe("us-east-2");
  });

  it("reports NOT_SIGNED_IN for an environment-only run with no credentials", async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("AWS_")) delete process.env[k];
    await expect(processAdminLane({ environmentOnly: true })("us-east-1")).rejects.toBeInstanceOf(
      OperationError,
    );
  });
});

/** Run the real entry point, as admin-web and the CLI start it. */
function runScript(
  args: string[],
  starkeepDir: string,
): Promise<{ code: number | null; lines: string[] }> {
  const child = spawn("npx", ["tsx", "scripts/run-operation.ts", ...args], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, STARKEEP_DIR: starkeepDir, STARKEEP_ENV_DIR: starkeepDir },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  return new Promise((done) =>
    child.on("close", (code) => done({ code, lines: out.split("\n").filter(Boolean) })),
  );
}

describe("scripts/run-operation.ts", () => {
  it("ends with a result line and the exit code the error names", async () => {
    const dir = starkeepDirWith(null);
    const missing = await runScript(["install-drive", "{}"], dir);
    expect(missing.code).toBe(1);
    expect(parseEventLine(missing.lines.at(-1)!)).toMatchObject({
      type: "result",
      ok: false,
      error: { code: "CONFIG_INCOMPLETE" },
    });

    const unknown = await runScript(["make-coffee", "{}"], dir);
    expect(unknown.code).toBe(2);
    const badJson = await runScript(["install-drive", "{nope"], dir);
    expect(badJson.code).toBe(2);
    expect(parseEventLine(badJson.lines.at(-1)!)).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  }, 60_000);
});
