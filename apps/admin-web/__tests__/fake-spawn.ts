/**
 * A stand-in for `node:child_process`'s `spawn`, for the four routes that
 * stream an installer's output to the browser.
 *
 * Real spawning is not an option here. `/api/exec/stream`'s own command list
 * names `scripts/reset-local-data.sh`, which deletes the operator's object
 * files, SQLite database and watch configs; the three install routes run Pulumi
 * against an AWS account. What those routes are worth testing is everything
 * above the child — the line framing, the terminal events, the credential
 * plumbing and the reattach path — and a fake child is what makes the child's
 * behavior an input to the test rather than a thing to wait for.
 *
 * The install routes run their installer detached, through an `sh` wrapper
 * that appends the installer's output to a log file and records its exit code
 * in another (see `src/lib/detached-run.ts`). For such a spawn the fake reports
 * the wrapped installer's command and arguments, `say` appends to the log, and
 * `exit` records the code, which is all the routes ever read.
 *
 * The registry is module state, shared between the `vi.mock` factory and the
 * spec that reads it, because both resolve this same module.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";

export interface FakeChild extends EventEmitter {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; detached?: boolean };
  /** A live process id, so a detached run reads as running until it exits. */
  pid: number;
  unref(): void;
  stdout: EventEmitter;
  stderr: EventEmitter;
  /** Feed bytes to the route exactly as they arrived — partial lines included. */
  say(chunk: string): void;
  sayErr(chunk: string): void;
  /** The child exits. A null code is a process killed before it recorded one. */
  exit(code: number | null): void;
  /** The spawn itself failed — the binary is missing, say. */
  fail(message: string): void;
}

// On `globalThis`, so a spec that reloads a route with `vi.resetModules()` to
// play a restarted admin-web still sees the reloaded route's spawns here.
const registry = globalThis as { __fakeSpawned?: FakeChild[] };
const spawned: FakeChild[] = (registry.__fakeSpawned ??= []);

/** Every child spawned since the last reset, in order. */
export function spawnedChildren(): FakeChild[] {
  return spawned;
}

/** The most recent child, or a clear failure if nothing spawned. */
export function lastChild(): FakeChild {
  const child = spawned.at(-1);
  if (!child) throw new Error("no child was spawned");
  return child;
}

export function resetSpawns(): void {
  spawned.length = 0;
}

export function fakeSpawn(
  command: string,
  args: string[],
  options: FakeChild["options"] = {},
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  // The detached wrapper: sh -c <script> sh <log> <exit> <command> <args...>
  const wrapped = command === "/bin/sh" && args[0] === "-c";
  const logPath = wrapped ? args[3]! : null;
  const exitPath = wrapped ? args[4]! : null;
  child.command = wrapped ? args[5]! : command;
  child.args = wrapped ? args.slice(6) : args;
  child.options = options;
  child.pid = process.pid;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let exited = false;
  const write = (stream: EventEmitter, chunk: string) => {
    if (logPath) appendFileSync(logPath, chunk);
    else stream.emit("data", Buffer.from(chunk, "utf-8"));
  };
  child.say = (chunk) => write(child.stdout, chunk);
  child.sayErr = (chunk) => write(child.stderr, chunk);
  child.exit = (code) => {
    if (exited) return;
    exited = true;
    // What the wrapper leaves when the installer ends, or when something
    // killed the wrapper first: no code a reader can parse.
    if (exitPath) writeFileSync(exitPath, code === null ? "killed" : String(code));
    child.emit("close", code);
  };
  child.fail = (message) => {
    exited = true;
    if (exitPath) writeFileSync(exitPath, "killed");
    child.emit("error", new Error(message));
  };
  spawned.push(child);
  return child;
}
