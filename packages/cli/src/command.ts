/**
 * The shape every command declares: its flags, its credential lane, its help
 * text and its body. `bin.ts` parses arguments against the declaration, so no
 * command parses `process.argv` itself.
 */
import type { Io } from "./io";

/**
 * Whose credentials a command uses. `none` touches only this computer.
 * `admin` uses the signed-in Starkeep admin's session. `owner` uses the
 * terminal's AWS credentials, which only the bootstrap stack needs.
 */
export type Lane = "none" | "admin" | "owner";

export interface FlagSpec {
  type: "boolean" | "string";
  short?: string;
  multiple?: boolean;
  description: string;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
}

export interface Command {
  /** One word, or a noun and a verb such as `source add`. */
  name: string;
  /** One line for the command list. */
  summary: string;
  /** The arguments after the name, such as `<app>... --local`. */
  usage: string;
  lane: Lane;
  flags: Record<string, FlagSpec>;
  /** More help, printed by `starkeep help <command>`. */
  details?: string;
  run(io: Io, args: ParsedArgs): Promise<void>;
}

/** Flags every command accepts. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: "boolean", description: "Print one JSON event per line and a final result." },
  verbose: {
    type: "boolean",
    short: "v",
    description: "Print the output of the steps a command runs.",
  },
  help: { type: "boolean", short: "h", description: "Print this command's help." },
};

export const LANE_TEXT: Record<Lane, string> = {
  none: "This computer only. Needs no cloud credentials.",
  admin: "Signs in as the Starkeep admin (starkeep login --admin).",
  owner: "Uses this terminal's AWS credentials, for the bootstrap stack only.",
};

export function flag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}
