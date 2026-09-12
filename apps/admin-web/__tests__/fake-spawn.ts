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
 * The registry is module state, shared between the `vi.mock` factory and the
 * spec that reads it, because both resolve this same module.
 */
import { EventEmitter } from "node:events";

export interface FakeChild extends EventEmitter {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown };
  stdout: EventEmitter;
  stderr: EventEmitter;
  /** Feed bytes to the route exactly as they arrived — partial lines included. */
  say(chunk: string): void;
  sayErr(chunk: string): void;
  /** The child exits. */
  exit(code: number | null): void;
  /** The spawn itself failed — the binary is missing, say. */
  fail(message: string): void;
}

const spawned: FakeChild[] = [];

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
  child.command = command;
  child.args = args;
  child.options = options;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.say = (chunk) => child.stdout.emit("data", Buffer.from(chunk, "utf-8"));
  child.sayErr = (chunk) => child.stderr.emit("data", Buffer.from(chunk, "utf-8"));
  child.exit = (code) => child.emit("close", code);
  child.fail = (message) => child.emit("error", new Error(message));
  spawned.push(child);
  return child;
}
