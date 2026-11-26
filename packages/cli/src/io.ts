/**
 * Everything a command says or asks, in one place, so `--json` and a run
 * without a terminal behave the same way in every command.
 *
 * In a terminal, a command prints progress and a short summary. Under
 * `--json`, the CLI prints one event per line and ends with one result object,
 * the shape `@starkeep/operator/events` defines. Progress then never reaches
 * standard output as plain text.
 */
import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ReadStream, WriteStream } from "node:tty";
import { starkeepDir } from "@starkeep/app-client";
import type { OperationEvent } from "@starkeep/operator/events";
import { CliError, EXIT_NEEDS_INPUT } from "./errors";

export interface Io {
  /** True under `--json`. */
  readonly json: boolean;
  /** The folder the person ran the command in. */
  readonly cwd: string;
  /** A line of the human summary. Dropped under `--json`. */
  print(line?: string): void;
  /** A progress line or other event. Under `--json`, one JSON line. */
  event(event: OperationEvent): void;
  /** A warning, always on standard error. */
  warn(line: string): void;
  /** Whether a person can answer a question. */
  interactive(): boolean;
  /**
   * Ask a yes-or-no question. `--yes` answers yes. Without a terminal and
   * without `--yes`, the command stops with exit code 3.
   */
  confirm(question: string, options: { yes: boolean; flagHint?: string }): Promise<boolean>;
  /** Ask for text, such as an app id typed back. Without a terminal, exit code 3. */
  ask(question: string, options: { flagHint: string }): Promise<string>;
}

/**
 * The person's terminal, even when standard input is something else, as it is
 * under `curl … | sh`. Null when no terminal exists.
 */
function openTty(): { input: ReadStream; output: WriteStream } | null {
  if (process.stdin.isTTY && process.stdout.isTTY) return null; // use the standard streams
  try {
    const inFd = openSync("/dev/tty", "r");
    const outFd = openSync("/dev/tty", "w");
    return { input: new ReadStream(inFd), output: new WriteStream(outFd) };
  } catch {
    return null;
  }
}

export interface IoOptions {
  json: boolean;
  /** Print `log` events, such as a dependency install's output, in a terminal. */
  verbose?: boolean;
  cwd: string;
  /** For tests: whether to treat the run as having a terminal. */
  interactive?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** For tests: the answers a person would type, in order. */
  answers?: string[];
}

export function createIo(options: IoOptions): Io {
  const stdout = options.stdout ?? ((t: string) => void process.stdout.write(t));
  const stderr = options.stderr ?? ((t: string) => void process.stderr.write(t));
  const answers = options.answers ? [...options.answers] : null;

  const hasTerminal = (): boolean => {
    if (options.interactive !== undefined) return options.interactive;
    if (process.stdin.isTTY) return true;
    const tty = openTty();
    if (!tty) return false;
    tty.input.destroy();
    tty.output.destroy();
    return true;
  };

  async function question(text: string): Promise<string> {
    if (answers) {
      stderr(text);
      const answer = answers.shift() ?? "";
      stderr(`${answer}\n`);
      return answer;
    }
    const tty = process.stdin.isTTY ? null : openTty();
    const rl = createInterface({
      input: tty?.input ?? process.stdin,
      // Questions go to standard error, so they never mix into `--json` output.
      output: tty?.output ?? process.stderr,
    });
    try {
      return await rl.question(text);
    } finally {
      rl.close();
      tty?.input.destroy();
      tty?.output.destroy();
    }
  }

  return {
    json: options.json,
    cwd: options.cwd,
    print(line = "") {
      if (!options.json) stdout(`${line}\n`);
    },
    event(event) {
      if (options.json) {
        stdout(`${JSON.stringify(event)}\n`);
        return;
      }
      if (event.type === "progress") stdout(`${event.message}\n`);
      else if (event.type === "log") {
        if (options.verbose) stdout(`  ${event.line}\n`);
      } else if (event.type === "prompt-needed") stderr(`${event.detail}\n`);
    },
    warn(line) {
      stderr(`${line}\n`);
    },
    interactive: hasTerminal,
    async confirm(text, { yes, flagHint = "--yes" }) {
      if (yes) return true;
      if (!hasTerminal()) {
        throw new CliError(
          `${text.trim()} No terminal is attached to answer. Pass ${flagHint} to approve.`,
          EXIT_NEEDS_INPUT,
          "NEEDS_INPUT",
        );
      }
      const answer = await question(`${text.trim()} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    },
    async ask(text, { flagHint }) {
      if (!hasTerminal()) {
        throw new CliError(
          `${text.trim()} No terminal is attached to answer. Pass ${flagHint}.`,
          EXIT_NEEDS_INPUT,
          "NEEDS_INPUT",
        );
      }
      return (await question(`${text.trim()} `)).trim();
    },
  };
}

/**
 * Stop with exit status 3 when no person can answer the command's questions,
 * before the command changes anything.
 */
export function requireTerminal(io: Io, question: string, flagHint: string): void {
  if (!io.interactive()) {
    throw new CliError(
      `${question} No terminal is attached to answer. Pass ${flagHint}.`,
      EXIT_NEEDS_INPUT,
      "NEEDS_INPUT",
    );
  }
}

/**
 * A log file under `~/.starkeep/logs/` for one long operation. The error
 * summary names it, so a person can read the whole story after a failure.
 */
export function openOperationLog(name: string): { path: string; write: (line: string) => void } {
  const dir = join(starkeepDir(), "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${name}-${stamp}.log`);
  closeSync(openSync(path, "a", 0o600));
  return {
    path,
    write: (line) => appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`),
  };
}
