/**
 * Parse the arguments against the command table, run the command, and turn
 * its outcome into an exit code. `bin.ts` calls this; tests call it directly.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";
import { GLOBAL_FLAGS, LANE_TEXT, type Command, type FlagSpec } from "./command";
import { COMMANDS } from "./commands";
import { CliError, EXIT_USAGE } from "./errors";
import { createIo, type Io, type IoOptions } from "./io";

function optionsFor(flags: Record<string, FlagSpec>): ParseArgsConfig["options"] {
  const out: NonNullable<ParseArgsConfig["options"]> = {};
  for (const [name, spec] of Object.entries(flags)) {
    out[name] = {
      type: spec.type,
      ...(spec.short ? { short: spec.short } : {}),
      ...(spec.multiple ? { multiple: true } : {}),
    };
  }
  return out;
}

function flagHelp(flags: Record<string, FlagSpec>): string[] {
  return Object.entries(flags).map(([name, spec]) => {
    const left = `${spec.short ? `-${spec.short}, ` : "    "}--${name}${spec.type === "string" ? " <value>" : ""}`;
    return `  ${left.padEnd(28)}${spec.description}`;
  });
}

export function generalHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  return [
    "Usage: starkeep <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    "",
    "Every command accepts --json and --help. Run `starkeep help <command>` for one command's help.",
    "Exit codes: 0 success, 1 failure, 2 bad usage, 3 needs input a run without a terminal cannot give.",
  ].join("\n");
}

export function commandHelp(command: Command): string {
  return [
    `Usage: starkeep ${command.name}${command.usage ? ` ${command.usage}` : ""}`,
    "",
    command.summary + ".",
    ...(command.details ? ["", command.details] : []),
    "",
    `Credentials: ${LANE_TEXT[command.lane]}`,
    "",
    "Options:",
    ...flagHelp({ ...command.flags, ...GLOBAL_FLAGS }),
  ].join("\n");
}

/**
 * The command the first words name: a two-word command such as `cloud
 * status` first, then a one-word one.
 */
function findCommand(words: string[]): { command: Command } | undefined {
  const [first, second] = words;
  if (!first) return undefined;
  const two = second ? COMMANDS.find((c) => c.name === `${first} ${second}`) : undefined;
  const command = two ?? COMMANDS.find((c) => c.name === first);
  return command ? { command } : undefined;
}

/** The commands of a group such as `cloud`, or null when no group has the name. */
function groupHelp(group: string): string | null {
  const members = COMMANDS.filter((c) => c.name.startsWith(`${group} `));
  if (members.length === 0) return null;
  const width = Math.max(...members.map((c) => c.name.length)) + 2;
  return [
    `Usage: starkeep ${group} <command> [options]`,
    "",
    "Commands:",
    ...members.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    "",
    `Run \`starkeep help ${group} <command>\` for one command's help.`,
  ].join("\n");
}

export type MainOptions = Omit<IoOptions, "json" | "verbose">;

/** Run one invocation. Returns the exit code. */
export async function main(argv: string[], options: MainOptions): Promise<number> {
  const stdout = options.stdout ?? ((t: string) => void process.stdout.write(t));
  const stderr = options.stderr ?? ((t: string) => void process.stderr.write(t));
  const name = argv.find((a) => !a.startsWith("-"));
  const json = argv.includes("--json");

  if (!name || name === "help") {
    const words = argv.filter((a) => !a.startsWith("-") && a !== "help");
    const topic = name === "help" ? findCommand(words) : undefined;
    if (name === "help" && words.length > 0 && !topic) {
      const group = groupHelp(words[0]!);
      if (group) {
        stdout(`${group}\n`);
        return 0;
      }
      stderr(`Unknown command "${words.join(" ")}".\n\n${generalHelp()}\n`);
      return EXIT_USAGE;
    }
    stdout(`${topic ? commandHelp(topic.command) : generalHelp()}\n`);
    return name || argv.includes("--help") || argv.includes("-h") ? 0 : EXIT_USAGE;
  }

  const words = argv.filter((a) => !a.startsWith("-"));
  const found = findCommand(words);
  if (!found) {
    const group = groupHelp(name);
    if (group) {
      stderr(
        `${words.length > 1 ? `Unknown command "${words.slice(0, 2).join(" ")}".\n\n` : ""}${group}\n`,
      );
      return EXIT_USAGE;
    }
    stderr(`Unknown command "${name}".\n\n${generalHelp()}\n`);
    return EXIT_USAGE;
  }
  const { command } = found;

  // The arguments after the command's own words.
  const rest = [...argv];
  for (const word of command.name.split(" ")) rest.splice(rest.indexOf(word), 1);

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: optionsFor({ ...command.flags, ...GLOBAL_FLAGS }),
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    stderr(`${(err as Error).message}\n\n${commandHelp(command)}\n`);
    return EXIT_USAGE;
  }
  if (parsed.values.help) {
    stdout(`${commandHelp(command)}\n`);
    return 0;
  }

  const io: Io = createIo({ ...options, json, verbose: parsed.values.verbose === true });
  try {
    await command.run(io, {
      positionals: parsed.positionals,
      flags: parsed.values as Record<string, string | boolean | string[] | undefined>,
    });
    return 0;
  } catch (err) {
    const cli = err instanceof CliError ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      io.event({
        type: "result",
        ok: false,
        error: {
          message,
          ...(cli?.code ? { code: cli.code } : {}),
          ...(cli?.logPath ? { logPath: cli.logPath } : {}),
        },
      });
    } else {
      stderr(`\n${message}\n`);
      if (cli?.exitCode === EXIT_USAGE) stderr(`\n${commandHelp(command)}\n`);
      if (!cli && err instanceof Error && err.stack && process.env.STARKEEP_DEBUG)
        stderr(`${err.stack}\n`);
    }
    return cli?.exitCode ?? 1;
  }
}
