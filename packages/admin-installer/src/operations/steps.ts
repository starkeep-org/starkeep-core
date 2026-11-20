/**
 * Running a command an operation needs, such as the cloud data server's
 * build or an app's bundle command, with its output as `log` events.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Emit } from "./events";

export interface CommandSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs a command to its end and resolves with its exit code, or null when it could not start. */
export type RunCommand = (spec: CommandSpec, emit: Emit) => Promise<number | null>;

export const runCommand: RunCommand = (spec, emit) =>
  new Promise((done) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const carry = { out: "", err: "" };
    const onData = (which: "out" | "err") => (chunk: Buffer) => {
      const text = carry[which] + chunk.toString("utf8");
      const lines = text.split("\n");
      carry[which] = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) emit({ type: "log", line });
    };
    child.stdout.on("data", onData("out"));
    child.stderr.on("data", onData("err"));
    child.on("error", (err) => {
      emit({ type: "log", line: `Could not run ${spec.command}: ${err.message}` });
      done(null);
    });
    child.on("close", (code) => {
      for (const rest of [carry.out, carry.err]) if (rest.trim()) emit({ type: "log", line: rest });
      done(code);
    });
  });

/** The starkeep-core checkout this package lives in. */
export function workspaceRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}
