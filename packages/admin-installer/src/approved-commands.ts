/**
 * The commands admin-web and the cloud installer run in an app's folder: the
 * dependency install at Install, and the cloud bundle build.
 *
 * A manifest names each command in `installDependencies` and `bundle`, or
 * leaves it to be inferred from the app's lockfile. Either way the command
 * must match an approved shape before anything runs it:
 *
 * - The program is one of four package managers, matched by bare name and
 *   found on PATH. A path such as `./scripts/x` never matches.
 * - Install is `<manager> install` (or `npm ci`) with flags from a short list.
 * - Bundle is `<manager> run <script>`, with a plain script name.
 * - Nothing builds a shell string; the command spawns with an argument list.
 *
 * The list stops a manifest from naming an arbitrary program. It cannot stop
 * an approved command from running the app's own code: a package manager runs
 * the app's lifecycle scripts, and `run bundle` runs a script the app defines.
 * The user trusts that code at Start anyway, since `localRun` runs it; the
 * consent dialog says so.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A manifest's `installDependencies` or `bundle`, as the file holds it. */
export interface DeclaredCommand {
  command: string;
  args?: string[];
  cwd?: string;
}

export interface CommandSource {
  installDependencies?: DeclaredCommand;
  bundle?: DeclaredCommand;
}

export type CommandResolution =
  /** Run `command args` in `cwd`; `display` is the same as one line of text. */
  | { kind: "run"; command: string; args: string[]; cwd: string; display: string }
  /** Nothing to run: the folder holds no package.json. */
  | { kind: "skip"; reason: string }
  /** The command is not on the approved list; `display` is what the user can run by hand. */
  | { kind: "refused"; display: string; cwd: string; reason: string };

type Manager = "pnpm" | "npm" | "yarn" | "bun";

/** Each manager's install subcommands and the flags an install may carry. */
const INSTALL_SHAPES: Record<Manager, { subcommands: string[]; flags: string[] }> = {
  pnpm: { subcommands: ["install"], flags: ["--frozen-lockfile", "--ignore-workspace", "--prod"] },
  npm: { subcommands: ["ci", "install"], flags: ["--omit=dev"] },
  yarn: { subcommands: ["install"], flags: ["--immutable"] },
  bun: { subcommands: ["install"], flags: ["--frozen-lockfile", "--production"] },
};

const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;

/** Lockfile to the manager that writes it, and that manager's frozen install. */
const LOCKFILES: Array<{ file: string; manager: Manager; frozen: string[] }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm", frozen: ["install", "--frozen-lockfile"] },
  { file: "package-lock.json", manager: "npm", frozen: ["ci"] },
  { file: "yarn.lock", manager: "yarn", frozen: ["install", "--immutable"] },
  { file: "bun.lock", manager: "bun", frozen: ["install", "--frozen-lockfile"] },
];

function isManager(program: string): program is Manager {
  return Object.hasOwn(INSTALL_SHAPES, program);
}

function display(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

/**
 * The nearest pnpm workspace at or above `dir`, and whether it covers `dir`.
 * A workspace covers its own root and every folder its `packages` globs
 * match. pnpm run anywhere inside a workspace installs that workspace, so an
 * app inside one that does not cover it needs `--ignore-workspace` (#141).
 */
export function enclosingWorkspace(dir: string): { root: string; covers: boolean } | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const file = join(d, "pnpm-workspace.yaml");
    if (existsSync(file)) {
      const rel = relative(d, resolve(dir)).split(sep).join("/");
      return {
        root: d,
        covers: rel === "" || workspaceGlobsMatch(readFileSync(file, "utf-8"), rel),
      };
    }
    if (dirname(d) === d) return null;
  }
}

/** The `packages` globs of a pnpm-workspace.yaml, matched against a relative path. */
function workspaceGlobsMatch(yaml: string, rel: string): boolean {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = line.match(/^\s+-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (item) globs.push(item[1]!.trim());
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  const toRegex = (glob: string) =>
    new RegExp(
      "^" +
        glob
          .replace(/\/$/, "")
          .split("**")
          .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join(".*") +
        "$",
    );
  let matched = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (toRegex(glob.slice(1)).test(rel)) return false;
    } else if (toRegex(glob).test(rel)) {
      matched = true;
    }
  }
  return matched;
}

/** `cwd` from a manifest, which must stay inside the app's folder. */
function declaredCwd(appDir: string, cwd: string | undefined): string | null {
  const dir = resolve(appDir, cwd ?? ".");
  const rel = relative(appDir, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? dir : null;
}

/**
 * The approved dependency install for the app in `appDir`, or why there is
 * none. A pnpm install inside a workspace that does not cover the app gains
 * `--ignore-workspace`. Without a declared command:
 *
 * - a folder with no package.json installs nothing;
 * - a lockfile beside package.json picks its manager's frozen install;
 * - an app a pnpm workspace covers installs at the workspace root;
 * - anything else runs `pnpm install`.
 */
export function resolveInstallCommand(appDir: string, manifest: CommandSource): CommandResolution {
  const declared = manifest.installDependencies;
  if (declared) {
    const args = declared.args ?? [];
    const cwd = declaredCwd(appDir, declared.cwd);
    const shown = display(declared.command, args);
    const refuse = (reason: string): CommandResolution => ({
      kind: "refused",
      display: shown,
      cwd: cwd ?? resolve(appDir, declared.cwd ?? "."),
      reason,
    });
    if (!cwd) return refuse("Its folder is outside the app's folder.");
    if (!isManager(declared.command)) {
      return refuse(`${declared.command} is not an approved package manager.`);
    }
    const shape = INSTALL_SHAPES[declared.command];
    const [subcommand, ...flags] = args;
    if (!subcommand || !shape.subcommands.includes(subcommand)) {
      return refuse(`${display(declared.command, args.slice(0, 1))} is not an approved install.`);
    }
    const unknown = flags.find((f) => !shape.flags.includes(f));
    if (unknown !== undefined) return refuse(`${unknown} is not an approved flag.`);
    return run(declared.command, args, cwd);
  }

  if (!existsSync(join(appDir, "package.json"))) {
    return { kind: "skip", reason: "The app's folder has no package.json." };
  }
  const own = LOCKFILES.find((l) => existsSync(join(appDir, l.file)));
  if (own) return run(own.manager, own.frozen, appDir);
  const ws = enclosingWorkspace(appDir);
  if (ws?.covers) {
    const frozen = existsSync(join(ws.root, "pnpm-lock.yaml")) ? ["--frozen-lockfile"] : [];
    return run("pnpm", ["install", ...frozen], ws.root);
  }
  return run("pnpm", ["install"], appDir);
}

/** Add `--ignore-workspace` where pnpm would otherwise install an enclosing workspace. */
function run(command: Manager, args: string[], cwd: string): CommandResolution {
  const ws = command === "pnpm" ? enclosingWorkspace(cwd) : null;
  const full =
    ws && !ws.covers && !args.includes("--ignore-workspace")
      ? [...args, "--ignore-workspace"]
      : args;
  return { kind: "run", command, args: full, cwd, display: display(command, full) };
}

/**
 * The approved cloud bundle build for the app in `appDir`: the manifest's
 * `bundle`, or `<manager> run bundle` with the manager its lockfile names
 * (pnpm when it names none).
 */
export function resolveBundleCommand(appDir: string, manifest: CommandSource): CommandResolution {
  const declared = manifest.bundle;
  if (declared) {
    const args = declared.args ?? [];
    const cwd = declaredCwd(appDir, declared.cwd);
    const refuse = (reason: string): CommandResolution => ({
      kind: "refused",
      display: display(declared.command, args),
      cwd: cwd ?? resolve(appDir, declared.cwd ?? "."),
      reason,
    });
    if (!cwd) return refuse("Its folder is outside the app's folder.");
    if (!isManager(declared.command)) {
      return refuse(`${declared.command} is not an approved package manager.`);
    }
    if (args.length !== 2 || args[0] !== "run" || !SCRIPT_NAME.test(args[1]!)) {
      return refuse(`A bundle command must be \`${declared.command} run <script>\`.`);
    }
    return {
      kind: "run",
      command: declared.command,
      args,
      cwd,
      display: display(declared.command, args),
    };
  }
  const own = LOCKFILES.find((l) => existsSync(join(appDir, l.file)));
  const manager = own?.manager ?? "pnpm";
  const args = ["run", "bundle"];
  return { kind: "run", command: manager, args, cwd: appDir, display: display(manager, args) };
}
